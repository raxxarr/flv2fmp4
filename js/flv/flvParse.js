/* eslint-disable */
import tag from './flvTag.js';

/**
 * 好像没什么用
 */
import tagdemux from './tagdemux';
class FlvParse {
    constructor() {
        this.tempUint8 = new Uint8Array();
        this.arrTag = [];
        this.index = 0;
        this.tempArr = [];
        this.stop = false;
        this.offset = 0;
        this.frist = true;
        this._hasAudio = false;
        this._hasVideo = false;
    }

    /**
     * 接受 外部的flv二进制数据
     */
    setFlv(uint8) {
        this.stop = false;
        this.arrTag = [];
        this.index = 0;
        this.tempUint8 = uint8;
        /**
         * 判断是不是 flv header，如果是，做一些初始化操作
         */
        if (this.tempUint8.length > 13 && this.tempUint8[0] == 70 /* 字母 F */ && this.tempUint8[1] == 76  /* 字母 L */ && this.tempUint8[2] == 86 /* 字母 V */ ) {
            /**
             * 从 flv header 中解出当前流有没有音频、视频
             */
            this.probe(this.tempUint8.buffer);

            // https://www.jianshu.com/p/1df4bc217dbd
            this.read(9); // 略掉9个字节的flv header
            this.read(4); // 略掉第一个4字节的 tag size
            this.parse();
            this.frist = false;
            return this.offset;
        } else if (!this.frist) {
            return this.parse();
        } else {
            return this.offset;
        }
    }
    probe(buffer) {
        const data = new Uint8Array(buffer);
        const mismatch = { match: false };

        /**
         * flv header 构成 Signature(3 Byte)+Version(1 Byte)+Flags(1 Bypte)+DataOffset(4 Byte)，共9字节
         * Signature：F(0x46) L(0x4C) V(0x56)
         * version: 1
         */
        if (data[0] !== 0x46 || data[1] !== 0x4C || data[2] !== 0x56 || data[3] !== 0x01) {
            /**
             * 如果不是 header，跳过
             */
            return mismatch;
        }

        /**
         * flv header
         * flags: 1个字节，0101，第一个1代表有音频，第二个1代表有视频
         * 
         * data[4] & 4 代表
         * (如果有音频)
         * data[4]: 0 1 0 1
         * 4的2进制：0 1 0 0
         * 按位与：  0 1 0 0
         * 
         * 然后 >>>2 右移 2 位：
         * 0 0 0 1
         * 结果也就是 1，代表有音频（1 !== 0）
         * 
         */
        const hasAudio = ((data[4] & 4) >>> 2) !== 0;
        const hasVideo = (data[4] & 1) !== 0;

        if (!hasAudio && !hasVideo) {
            return mismatch;
        }
        this._hasAudio = tagdemux._hasAudio = hasAudio;
        this._hasVideo = tagdemux._hasVideo = hasVideo;
        return {
            match: true,
            hasAudioTrack: hasAudio,
            hasVideoTrack: hasVideo
        };
    }

    /**
     * 开始解析
     * 
     * 注意： 只读取完整的 tag，而 chunk 是随意的，所以 parse 完可能会剩下部分不完整的 tag
     * 留下来和下一个 chunk 拼成完整 tag 再一起解析
     * 所以这里会返回最终读取结束的 offset
     * 外面会根据这个 offset 选择下一次送进来的数据要带上之前遗留的部分不完整数据
     */
    parse() {

        /**
         * 按照字节遍历当前 chunk，解析每一个 tag
         */
        while (this.index < this.tempUint8.length && !this.stop) {
            /**
             * this.index this.offset 就是当前需要开始读取的数据位置 
             */
            this.offset = this.index;

            const t = new tag();
            /**
             * body tag 由 tag header 和 tag data 构成
             * tag header 固定 11 bytes
             */
            if (this.tempUint8.length - this.index >= 11) {
                t.tagType = (this.read(1)[0]); // 取出tag类型
                t.dataSize = this.read(3); // 取出包体大小

                /**
                 * TODO: 这是解码时间？
                 */
                t.Timestamp = this.read(4); // 取出解码时间
                t.StreamID = this.read(3); // 取出stream id
            } else {
                this.stop = true;
                continue;
            }

            /**
             * tagheader 里面的 dataSize 只是标明了 tag data 的大小，而不是整个 tag 的大小
             * tag 之后的 4 字节 previous tag size 才标明上一个 tag 大小，因此这里还要 +4，解析出整个 tag 的大小，加在 t 对象上
             * 
             * t.size - t.dataSize 应该等于 11，即 tag header 的大小
             */
            if (this.tempUint8.length - this.index >= (this.getBodySum(t.dataSize) + 4)) {
                t.body = this.read(this.getBodySum(t.dataSize)); // 取出body
                if (t.tagType == 9 && this._hasVideo) {
                    this.arrTag.push(t);
                }
                if (t.tagType == 8 && this._hasAudio) {
                    this.arrTag.push(t);
                }

                /**
                 * 18 代表 script data
                 */
                if (t.tagType == 18 ) {
                    if(this.arrTag.length==0)
                    this.arrTag.push(t);
                    else{
                        console.log('这是截获的自定义数据',t);
                    }
                }
                t.size=this.read(4);
            } else {
                this.stop = true;
                continue;
            }

            /**
             * 更新 read 之后的数据位置
             */
            this.offset = this.index;
        }

        return this.offset;
    }
    read(length) {
        // let u8a = new Uint8Array(length);
        // u8a.set(this.tempUint8.subarray(this.index, this.index + length), 0);
        const u8a = this.tempUint8.slice(this.index, this.index + length);
        this.index += length;
        return u8a;
    }

    /**
     * 计算tag包体大小
     */
    getBodySum(arr) {
        let _str = '';
        _str += (arr[0].toString(16).length == 1 ? '0' + arr[0].toString(16) : arr[0].toString(16));
        _str += (arr[1].toString(16).length == 1 ? '0' + arr[1].toString(16) : arr[1].toString(16));
        _str += (arr[2].toString(16).length == 1 ? '0' + arr[2].toString(16) : arr[2].toString(16));
        return parseInt(_str, 16);
    }
}
export default new FlvParse();