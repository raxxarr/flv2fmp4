/* eslint-disable */
import flvDemux from './flvdemux';
import mediainfo from './media-info';
import SPSParser from './sps-parser';
class tagDemux {
    constructor() {
        this.TAG = this.constructor.name;

        this._config = {};

        this._onError = null;

        /**
         * script tag、音频 AudioSpecificConfig、视频 AVCDecoderConfigurationRecord
         * 都解析完成后，触发 _onMediaInfo
         * 
         * 对初始化信息进行 remux，生成 initSegment，开始送入 sourceBuffer
         */
        this._onMediaInfo = null;

        this._onTrackMetadata = null;

        /**
         * 初始化之后，每一批 tags（大小取决于当前读取的文件 chunk）解析完都会触发
         * 带着本次解析的 videoTrack 和 audioTrack 上的 samples
         * 如每次 200 帧音频，120 帧视频，没一帧上有 dts cts pts
         */
        this._onDataAvailable = null;

        this._dataOffset = 0;
        this._firstParse = true;
        this._dispatch = false;

        this._hasAudio = false;
        this._hasVideo = false;

        this._audioInitialMetadataDispatched = false;
        this._videoInitialMetadataDispatched = false;

        /**
         * 通过解 script data tag 取得
         * 
         * 同时通过解音视频相关 tag 得出其他一些信息：
         * 解 AVCDecoderConfigurationRecord 取得 width / height / videoCodec / fps 等
         */
        this._mediaInfo = new mediainfo();
        this._mediaInfo.hasAudio = this._hasAudio;
        this._mediaInfo.hasVideo = this._hasVideo;
        this._metadata = null;
        this._audioMetadata = null;

        /**
         * 通过解 AVCVideoPackage 类型为 0 的 package 即 AVCDecoderConfigurationRecord 取得
         * 主要是 sps
         * (pps 没用?)
         */
        this._videoMetadata = null;

        this._naluLengthSize = 4;
        this._timestampBase = 0; // int32, in milliseconds
        // TODO: why 1000？
        this._timescale = 1000;
        this._duration = 0; // int32, in milliseconds
        this._durationOverrided = false;
        this._referenceFrameRate = {
            fixed: true,
            fps: 23.976,
            fps_num: 23976,
            fps_den: 1000
        };

        /**
         * flv 只支持单 track 吧？
         */
        this._videoTrack = { type: 'video', id: 1, sequenceNumber: 0, addcoefficient: 2, samples: [], length: 0 };
        this._audioTrack = { type: 'audio', id: 2, sequenceNumber: 1, addcoefficient: 2, samples: [], length: 0 };

        this._littleEndian = (function() {
            const buf = new ArrayBuffer(2);
            (new DataView(buf)).setInt16(0, 256, true); // little-endian write
            return (new Int16Array(buf))[0] === 256; // platform-spec read, if equal then LE
        })();
    }
    set hasAudio(s){
        this._mediaInfo.hasAudio = this._hasAudio=s;
    }
    set hasVideo(s){
        this._mediaInfo.hasVideo = this._hasVideo=s;
    }
    onMediaInfo(callback) {
        this._onMediaInfo = callback;
    }
    parseMetadata(arr) {
        /**
         * flvDemux 的作用是按字节解析 flv 封装数据
         */
        /**
         * flvDemux.parseMetadata 解析 scriptData 内容
         * 解出来就是 metaData
         */
        const data = flvDemux.parseMetadata(arr);

        /**
         * 把解析的 metaData 放到 _mediaInfo 上
         */
        this._parseScriptData(data);
        console.log(this._mediaInfo, this._mediaInfo.isComplete());
    }
    _parseScriptData(obj) {
        const scriptData = obj;

        if (scriptData.hasOwnProperty('onMetaData')) {
            if (this._metadata) {
                console.log(this.TAG, 'Found another onMetaData tag!');
            }
            this._metadata = scriptData;
            const onMetaData = this._metadata.onMetaData;

            /**
             * onMetaData 就是从 script tag 解出来的各种元数据
             */
            if (typeof onMetaData.hasAudio === 'boolean') { // hasAudio
                this._hasAudio = onMetaData.hasAudio;
                this._mediaInfo.hasAudio = this._hasAudio;
            }
            if (typeof onMetaData.hasVideo === 'boolean') { // hasVideo
                this._hasVideo = onMetaData.hasVideo;
                this._mediaInfo.hasVideo = this._hasVideo;
            }
            if (typeof onMetaData.audiodatarate === 'number') { // audiodatarate
                this._mediaInfo.audioDataRate = onMetaData.audiodatarate;
            }
            if (typeof onMetaData.videodatarate === 'number') { // videodatarate
                this._mediaInfo.videoDataRate = onMetaData.videodatarate;
            }
            if (typeof onMetaData.width === 'number') { // width
                this._mediaInfo.width = onMetaData.width;
            }
            if (typeof onMetaData.height === 'number') { // height
                this._mediaInfo.height = onMetaData.height;
            }
            if (typeof onMetaData.duration === 'number') { // duration
                if (!this._durationOverrided) {
                    const duration = Math.floor(onMetaData.duration * this._timescale);
                    this._duration = duration;
                    this._mediaInfo.duration = duration;
                }
            } else {
                this._mediaInfo.duration = 0;
            }
            if (typeof onMetaData.framerate === 'number') { // framerate
                const fps_num = Math.floor(onMetaData.framerate * 1000);
                if (fps_num > 0) {
                    const fps = fps_num / 1000;
                    this._referenceFrameRate.fixed = true;
                    this._referenceFrameRate.fps = fps;
                    this._referenceFrameRate.fps_num = fps_num;
                    this._referenceFrameRate.fps_den = 1000;
                    this._mediaInfo.fps = fps;
                }
            }
            if (typeof onMetaData.keyframes === 'object') { // keyframes
                this._mediaInfo.hasKeyframesIndex = true;
                const keyframes = onMetaData.keyframes;
                /**
                 * times: [0, 0, 10, 20, 30, 40, 41.4]
                 * maybe 关键帧出现的时间
                 * 
                 * filepositions:  [794, 859, 393677, 869269, 1366083, 1889745, 1994696]
                 * maybe 关键帧出现在文件中的字节 offset（该文件filesize: 1994716，可以对上）
                 */
                keyframes.times = onMetaData.times;
                keyframes.filepositions = onMetaData.filepositions;
                this._mediaInfo.keyframesIndex = this._parseKeyframesIndex(keyframes);
                onMetaData.keyframes = null; // keyframes has been extracted, remove it
            } else {
                this._mediaInfo.hasKeyframesIndex = false;
            }
            this._dispatch = false;
            this._mediaInfo.metadata = onMetaData;
            console.log(this.TAG, 'Parsed onMetaData');
            // if (this._mediaInfo.isComplete()) {
            // this._onMediaInfo(this._mediaInfo);
            // }
            return this._mediaInfo;
        }
    }

