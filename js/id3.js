/* id3.js — 零依赖解析 ID3v2 封面图（APIC 帧）
 * 仅读取文件头部（前 2MB），不整文件载入，内存友好。
 * 支持 ID3v2.3 / 2.4 的 APIC 帧，返回 dataURL 字符串或 null。
 */
(function (global) {
  'use strict';

  function syncsafe(dv, o) {
    return (dv.getUint8(o) << 21) | (dv.getUint8(o + 1) << 14) |
           (dv.getUint8(o + 2) << 7) | dv.getUint8(o + 3);
  }

  function extractPic(buf, start, end) {
    var dv = new DataView(buf, start, end - start);
    var len = dv.byteLength;
    if (len < 2) return Promise.resolve(null);
    var enc = dv.getUint8(0); // 0=latin1, 1/2=utf16
    var off = 1;
    // mime type（null 结尾）
    var mime = '';
    while (off < len && dv.getUint8(off) !== 0) { mime += String.fromCharCode(dv.getUint8(off)); off++; }
    off++; // 跳过 null
    if (off >= len) return Promise.resolve(null);
    off++; // 跳过 picture type（1 字节）
    // description（按编码 null 结尾）
    if (enc === 0) {
      while (off < len && dv.getUint8(off) !== 0) off++;
      off++;
    } else {
      while (off + 1 < len && !(dv.getUint8(off) === 0 && dv.getUint8(off + 1) === 0)) off += 2;
      off += 2;
    }
    if (off >= len) return Promise.resolve(null);
    var picLen = len - off;
    if (picLen <= 0) return Promise.resolve(null);
    var blob = new Blob([buf.slice(start + off, end)], { type: mime || 'image/jpeg' });
    return new Promise(function (resolve) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { resolve(null); };
      r.readAsDataURL(blob);
    });
  }

  function parseCover(file) {
    if (!file || typeof file.slice !== 'function') return Promise.resolve(null);
    var readSize = Math.min(file.size, 2 * 1024 * 1024);
    if (readSize < 10) return Promise.resolve(null);
    return file.slice(0, readSize).arrayBuffer().then(function (buf) {
      var dv = new DataView(buf);
      // 校验 "ID3"
      if (!(dv.getUint8(0) === 0x49 && dv.getUint8(1) === 0x49 && dv.getUint8(2) === 0x44)) {
        return null; // 无 ID3v2 标签
      }
      var major = dv.getUint8(3);
      if (major < 2 || major > 4) return null;
      var tagSize = syncsafe(dv, 6);
      if (tagSize <= 0) return null;
      var tagEnd = Math.min(10 + tagSize, buf.byteLength);
      var p = 10;
      while (p + 10 <= tagEnd) {
        var fid = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
        var fsize = (major >= 4) ? syncsafe(dv, p + 4) : dv.getUint32(p + 4);
        if (fid === 'APIC') {
          return extractPic(buf, p + 10, p + 10 + fsize);
        }
        if (fid === '\0\0\0\0' || fsize <= 0) break;
        p += 10 + fsize;
      }
      return null;
    }).catch(function () { return null; });
  }

  global.CM = global.CM || {};
  global.CM.ID3 = { parseCover: parseCover };
})(window);
