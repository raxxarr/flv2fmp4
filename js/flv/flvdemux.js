/* eslint-disable */
import decodeUTF8 from '../decodeUTF8';
import SPSParser from './sps-parser';
const le = (function() {
    const buf = new ArrayBuffer(2);
    (new DataView(buf)).setInt16(0, 256, true); // little-endian write
    return (new Int16Array(buf))[0] === 256; // platform-spec read, if equal then LE
})();
export default class flvDemux {

    constructor() {

    }
    static parseObject(arrayBuffer, dataOffset, dataSize) {

        const name = flvDemux.parseString(arrayBuffer, dataOffset, dataSize);
        const value = flvDemux.parseScript(arrayBuffer, dataOffset + name.size);
        const isObjectEnd = value.objectEnd;

        return {
            data: {
                name: name.data,
                value: value.data
            },
            size: value.size,
            objectEnd: isObjectEnd
        };
    }

    static parseVariable(arrayBuffer, dataOffset, dataSize) {
        return flvDemux.parseObject(arrayBuffer, dataOffset, dataSize);
    }
    static parseLongString(arrayBuffer, dataOffset, dataSize) {

        const v = new DataView(arrayBuffer, dataOffset);
        const length = v.getUint32(0, !le);

        let str;
        if (length > 0) {
            str = decodeUTF8(new Uint8Array(arrayBuffer, dataOffset + 4, length));
        } else {
            str = '';
        }

        return {
            data: str,
            size: 4 + length
        };
    }
    static parseDate(arrayBuffer, dataOffset, dataSize) {

        const v = new DataView(arrayBuffer, dataOffset);
        let timestamp = v.getFloat64(0, !le);
        const localTimeOffset = v.getInt16(8, !le);
        timestamp += localTimeOffset * 60 * 1000; // get UTC time

        return {
            data: new Date(timestamp),
            size: 8 + 2
        };
    }
    static parseString(arrayBuffer, dataOffset, dataSize) {
        const v = new DataView(arrayBuffer, dataOffset);
        const length = v.getUint16(0, !le);
        let str;
        if (length > 0) {
            str = decodeUTF8(new Uint8Array(arrayBuffer, dataOffset + 2, length));
        } else {
            str = '';
        }
        return {
            data: str,
            size: 2 + length
        };
    }

    /**
     * 解析metadata
     */
    static parseMetadata(arr) { // arr 是 tag body 的 arraybuffer

        /**
         * 送去解析 tag type 为 script 的 data
         * 
         * script tag 包含两个 AMF
         */

        // 第一个 AMF，解出来就是 NAME=onMetaData
        const name = flvDemux.parseScript(arr, 0);
        // 第二个 AMF，解出来就是各种元信息键值对
        const value = flvDemux.parseScript(arr, name.size, arr.length - name.size);

        const data = {};
        /**
         * data = {
         *  onMetaData: {
         *      duration: 41.4,
         *      framerate: 25.07246376811594,
         *      filesize: 1994716,
         *      width: 640,
         *      ...
         *  }
         * }
         */
        data[name.data] = value.data;
        return data;
    }