    _parseKeyframesIndex(keyframes) {
        const times = [];
        const filepositions = [];

        // ignore first keyframe which is actually AVC Sequence Header (AVCDecoderConfigurationRecord)
        for (let i = 1; i < keyframes.times.length; i++) {
            const time = this._timestampBase + Math.floor(keyframes.times[i] * 1000);
            times.push(time);
            filepositions.push(keyframes.filepositions[i]);
        }

        return {
            times,
            filepositions
        };
    }

    /**
     * 传入tags输出moof和mdat
     * 同时解析 meta data
     *
     * @param {any} tags
     *
     * @memberof tagDemux
     */
    moofTag(tags) {

        for (let i = 0; i < tags.length; i++) {
            this._dispatch = true;
            this.parseChunks(tags[i]);
            // console.log("tagTimestamp", tags[i].getTime(), tags[i]);
        }
        if (this._isInitialMetadataDispatched()) {
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable(this._audioTrack, this._videoTrack);
            }
        }
    }

    /**
     * 单位为 1 个 tag
     */
    parseChunks(flvtag) {

        switch (flvtag.tagType) {
            case 8: // Audio
                // TODO:
                this._parseAudioData(flvtag.body.buffer, 0, flvtag.body.length, flvtag.getTime());
                break;
            case 9: // Video
                /**
                 * 解析 video tag，包括 record nalu 和 普通 nalu
                 */
                this._parseVideoData(flvtag.body.buffer, 0, flvtag.body.length, flvtag.getTime(), 0);
                break;
            case 18: // ScriptDataObject
                this.parseMetadata(flvtag.body);
                // 注意这里解析完后没有触发 _onMediaInfo，那是在之后触发的
                break;
        }
    }

    /**
     * 解析一个 video tag
     */
    _parseVideoData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition) {
        if (tagTimestamp == this._timestampBase && this._timestampBase != 0) {
            console.log(tagTimestamp, this._timestampBase, '夭寿啦这个视频不是从0开始');
            // this.timestampBase(0);
        }
        if (dataSize <= 1) {
            console.log(this.TAG, 'Flv: Invalid video packet, missing VideoData payload!');
            return;
        }
        // 获取 video tag body 第一字节
        const spec = (new Uint8Array(arrayBuffer, dataOffset, dataSize))[0];
        // 获取是否是关键帧
        const frameType = (spec & 240) >>> 4;
        // 获取编码格式
        const codecId = spec & 15;

        // 7 = avc
        if (codecId !== 7) {
            if(this._onError)
            this._onError(`Flv: Unsupported codec in video frame: ${codecId}`);
            return;
        }

        this._parseAVCVideoPacket(arrayBuffer, dataOffset + 1, dataSize - 1, tagTimestamp, tagPosition, frameType);
    }

    _parseAVCVideoPacket(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType) {

        if (dataSize < 4) {
            console.log(this.TAG, 'Flv: Invalid AVC packet, missing AVCPacketType or/and CompositionTime');
            return;
        }

        const le = this._littleEndian;
        // 获取 video tag body 第2字节到结尾
        const v = new DataView(arrayBuffer, dataOffset, dataSize);

        // IF CodecID == 7  AVCPacketType
        // 0 = AVC sequence header
        // 1 = AVC NALU
        // 2 = AVC end of sequence (lower level NALU sequence ender is not required or supported)
        const packetType = v.getUint8(0);
        // 3字节
        // IF AVCPacketType == 1
        //  Composition time offset
        // ELSE
        //  0

        /**
         * 关于 CTS：
         * For FLV, the Timestamp (FLV spec p.69) tells when the frame should be fed to the decoder in milliseconds, which is
         *  timestamp = DTS / 90.0
         * The CompositionTime (FLV spec p.72) tells the renderer when to perform (“compose”) the video frame on the display device in milliseconds after it enters the decoder; thus it is
         *  compositionTime = (PTS – DTS) / 90.0
         * 
         * DTS 是数据送入 decoder 的时间
         * CTS 是送入 decoder 之后多久需要渲染（“compose”）出来
         * 所以 CTS 就是 DTS 到 PTS 之间的 duration
         */
        const cts = v.getUint32(0, !le) & 0x00FFFFFF;

        // IF AVCPacketType == 0 AVCDecoderConfigurationRecord（AVC sequence header）
        // IF AVCPacketType == 1 One or more NALUs (Full frames are required)

        /**
         *AVCDecoderConfigurationRecord.包含着是H.264解码相关比较重要的sps和pps信息，
         *再给AVC解码器送数据 流之前一定要把sps和pps信息送出，否则的话解码器不能正常解码。
         *而且在解码器stop之后再次start之前，如seek、快进快退状态切换等，
         *都 需要重新送一遍sps和pps的信息.AVCDecoderConfigurationRecord在FLV文件中一般情况也是出现1次，
         *也就是第一个 video tag.
         */
        if (packetType === 0) { // AVCDecoderConfigurationRecord
            this._parseAVCDecoderConfigurationRecord(arrayBuffer, dataOffset + 4, dataSize - 4);
        } else if (packetType === 1) { // One or more Nalus
            // TODO: 
            this._parseAVCVideoData(arrayBuffer, dataOffset + 4, dataSize - 4, tagTimestamp, tagPosition, frameType, cts);
        } else if (packetType === 2) {
            // empty, AVC end of sequence
        } else {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid video packet type ${packetType}`);
            return;
        }
    }

    /**
     * AVC 初始化
     */
    _parseAVCDecoderConfigurationRecord(arrayBuffer, dataOffset, dataSize) {
        if (dataSize < 7) {
            console.log(this.TAG, 'Flv: Invalid AVCDecoderConfigurationRecord, lack of data!');
            return;
        }

        let meta = this._videoMetadata;
        const track = this._videoTrack;
        const le = this._littleEndian;
        const v = new DataView(arrayBuffer, dataOffset, dataSize);

        if (!meta) {
            meta = this._videoMetadata = {};
            meta.type = 'video';
            meta.id = track.id;
            // timescale 目前写死了 10000
            meta.timescale = this._timescale;
            // duration 是从 script tag 中解出来的 onMetaData
            meta.duration = this._duration;
        } else {
            if (typeof meta.avcc !== 'undefined') {
                console.log(this.TAG, 'Found another AVCDecoderConfigurationRecord!');
            }
        }

        const version = v.getUint8(0); // configurationVersion
        const avcProfile = v.getUint8(1); // avcProfileIndication
        const profileCompatibility = v.getUint8(2); // profile_compatibility
        const avcLevel = v.getUint8(3); // AVCLevelIndication

        if (version !== 1 || avcProfile === 0) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid AVCDecoderConfigurationRecord');
            return;
        }

        // 3 -> binary -> 00000011
        this._naluLengthSize = (v.getUint8(4) & 3) + 1; // lengthSizeMinusOne
        if (this._naluLengthSize !== 3 && this._naluLengthSize !== 4) { // holy shit!!!
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Strange NaluLengthSizeMinusOne: ${this._naluLengthSize - 1}`);
            return;
        }

        // 32 -> binary -> 00011111
        const spsCount = v.getUint8(5) & 31; // numOfSequenceParameterSets
        if (spsCount === 0 || spsCount > 1) {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid H264 SPS count: ${spsCount}`);
            return;
        }

        let offset = 6;

        console.log('debug spsCount', spsCount)

        for (let i = 0; i < spsCount; i++) {
            const len = v.getUint16(offset, !le); // sequenceParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // Notice: Nalu without startcode header (00 00 00 01)
            const sps = new Uint8Array(arrayBuffer, dataOffset + offset, len);
            offset += len;

            const config = SPSParser.parseSPS(sps);
            console.log('debug sps', config)
            meta.codecWidth = config.codec_size.width;
            meta.codecHeight = config.codec_size.height;
            meta.presentWidth = config.present_size.width;
            meta.presentHeight = config.present_size.height;

            meta.profile = config.profile_string;
            meta.level = config.level_string;
            meta.bitDepth = config.bit_depth;
            meta.chromaFormat = config.chroma_format;
            meta.sarRatio = config.sar_ratio;
            meta.frameRate = config.frame_rate;

            if (config.frame_rate.fixed === false ||
                config.frame_rate.fps_num === 0 ||
                config.frame_rate.fps_den === 0) {
                meta.frameRate = this._referenceFrameRate;
            }

            const fps_den = meta.frameRate.fps_den;
            const fps_num = meta.frameRate.fps_num;
            meta.refSampleDuration = Math.floor(meta.timescale * (fps_den / fps_num));


            const codecArray = sps.subarray(1, 4);
            let codecString = 'avc1.';
            for (let j = 0; j < 3; j++) {
                let h = codecArray[j].toString(16);
                if (h.length < 2) {
                    h = '0' + h;
                }
                codecString += h;
            }

            console.log('debug codecString', codecString);
            /**
             * codecString 例如：avc1.64001e
             */
            meta.codec = codecString;

            const mi = this._mediaInfo;
            mi.width = meta.codecWidth;
            mi.height = meta.codecHeight;
            mi.fps = meta.frameRate.fps;
            mi.profile = meta.profile;
            mi.level = meta.level;
            mi.chromaFormat = config.chroma_format_string;
            mi.sarNum = meta.sarRatio.width;
            mi.sarDen = meta.sarRatio.height;
            mi.videoCodec = codecString;

            if (mi.hasAudio) {
                if (mi.audioCodec != null) {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                }
            } else {
                mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + '"';
            }
            if (mi.isComplete()) {
                this._onMediaInfo(mi);
            }
        }

        const ppsCount = v.getUint8(offset); // numOfPictureParameterSets
        if (ppsCount === 0 || ppsCount > 1) {
            this._onError(DemuxErrors.FORMAT_ERROR, `Flv: Invalid H264 PPS count: ${ppsCount}`);
            return;
        }

        offset++;

        for (let i = 0; i < ppsCount; i++) {
            const len = v.getUint16(offset, !le); // pictureParameterSetLength
            offset += 2;

            if (len === 0) {
                continue;
            }

            // pps is useless for extracting video information
            offset += len;
        }

        /**
         * avcC 是 H264 码流的一种封装方式，对 NALU 的分割是在每个 NALU 前面加上 NALU 长度，以及头部是 extdadata(包含 sps pps)
         * 另一种格式 Annex-B，对 NALU 的分割方式是在每个 NALU 前面加上 0000 或者 0001（注意防竞争处理）
         * 
         * 这里就是把原始数据放到 meta.avcc 中
         */
        meta.avcc = new Uint8Array(dataSize);
        meta.avcc.set(new Uint8Array(arrayBuffer, dataOffset, dataSize), 0);
        console.log(this.TAG, 'Parsed AVCDecoderConfigurationRecord');

        if (this._isInitialMetadataDispatched()) {
            // flush parsed frames
            if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                this._onDataAvailable(this._audioTrack, this._videoTrack);
            }
        } else {
            /**
             * 表示视频初始化完成，还要等音频初始化完成才会触发上面的 _isInitialMetadataDispatched() => true
             */
            this._videoInitialMetadataDispatched = true;
        }
        // notify new metadata
        this._dispatch = false;
        // if (this._onTrackMetadata) {
        //     this._onTrackMetadata.call(null, meta);
        // }

        // TODO: 配合音频一起看下这之后会触发什么
        this._onTrackMetadata('video', meta);
    }

    timestampBase(i) {
        this._timestampBase = i;
    }

    /**
     * 普通的AVC 片段
     * 
     * 一个 tag 是一帧，一帧有多个 NAL Unit 构成
     * 
     * 解析 avcPacket，按照 tag 也就是帧为维度放入 _videoTrack.samples
     * 一个 sample 代表一帧，每个 sample 有 dts cts 及 nalu原始数据（要送入解码器的视频数据）
     */
    _parseAVCVideoData(arrayBuffer, dataOffset, dataSize, tagTimestamp, tagPosition, frameType, cts) {

        const le = this._littleEndian;
        const v = new DataView(arrayBuffer, dataOffset, dataSize);

        let units = [],
            length = 0;

        let offset = 0;

        /**
         * avcC 的 NALU 组织形式是 naluLength + naluData，一般 naluLength 占 4 字节
         */
        const lengthSize = this._naluLengthSize;

        /**
         * tagTimestamp 就是当前 tag 的 timestamp，即送入解码器的时间，DTS
         */
        const dts = this._timestampBase + tagTimestamp;
        let keyframe = (frameType === 1); // from FLV Frame Type constants

        // TODO: 

        /**
         * 从 0 开始，一直读取到 dataSize
         */
        while (offset < dataSize) {

            /**
             * 起码要有 nalusize（4字节） 和 naludata
             */
            if (offset + 4 >= dataSize) {
                console.log(this.TAG, `Malformed Nalu near timestamp ${dts}, offset = ${offset}, dataSize = ${dataSize}`);
                break; // data not enough for next Nalu
            }

            // Nalu with length-header (AVC1)
            /**
             * 先按照 4 字节取
             */
            let naluSize = v.getUint32(offset, !le); // Big-Endian read
            /**
             * 如果是 3 字节，右移一个字节修正取值
             * 得出当前 Nalu 长度
             */
            if (lengthSize === 3) {
                naluSize >>>= 8;
            }

            /**
             * naluSize 必须等于（只剩一个 nalu）或者小于（还有多个 nalu） dataSize - lengthSize
             */
            if (naluSize > dataSize - lengthSize) {
                console.log(this.TAG, `Malformed Nalus near timestamp ${dts}, NaluSize > DataSize!`);
                return;
            }

            /**
             * 取 nalu 第一个字节
             */
            const unitType = v.getUint8(offset + lengthSize) & 0x1F;

            /**
             * 6-sei 7-sps 8-pps
             */
            if (unitType === 5) { // IDR
                keyframe = true;
            }

            /**
             * 保存 nalu 原始值（包含 naluSize）
             */
            const data = new Uint8Array(arrayBuffer, dataOffset + offset, lengthSize + naluSize);
            const unit = { type: unitType, data };
            units.push(unit);
            length += data.byteLength;

            offset += lengthSize + naluSize;
        }

        if (units.length) {
            const track = this._videoTrack;
            const avcSample = {
                units,
                length,
                isKeyframe: keyframe,
                dts,
                cts,
                pts: (dts + cts)
            };
            if (keyframe) {
                avcSample.fileposition = tagPosition;
            }
            track.samples.push(avcSample);
            track.length += length;
        }
    }
    _parseAudioData(arrayBuffer, dataOffset, dataSize, tagTimestamp) {
        if (tagTimestamp == this._timestampBase && this._timestampBase != 0) {
            console.log(tagTimestamp, this._timestampBase, '夭寿啦这个视频不是从0开始');
            // timestampBase(0);
        }

        if (dataSize <= 1) {
            console.log(this.TAG, 'Flv: Invalid audio packet, missing SoundData payload!');
            return;
        }

        let meta = this._audioMetadata;
        const track = this._audioTrack;

        /**
         * 每个 flv audio tag 的第一个字节 always 是 meta 信息
         * 只在第一次解析就好了
         */
        if (!meta || !meta.codec) {
            // initial metadata
            meta = this._audioMetadata = {};
            meta.type = 'audio';
            meta.id = track.id;
            meta.timescale = this._timescale;
            meta.duration = this._duration;

            const le = this._littleEndian;
            const v = new DataView(arrayBuffer, dataOffset, dataSize);

            /**
             * soundSpec 结构：
             * SoundFormat(4bits) (AAC=10)
             * SoundRate(2bits) (xxkHz)
             * SoundSize(1bit) (xx-bit)
             * SoundType(1bit) (1-Stereo)
             */
            const soundSpec = v.getUint8(0);

            const soundFormat = soundSpec >>> 4;
            if (soundFormat !== 10) { // AAC
                // TODO: support MP3 audio codec
                this._onError(DemuxErrors.CODEC_UNSUPPORTED, 'Flv: Unsupported audio codec idx: ' + soundFormat);
                return;
            }

            /**
             * 采样率
             * 固定的几个值（soundRateTable）
             * 解码出 index 从 table 中取
             */
            let soundRate = 0;
            const soundRateIndex = (soundSpec & 12) >>> 2;

            const soundRateTable = [5500, 11025, 22050, 44100, 48000];

            if (soundRateIndex < soundRateTable.length) {
                soundRate = soundRateTable[soundRateIndex];
            } else {
                this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: Invalid audio sample rate idx: ' + soundRateIndex);
                return;
            }

            const soundSize = (soundSpec & 2) >>> 1; // unused
            const soundType = (soundSpec & 1);

            meta.audioSampleRate = soundRate;
            meta.channelCount = (soundType === 0 ? 1 : 2);
            meta.refSampleDuration = Math.floor(1024 / meta.audioSampleRate * meta.timescale);
            meta.codec = 'mp4a.40.5';
        }

        // 跳过第一个字节 meta
        /**
         * aacDate 可能是 aac sequence header（AudioSpecificConfig）也可能是 raw data
         */
        const aacData = this._parseAACAudioData(arrayBuffer, dataOffset + 1, dataSize - 1);
        if (aacData == undefined) {
            return;
        }

        if (aacData.packetType === 0) { // AAC sequence header (AudioSpecificConfig)
            if (meta.config) {
                console.log(this.TAG, 'Found another AudioSpecificConfig!');
            }
            const misc = aacData.data;
            meta.audioSampleRate = misc.samplingRate;
            meta.channelCount = misc.channelCount;
            meta.codec = misc.codec;
            meta.config = misc.config;
            // The decode result of an aac sample is 1024 PCM samples
            meta.refSampleDuration = Math.floor(1024 / meta.audioSampleRate * meta.timescale);
            console.log(this.TAG, 'Parsed AudioSpecificConfig');

            if (this._isInitialMetadataDispatched()) {
                // Non-initial metadata, force dispatch (or flush) parsed frames to remuxer
                if (this._dispatch && (this._audioTrack.length || this._videoTrack.length)) {
                    this._onDataAvailable(this._audioTrack, this._videoTrack);
                }
            } else {
                this._audioInitialMetadataDispatched = true;
            }
            // then notify new metadata
            this._dispatch = false;
            this._onTrackMetadata('audio', meta);

            const mi = this._mediaInfo;
            mi.audioCodec = 'mp4a.40.' + misc.originalAudioObjectType;
            mi.audioSampleRate = meta.audioSampleRate;
            mi.audioChannelCount = meta.channelCount;
            if (mi.hasVideo) {
                if (mi.videoCodec != null) {
                    mi.mimeType = 'video/x-flv; codecs="' + mi.videoCodec + ',' + mi.audioCodec + '"';
                }
            } else {
                mi.mimeType = 'video/x-flv; codecs="' + mi.audioCodec + '"';
            }
            if (mi.isComplete()) {
                this._onMediaInfo(mi);
            }
            return;
        } else if (aacData.packetType === 1) { // AAC raw frame data
            const dts = this._timestampBase + tagTimestamp;
            const aacSample = { unit: aacData.data, dts, pts: dts };
            track.samples.push(aacSample);
            track.length += aacData.data.length;
        } else {
            console.log(this.TAG, `Flv: Unsupported AAC data type ${aacData.packetType}`);
        }
    }

    _parseAACAudioData(arrayBuffer, dataOffset, dataSize) {
        if (dataSize <= 1) {
            console.log(this.TAG, 'Flv: Invalid AAC packet, missing AACPacketType or/and Data!');
            return;
        }

        const result = {};
        const array = new Uint8Array(arrayBuffer, dataOffset, dataSize);

        /**
         * AACPacketType 1bytes 0-AAC sequence header 1-AAC raw
         */
        result.packetType = array[0];

        if (array[0] === 0) {
            /**
             * 解析 aac sequence header，得到音频配置：采样率、codec 等
             */
            result.data = this._parseAACAudioSpecificConfig(arrayBuffer, dataOffset + 1, dataSize - 1);
        } else {
            result.data = array.subarray(1);
        }

        return result;
    }

    _parseAACAudioSpecificConfig(arrayBuffer, dataOffset, dataSize) {
        const array = new Uint8Array(arrayBuffer, dataOffset, dataSize);
        let config = null;

        const mpegSamplingRates = [
            96000, 88200, 64000, 48000, 44100, 32000,
            24000, 22050, 16000, 12000, 11025, 8000, 7350
        ];

        /* Audio Object Type:
           0: Null
           1: AAC Main
           2: AAC LC
           3: AAC SSR (Scalable Sample Rate)
           4: AAC LTP (Long Term Prediction)
           5: HE-AAC / SBR (Spectral Band Replication)
           6: AAC Scalable
        */

        let audioObjectType = 0;
        let originalAudioObjectType = 0;
        let audioExtensionObjectType = null;
        let samplingIndex = 0;
        let extensionSamplingIndex = null;
        // debugger;
        // 5 bits
        audioObjectType = originalAudioObjectType = array[0] >>> 3;
        // 4 bits
        samplingIndex = ((array[0] & 0x07) << 1) | (array[1] >>> 7);
        if (samplingIndex < 0 || samplingIndex >= mpegSamplingRates.length) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid sampling frequency index!');
            return;
        }

        const samplingFrequence = mpegSamplingRates[samplingIndex];

        // 4 bits
        const channelConfig = (array[1] & 0x78) >>> 3;
        if (channelConfig < 0 || channelConfig >= 8) {
            this._onError(DemuxErrors.FORMAT_ERROR, 'Flv: AAC invalid channel configuration');
            return;
        }

        if (audioObjectType === 5) { // HE-AAC?
            // 4 bits
            extensionSamplingIndex = ((array[1] & 0x07) << 1) | (array[2] >>> 7);
            // 5 bits
            audioExtensionObjectType = (array[2] & 0x7C) >>> 2;
        }

        // workarounds for various browsers
        const userAgent = self.navigator.userAgent.toLowerCase();

        if (userAgent.indexOf('firefox') !== -1) {
            // firefox: use SBR (HE-AAC) if freq less than 24kHz
            if (samplingIndex >= 6) {
                audioObjectType = 5;
                config = new Array(4);
                extensionSamplingIndex = samplingIndex - 3;
            } else { // use LC-AAC
                audioObjectType = 2;
                config = new Array(2);
                extensionSamplingIndex = samplingIndex;
            }
        } else if (userAgent.indexOf('android') !== -1) {
            // android: always use LC-AAC
            audioObjectType = 2;
            config = new Array(2);
            extensionSamplingIndex = samplingIndex;
        } else {
            // for other browsers, e.g. chrome...
            // Always use HE-AAC to make it easier to switch aac codec profile
            audioObjectType = 5;
            extensionSamplingIndex = samplingIndex;
            config = new Array(4);

            if (samplingIndex >= 6) {
                extensionSamplingIndex = samplingIndex - 3;
            } else if (channelConfig === 1) { // Mono channel
                audioObjectType = 2;
                config = new Array(2);
                extensionSamplingIndex = samplingIndex;
            }
        }

        config[0] = audioObjectType << 3;
        config[0] |= (samplingIndex & 0x0F) >>> 1;
        config[1] = (samplingIndex & 0x0F) << 7;
        config[1] |= (channelConfig & 0x0F) << 3;
        if (audioObjectType === 5) {
            config[1] |= ((extensionSamplingIndex & 0x0F) >>> 1);
            config[2] = (extensionSamplingIndex & 0x01) << 7;
            // extended audio object type: force to 2 (LC-AAC)
            config[2] |= (2 << 2);
            config[3] = 0;
        }

        return {
            config,
            samplingRate: samplingFrequence,
            channelCount: channelConfig,
            codec: 'mp4a.40.' + audioObjectType,
            originalAudioObjectType
        };
    }
    _isInitialMetadataDispatched() {
        if (this._hasAudio && this._hasVideo) { // both audio & video
            return this._audioInitialMetadataDispatched && this._videoInitialMetadataDispatched;
        }
        if (this._hasAudio && !this._hasVideo) { // audio only
            return this._audioInitialMetadataDispatched;
        }
        if (!this._hasAudio && this._hasVideo) { // video only
            return this._videoInitialMetadataDispatched;
        }
    }
}
export default new tagDemux();