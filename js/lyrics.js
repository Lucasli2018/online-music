/* lyrics.js — LRC 歌词解析与同步
 * 解析标准 [mm:ss.xx] 时间标签，提供按当前时间取行的方法。
 */
(function (global) {
  'use strict';

  var LINE_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function parse(lrcText) {
    if (!lrcText || !lrcText.trim()) return [];
    var lines = lrcText.split(/\r?\n/);
    var out = [];
    lines.forEach(function (line) {
      LINE_RE.lastIndex = 0;
      var tags = [];
      var m;
      while ((m = LINE_RE.exec(line)) !== null) {
        var min = parseInt(m[1], 10);
        var sec = parseInt(m[2], 10);
        var ms = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
        tags.push(min * 60 + sec + ms / 1000);
      }
      if (!tags.length) return;
      var text = line.replace(LINE_RE, '').trim();
      tags.forEach(function (t) {
        out.push({ time: t, text: text || '♪' });
      });
    });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  // 返回当前时间对应的歌词行索引（用于高亮 + 滚动）
  function activeIndex(lines, time) {
    if (!lines.length) return -1;
    var lo = 0, hi = lines.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].time <= time) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  global.CM = global.CM || {};
  global.CM.Lyrics = { parse: parse, activeIndex: activeIndex };
})(window);