    /**
     * 解析方式具体可参考：https://www.jianshu.com/p/1df4bc217dbd
     * 所有数据都是以数据类型+（数据长度）+数据的格式出现的，数据类型占1byte，数据长度看数据类型是否存在，后面才是数据。
     */
    static parseScript(arr, offset, dataSize) {
        let dataOffset = offset;
        const object = {};
        const uint8 = new Uint8Array(arr);
        const buffer = uint8.buffer;
        const dv = new DataView(buffer, 0, dataSize);
        let value = null;
        let objectEnd = false;

        /**
         * 第一个字节是数据类型 type
         */
        const type = (dv.getUint8(dataOffset));
        dataOffset += 1;

        switch (type) {
            case 0: // Number(Double) type
                value = dv.getFloat64(dataOffset, !le);
                dataOffset += 8;
                break;
            case 1:
                { // Boolean type
                    const b = dv.getUint8(dataOffset);
                    value = !!b;
                    dataOffset += 1;
                    break;
                }
            case 2:
                { // String type
                    // dataOffset += 1;
                    const amfstr = flvDemux.parseString(buffer, dataOffset);
                    value = amfstr.data;
                    dataOffset += amfstr.size;
                    break;
                }
            case 3:

                { // Object(s) type
                    value = {};
                    let terminal = 0; // workaround for malformed Objects which has missing ScriptDataObjectEnd
                    if ((dv.getUint32(dataSize - 4, !le) & 0x00FFFFFF) === 9) {
                        terminal = 3;
                    }
                    while (dataOffset < dataSize - 4) { // 4 === type(UI8) + ScriptDataObjectEnd(UI24)
                        const amfobj = flvDemux.parseObject(buffer, dataOffset, dataSize - offset - terminal);

                        if (amfobj.objectEnd) { break; }
                        value[amfobj.data.name] = amfobj.data.value;
                        // dataOffset += amfobj.size;
                        dataOffset = amfobj.size;
                    }
                    if (dataOffset <= dataSize - 3) {
                        const marker = v.getUint32(dataOffset - 1, !le) & 0x00FFFFFF;
                        if (marker === 9) {
                            dataOffset += 3;
                        }
                    }
                    break;
                }

            /**
             * 解析出来是键值对：
             * width=xxx
             * duration=xxx
             * ...
             */
            case 8:
                { // ECMA array type (Mixed array)
                    value = {};
                    // dataOffset += 1;
                    dataOffset += 4; // ECMAArrayLength(UI32)
                    let terminal = 0; // workaround for malformed MixedArrays which has missing ScriptDataObjectEnd
                    if ((dv.getUint32(dataSize - 4, !le) & 0x00FFFFFF) === 9) {
                        terminal = 3;
                    }
                    while (dataOffset < dataSize - 8) { // 8 === type(UI8) + ECMAArrayLength(UI32) + ScriptDataVariableEnd(UI24)
                        const amfvar = flvDemux.parseVariable(buffer, dataOffset);

                        if (amfvar.objectEnd) { break; }
                        value[amfvar.data.name] = amfvar.data.value;
                        dataOffset = amfvar.size;
                    }
                    if (dataOffset <= dataSize - 3) {
                        const marker = dv.getUint32(dataOffset - 1, !le) & 0x00FFFFFF;
                        if (marker === 9) {
                            dataOffset += 3;
                        }
                    }
                    break;
                }
            case 9: // ScriptDataObjectEnd
                value = undefined;
                dataOffset = 1;
                objectEnd = true;
                break;
            case 10:
                { // Strict array type
                    // ScriptDataValue[n]. NOTE: according to video_file_format_spec_v10_1.pdf
                    value = [];
                    const strictArrayLength = dv.getUint32(dataOffset, !le);
                    dataOffset += 4;
                    for (let i = 0; i < strictArrayLength; i++) {
                        const val = flvDemux.parseScript(buffer, dataOffset);
                        value.push(val.data);
                        dataOffset = val.size;
                    }
                    break;
                }
            case 11:
                { // Date type
                    const date = flvDemux.parseDate(buffer, dataOffset + 1, dataSize - 1);
                    value = date.data;
                    dataOffset += date.size;
                    break;
                }
            case 12:
                { // Long string type
                    const amfLongStr = flvDemux.parseString(buffer, dataOffset + 1, dataSize - 1);
                    value = amfLongStr.data;
                    dataOffset += amfLongStr.size;
                    break;
                }
            default:
                // ignore and skip
                dataOffset = dataSize;
                console.log('AMF', 'Unsupported AMF value type ' + type);
        }
        return {
            data: value,
            size: dataOffset,
        };
    }
}