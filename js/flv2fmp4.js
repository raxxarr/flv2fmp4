/* eslint-disable */
import flvparse from './flv/flvParse';
import tagdemux from './flv/tagdemux';
import mp4remux from './mp4/mp4remux';
import mp4moof from './mp4/mp4moof';
class flv2fmp4 {

    /**
     * Creates an instance of flv2fmp4.
     * config 里面有_isLive属性,是否是直播
     * @param {any} config
     *
     * @memberof flv2fmp4
     */
    constructor(config) {
        this._config = { _isLive: false };
        this._config = Object.assign(this._config, config);

        // 外部方法赋值
        this.onInitSegment = null;
        this.onMediaSegment = null;
        this.onMediaInfo = null;
        this.seekCallBack = null;

        // 内部使用
        this.loadmetadata = false;
        this.ftyp_moov = null;
        this.metaSuccRun = false;
        this.metas = [];
        this.parseChunk = null;
        this.hasVideo = false;
        this.hasAudio = false;
        // 临时记录seek时间
        this._pendingResolveSeekPoint = -1;

        // 临时记录flv数据起始时间
        this._tempBaseTime = 0;

        // 处理flv数据入口
        this.setflvBase = this.setflvBasefrist;

        tagdemux._onTrackMetadata = this.Metadata.bind(this);
        tagdemux._onMediaInfo = this.metaSucc.bind(this);
        tagdemux._onDataAvailable = this.onDataAvailable.bind(this);
        this.m4mof = new mp4moof(this._config);
        this.m4mof.onMediaSegment = this.onMdiaSegment.bind(this);
    }
    seek(baseTime) {
        this.setflvBase = this.setflvBasefrist;
        if (baseTime == undefined || baseTime == 0) {
            baseTime = 0;
            this._pendingResolveSeekPoint = -1;
        }
        if (this._tempBaseTime != baseTime) {
            this._tempBaseTime = baseTime;
            tagdemux._timestampBase = baseTime;
            this.m4mof.seek(baseTime);
            this.m4mof.insertDiscontinuity();
            this._pendingResolveSeekPoint = baseTime;
        }
    }

    /**
     * 不要主动调用这个接口!!!!!!!!!!!!!!!!!!!!!!!!!!!!
     * 第一次接受数据,和seek时候接受数据入口,
     *
     * @param {any} arraybuff
     * @param {any} baseTime
     * @returns
     *
     * @memberof flv2fmp4
     */

    /**
     * 第一波 chunk 中包含整个 flv 的 header
     */
    setflvBasefrist(arraybuff, baseTime) {

        let offset = flvparse.setFlv(new Uint8Array(arraybuff));

        /**
         * setFlv 后会解析当前 arraybuffer 中的 tag，并放入 arrTag 中
         */
        if(flvparse.arrTag[0].type!=18){

            /**
             * 第一个 tag 应当是 Script Data(tag 有三种：audio video script)
             */
            if(this.error)this.error(new Error('without metadata tag'));
        }
        if (flvparse.arrTag.length > 0) {
            
            /**
             * flvparse 解析完 flv header 后会知道当前流是否包含音视频
             */
            tagdemux.hasAudio=this.hasAudio = flvparse._hasAudio;
            tagdemux.hasVideo=this.hasVideo = flvparse._hasVideo;
            
            // TODO: ???
            if (this._tempBaseTime != 0 && this._tempBaseTime == flvparse.arrTag[0].getTime()) {
                tagdemux._timestampBase = 0;
            }
            tagdemux.moofTag(flvparse.arrTag);
            this.setflvBase = this.setflvBaseUsually;
        }

        return offset;
    }

    /**
     * 不要主动调用这个接口!!!!!!!!!!!!!!!!!!!!!!!!!!!!
     * 后续接受数据接口
     * @param {any} arraybuff
     * @param {any} baseTime
     * @returns
     *
     * @memberof flv2fmp4
     */
    setflvBaseUsually(arraybuff, baseTime) {
        const offset = flvparse.setFlv(new Uint8Array(arraybuff));

        if (flvparse.arrTag.length > 0) {
            tagdemux.moofTag(flvparse.arrTag);
        }

        return offset;
    }

    /**
     * 不要主动调用这个接口!!!!!!!!!!!!!!!!!!!!!!!!!!!!
     * moof回调
     * 
     * setFlv 之后通过 demux remux 会构建 moof，mdat，然后回调这里
     *
     * @param {string} track 'video' or 'audio'
     * @param {any} value
     *
     * @memberof flv2fmp4
     */
    onMdiaSegment(track, value) {

        if (this.onMediaSegment) {
            // 外面直接调这个方法，拿到 data 放到 mse(sourcebuffer.appendBuffer())
            this.onMediaSegment(new Uint8Array(value.data));
        }

        
        if (this._pendingResolveSeekPoint != -1 && track == 'video') {
            let seekpoint = this._pendingResolveSeekPoint;
            this._pendingResolveSeekPoint = -1;
            if (this.seekCallBack) {
                this.seekCallBack(seekpoint);
            }
        }
    }

