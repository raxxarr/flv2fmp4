/* eslint-disable */

import cpu from './flv2fmp4';
// var cpu=require('chimee-flv2fmp4')

const temp = new cpu();
console.log(temp);
window.flvParse = {
    mp4File: null,
    succ: null,
    // ftyp_moov:null,
    tracks: [],
    baseTime: 0,
    setFlv(uint8, baseTime) {
        if (flvParse.baseTime != baseTime) {
            flvParse.baseTime = baseTime;
            temp.seek(baseTime);
        }
        if (window.mp4Init) {

            /**
             * from remuxer：
             * metadata解读成功后触发及第一个视频tag和第一个音频tag
             * 会拿到 ftyp moov
             * 
             * to mse：
             * sb.appendBuffer(new Uint8Array(ftyp,moov));
             */
            temp.onInitSegment = window.mp4Init;
        }
        if (window.onMediaSegment) {

            /**
             * from remuxer：
             * remux video、audio track
             * 会拿到 moof mdat
             * 
             * to mse：
             * sb.appendBuffer(new Uint8Array(moof,mdat));
             */
            temp.onMediaSegment = window.onMediaSegment;
        }
        if (window.seekCallBack) {
            // temp.seekCallBack = window.se
            temp.seekCallBack = window.seekCallBack;
        }
        if (window.onMediaInfo) {

            /**
             * 这个是在 demux 之后就触发的
             * 会拿到 codec 等信息
             * codec 等是从 H264 码流的 sps/pps 中解出来的
             * 
             * to mse:
             * 创建 mse，并传入 codec 创建 sourceBuffer
             */
            temp.onMediaInfo = window.onMediaInfo;
        }
        return temp.setflv(uint8.buffer, baseTime);

        // 用来获取moov

    },
    setLocFlv(uin8) {
        return temp.setflvloc(uin8);
    }
};