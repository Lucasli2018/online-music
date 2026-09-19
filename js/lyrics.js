/* lyrics.js — LRC 歌词解析、同步与在线匹配
 * 解析标准 [mm:ss.xx] 时间标签，提供按当前时间取行的方法。
 * 支持：
 *  - 一行多时间标签：[00:01.00][00:05.00]歌词
 *  - 整体时间偏移标签 [offset:-500] / [offset:+500]（毫秒，可正负）
 *  - 忽略元数据标签行（[ti:]/[ar:]/[al:]/[by:]/[length:] 等无时间标签的行）
 *  - 逐字卡拉OK：增强格式内联 <mm:ss.xx>字级时间标签
 *  - 双语：同时间戳多行自动合并（主文本 + 翻译副文本）
 *  - 在线自动匹配：fetchLyrics，LRCLIB → GD Studio（含翻译）多级回退
 *  - 手动匹配：searchCandidates 列出多来源候选，fetchCandidate 按候选取词
 */
(function (global) {
  'use strict';

  var LINE_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var OFFSET_RE = /\[offset\s*:\s*(-?\d+)\s*\]/i;
  var INLINE_RE = /<(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
  var API_BASE = 'https://lrclib.net/api/get';
  var SEARCH_BASE = 'https://lrclib.net/api/search';
  var GD_BASE = 'https://music-api.gdstudio.xyz/api.php';

  function toSec(min, sec, ms) {
    return min * 60 + sec + (ms ? parseInt(ms.padEnd(3, '0').slice(0, 3), 10) / 1000 : 0);
  }

  // 提取行内内联字级时间标签，返回 [{t:绝对秒, w:文本}]
  // 例：[00:12.00]<00:12.50>Hel<00:13.00>lo  ->  [{t:12.5,w:'Hel'},{t:13,w:'lo'}]
  function parseWords(text) {
    if (!text) return [];
    INLINE_RE.lastIndex = 0;
    var parts = [], last = 0, m, hasTag = false;
    while ((m = INLINE_RE.exec(text)) !== null) {
      hasTag = true;
      if (m.index > last) {
        var seg = text.slice(last, m.index);
        if (parts.length) parts[parts.length - 1].w += seg;
        else parts.push({ t: null, w: seg }); // 行首无时间前缀
      }
      parts.push({ t: toSec(+m[1], +m[2], m[3]), w: '' });
      last = INLINE_RE.lastIndex;
    }
    if (!hasTag) return []; // 无内联字级标签 → 非逐字行（避免干扰双语合并判定）
    if (last < text.length) {
      var tail = text.slice(last);
      if (parts.length) parts[parts.length - 1].w += tail;
      else parts.push({ t: null, w: tail });
    }
    return parts.filter(function (p) { return p.w && p.w.length; });
  }

  // 把同时间戳、且后续行非逐字的多行合并为 主+副（双语/翻译）
  function mergeBilingual(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var cur = lines[i];
      while (i + 1 < lines.length &&
             Math.abs(lines[i + 1].time - cur.time) < 1e-6 &&
             !(lines[i + 1].words && lines[i + 1].words.length)) {
        i++;
        var nxt = lines[i];
        var ntxt = (nxt.words && nxt.words.length)
          ? nxt.words.map(function (w) { return w.w; }).join('')
          : nxt.text;
        cur.sub = cur.sub ? (cur.sub + ' / ' + ntxt) : ntxt;
      }
      out.push(cur);
    }
    return out;
  }

  function parse(lrcText) {
    if (!lrcText || !lrcText.trim()) return [];
    var lines = lrcText.split(/\r?\n/);
    var raw = [];
    var offset = 0; // 秒
    lines.forEach(function (line) {
      var om = OFFSET_RE.exec(line);
      if (om) { offset = parseInt(om[1], 10) / 1000; return; }

      LINE_RE.lastIndex = 0;
      var tags = [];
      var m;
      while ((m = LINE_RE.exec(line)) !== null) {
        tags.push(toSec(+m[1], +m[2], m[3]));
      }
      if (!tags.length) return; // 元数据标签 / 空行：跳过，不渲染为歌词
      var text = line.replace(LINE_RE, '').trim();
      var words = parseWords(text);
      tags.forEach(function (t) {
        raw.push({ time: Math.max(0, t + offset), text: text || '♪', words: words });
      });
    });
    raw.sort(function (a, b) { return a.time - b.time; });
    return mergeBilingual(raw);
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

  // 按字节猜测文本编码并解码，解决中文 LRC 乱码。
  function decode(buf) {
    var u8 = new Uint8Array(buf);
    var start = (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xEF) ? 3
              : (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) ? 3 : 0; // 去除 UTF-8 BOM
    var slice = u8.subarray(start);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice); // 先严格尝试 UTF-8
    } catch (e) {
      try { return new TextDecoder('gbk').decode(slice); }            // 失败再按 GBK / GB2312
      catch (e2) { return new TextDecoder('utf-8').decode(slice); }   // 兜底（容错）
    }
  }

  function fetchJSON(u) {
    return fetch(u, { headers: { 'Lrclib-Client': 'CoralMusic/1.0' } }).then(function (r) {
      if (r.status === 404) throw new Error('404');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* ---------- GD Studio 歌词（GD音乐台，含翻译） ---------- */
  function gdApi(params) {
    var qs = Object.keys(params).map(function (k) {
      return k + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return fetch(GD_BASE + '?' + qs).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      try { return JSON.parse(text); } catch (e) { throw new Error('响应异常'); }
    });
  }
  // GD Studio 歌词：tlyric（翻译）按时间戳合并进主歌词，供双语渲染
  function gdMergeTranslation(lyric, tlyric) {
    var lrc = String(lyric || '').replace(/\r/g, '');
    if (!tlyric) return lrc;
    var trans = String(tlyric).replace(/\r/g, '').split('\n');
    var map = {};
    trans.forEach(function (line) {
      LINE_RE.lastIndex = 0;
      var m = LINE_RE.exec(line);
      if (!m) return;
      var key = m[1] + ':' + m[2] + '.' + (m[3] || '00');
      var txt = line.replace(LINE_RE, '').trim();
      if (txt) map[key] = txt;
    });
    if (!Object.keys(map).length) return lrc;
    return lrc.split('\n').map(function (line) {
      LINE_RE.lastIndex = 0;
      var m = LINE_RE.exec(line);
      if (!m) return line;
      var key = m[1] + ':' + m[2] + '.' + (m[3] || '00');
      var txt = line.replace(LINE_RE, '').trim();
      return (txt && map[key]) ? (line + '\n' + map[key]) : line;
    }).join('\n');
  }
  function gdFetchLyric(lid, sub) {
    return gdApi({ types: 'lyric', source: sub || 'netease', id: lid }).then(function (j) {
      if (!j || (!j.lyric && !j.lrc)) throw new Error('无歌词数据');
      return gdMergeTranslation(j.lyric || j.lrc, j.tlyric || j.tlrc);
    });
  }
  // GD Studio 候选搜索：按 关键词 搜索曲目，返回歌词匹配候选
  function gdSearchCandidates(query, limit) {
    return gdApi({ types: 'search', source: 'netease', name: query, count: limit || 10, pages: '1' })
      .then(function (list) {
        if (!Array.isArray(list)) return [];
        return list.filter(function (t) { return t && t.id; }).map(function (t) {
          return {
            prov: 'gd',
            id: String(t.id),
            lid: t.lyric_id || t.id,
            lsrc: 'netease',
            title: t.name || '未知标题',
            artist: Array.isArray(t.artist) ? t.artist.join(' / ') : (t.artist || ''),
            album: t.album || ''
          };
        });
      });
  }

  // 在线自动匹配歌词：LRCLIB 精确 → GD Studio（含翻译）→ LRCLIB 搜索，多级回退。
  // 返回 LRC 原文字符串。需要联网。
  function fetchLyrics(opts) {
    opts = opts || {};
    var title = (opts.title || '').trim();
    var artist = (opts.artist || '').trim();
    if (!title) return Promise.reject(new Error('缺少歌名'));

    function byQuery() {
      var u = API_BASE + '?track_name=' + encodeURIComponent(title) +
              '&artist_name=' + encodeURIComponent(artist || 'unknown');
      if (opts.album) u += '&album_name=' + encodeURIComponent(opts.album);
      if (opts.duration) u += '&duration=' + Math.round(opts.duration);
      return fetchJSON(u);
    }
    function byGd() {
      return gdSearchCandidates(title, 5).then(function (arr) {
        if (!arr.length) throw new Error('GD 无结果');
        return gdFetchLyric(arr[0].lid, arr[0].lsrc);
      });
    }
    function bySearch() {
      var q = SEARCH_BASE + '?q=' + encodeURIComponent(title);
      return fetchJSON(q).then(function (list) {
        var arr = Array.isArray(list) ? list : (list && list.data ? list.data : []);
        if (!arr.length) throw new Error('无搜索结果');
        return fetchJSON(API_BASE + '?id=' + encodeURIComponent(arr[0].id));
      });
    }
    return byQuery()
      .catch(function () { return byGd(); })
      .catch(function () { return bySearch(); })
      .then(function (d) {
        var lrc = typeof d === 'string' ? d : (d && (d.syncedLyrics || d.plainLyrics));
        if (!lrc) throw new Error('无歌词数据');
        return lrc;
      });
  }

  // 手动匹配：按关键词聚合多来源候选（GD Studio·网易云 + LRCLIB），供用户挑选
  function searchCandidates(query, limit) {
    if (!query || !query.trim()) return Promise.resolve([]);
    var n = limit || 10;
    var gd = gdSearchCandidates(query, n).then(function (arr) {
      return arr.map(function (c) { c.provLabel = 'GD · 网易云'; return c; });
    }).catch(function () { return []; });
    var lrc = fetchJSON(SEARCH_BASE + '?q=' + encodeURIComponent(query.trim())).then(function (list) {
      var arr = Array.isArray(list) ? list : (list && list.data ? list.data : []);
      return arr.slice(0, n).map(function (t) {
        return {
          prov: 'lrclib',
          id: t.id,
          title: t.name || t.trackName || '未知标题',
          artist: t.artistName || t.artist || '',
          album: t.albumName || t.album || '',
          duration: t.duration || 0,
          provLabel: 'LRCLIB'
        };
      });
    }).catch(function () { return []; });
    return Promise.all([gd, lrc]).then(function (rs) { return rs[0].concat(rs[1]); });
  }
  // 按候选取词：GD → lyric 端点（含翻译合并）；LRCLIB → get 端点
  function fetchCandidate(cand) {
    if (!cand) return Promise.reject(new Error('候选无效'));
    if (cand.prov === 'gd') return gdFetchLyric(cand.lid, cand.lsrc);
    return fetchJSON(API_BASE + '?id=' + encodeURIComponent(cand.id)).then(function (d) {
      var lrc = d && (d.syncedLyrics || d.plainLyrics);
      if (!lrc) throw new Error('无歌词数据');
      return lrc;
    });
  }

  // 只探测 LRCLIB 是否有这首曲目的歌词（不取正文），用于结果列表标注。
  // 返回 Promise<boolean>，任何异常一律视为「无」。
  function probe(opts) {
    opts = opts || {};
    var title = (opts.title || '').trim();
    var artist = (opts.artist || '').trim();
    if (!title) return Promise.resolve(false);
    var u = API_BASE + '?track_name=' + encodeURIComponent(title) +
            '&artist_name=' + encodeURIComponent(artist || 'unknown');
    if (opts.album) u += '&album_name=' + encodeURIComponent(opts.album);
    if (opts.duration) u += '&duration=' + Math.round(opts.duration);
    return fetch(u, { headers: { 'Lrclib-Client': 'CoralMusic/1.0' } })
      .then(function (r) { return !!r.ok; })
      .catch(function () { return false; });
  }

  // 纯文本歌词兜底（lyrics.ovh：免 key、CORS 友好，但无时间轴）
  function fetchPlainLyrics(opts) {
    opts = opts || {};
    var title = (opts.title || '').trim();
    var artist = (opts.artist || '').trim();
    if (!title) return Promise.reject(new Error('缺少歌名'));
    var u = 'https://api.lyrics.ovh/v1/' + encodeURIComponent(artist || 'unknown') + '/' + encodeURIComponent(title);
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !j.lyrics) throw new Error('无歌词');
      return String(j.lyrics).replace(/\r/g, '').trim();
    });
  }

  // 纯文本 -> 估算时间轴的 LRC（每行 secondsPerLine 秒），仅用于让纯文本歌词可读、可滚动
  function plainToLrc(text, secondsPerLine) {
    var lines = String(text || '').split(/\n+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.charAt(0) !== '['; });
    var step = secondsPerLine || 4;
    return lines.map(function (t, i) {
      var s = i * step;
      var m = Math.floor(s / 60), ss = s % 60;
      return '[' + (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss + '.00]' + t;
    }).join('\n');
  }

  global.CM = global.CM || {};
  global.CM.Lyrics = {
    parse: parse,
    activeIndex: activeIndex,
    decode: decode,
    fetchLyrics: fetchLyrics,
    fetchPlainLyrics: fetchPlainLyrics,
    plainToLrc: plainToLrc,
    probe: probe,
    searchCandidates: searchCandidates,
    fetchCandidate: fetchCandidate,
    API_BASE: API_BASE
  };
})(window);