    /**
     *
     * 音频和视频的初始化tag
     *
     * @param {any} type
     * @param {any} meta
     *
     * @memberof flv2fmp4
     */
    /**
     * 解析完视频 AVCDecoderConfigurationRecord 后会触发，
     * type: video or audio
     * meta 就是解析结果
     * 音频同理
     */
    Metadata(type, meta) {
        switch (type) {
            case 'video':
                this.metas.push(meta);
                this.m4mof._videoMeta = meta;
                if (this.hasVideo && !this.hasAudio) {
                    this.metaSucc();
                    return;
                }
                break;
            case 'audio':
                this.metas.push(meta);
                this.m4mof._audioMeta = meta;
                if (!this.hasVideo && this.hasAudio) {
                    this.metaSucc();
                    return;
                }
                break;
        }
        if (this.hasVideo && this.hasAudio  && this.metas.length > 1) {
            this.metaSucc();
        }
    }

    /**
     * metadata解读成功后触发及第一个视频tag和第一个音频tag
     *
     * @param {any} mi
     * @returns
     *
     * @memberof flv2fmp4
     */
    metaSucc(mi) {
        if (this.onMediaInfo) {
            this.onMediaInfo(mi||tagdemux._mediaInfo, { hasAudio: this.hasAudio, hasVideo: this.hasVideo });
        }
        // 获取ftyp和moov
        if (this.metas.length == 0) {
            this.metaSuccRun = true;
            return;
        }

        /**
         * 音频 视频 config tag 解析完成后都会触发，
         * 这种情况下只是把数据往外送，不做初始化操作
         */
        if(mi)return;

        /**
         * 都解析完成后，开始初始化
         */

        // >>>>>>>>>
        this.ftyp_moov = mp4remux.generateInitSegment(this.metas);
        if (this.onInitSegment && this.loadmetadata == false) {

            this.onInitSegment(this.ftyp_moov);
            this.loadmetadata = true;
        }
    }

    onDataAvailable(audiotrack, videotrack) {
        this.m4mof.remux(audiotrack, videotrack);
    }



    /**
     * 先通过 setFlv 传入 flv buffer 进行解析
     * 解析后会触发 _onTrackMetadata  _onMediaInfo _onDataAvailable
     */

    /**
     * 传入flv的二进制数据
     * 统一入口
     * @param {any} arraybuff
     * @param {any} baseTime flv数据开始时间
     * @returns
     *
     * @memberof flv2fmp4
     */
    setflv(arraybuff, baseTime) {
        return this.setflvBase(arraybuff, baseTime);
    }

    /**
     *
     * 本地调试代码,不用理会
     * @param {any} arraybuff
     * @returns
     *
     * @memberof flv2fmp4
     */
    setflvloc(arraybuff) {
        const offset = flvparse.setFlv(new Uint8Array(arraybuff));

        if (flvparse.arrTag.length > 0) {
            return flvparse.arrTag;
        }
    }
}

/**
 * 封装的对外类,有些方法不想对外暴露,所以封装这么一个类
 *
 * @class foreign
 */
class foreign {
    constructor(config) {

        this.f2m = new flv2fmp4(config);
        // 外部方法赋值
        this._onInitSegment = null;
        this._onMediaSegment = null;
        this._onMediaInfo = null;
        this._seekCallBack = null;
    }

    /**
     *
     * 跳转
     * @param {any} basetime  跳转时间
     *
     * @memberof foreign
     */
    seek(basetime) {
        this.f2m.seek(basetime);
    }

    /**
     * 传入flv的二进制数据
     * 统一入口
     * @param {any} arraybuff
     * @returns
     *
     * @memberof flv2fmp4
     */
    setflv(arraybuff) {
        return this.f2m.setflv(arraybuff, 0);
    }

    /**
     *
     * 本地调试代码,不用理会
     * @param {any} arraybuff
     * @returns
     *
     * @memberof flv2fmp4
     */
    setflvloc(arraybuff) {
        return this.f2m.setflvloc(arraybuff);
    }

    /**
     * 赋值初始化seg接受方法
     *
     *
     * @memberof foreign
     */
    set onInitSegment(fun) {
        this._onInitSegment = fun;
        this.f2m.onInitSegment = fun;
    }

    /**
     * 赋值moof接受方法
     *
     *
     * @memberof foreign
     */
    set onMediaSegment(fun) {
        this._onMediaSegment = fun;
        this.f2m.onMediaSegment = fun;
    }

    /**
     * 赋值metadata接受方法
     *
     *
     * @memberof foreign
     */

    set onMediaInfo(fun) {
        this._onMediaInfo = fun; // 没有用到
        this.f2m.onMediaInfo = fun;
    }

    /**
     * 赋值是否跳转回调接受方法
     *
     *
     * @memberof foreign
     */
    set seekCallBack(fun) {
        this._seekCallBack = fun;
        this.f2m.seekCallBack = fun;
    }
}

export default foreign;