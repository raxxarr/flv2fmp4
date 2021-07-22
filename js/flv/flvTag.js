/* eslint-disable */
export default class FlvTag {
    constructor() {
        this.tagType = -1;
        this.dataSize = -1;
        this.Timestamp = -1;
        this.StreamID = -1;
        this.body = -1;
        this.time = -1;
        this.arr = [];
        this.size=-1;
    }
    getTime() {
        // this.Timestamp.pop();
        this.arr = [];
        // console.log('debug this.Timestamp', this.Timestamp);
        /**
         * Timestamp 是 Uint8Array 
         * like: [0, 0, 103, 0]
         * 将每一位转成 16 进制，拼起来
         * 注意要保证每一个元素占 2 位，不够的前面补0
         * 00006700
         * parseInt(00006700, 16)
         * -> 13600
         */
        for (let i = 0; i < this.Timestamp.length; i++) {
            this.arr.push((this.Timestamp[i].toString(16).length == 1 ? '0' + this.Timestamp[i].toString(16) : this.Timestamp[i].toString(16)));
        }
        this.arr.pop();
        const time = this.arr.join('');
        this.time = parseInt(time, 16);
        return parseInt(time, 16);
    }
}