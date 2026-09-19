/* sources.js — 追加在线音源（GD Studio / Jamendo / iTunes）
 * 依赖 online.js 暴露的 CM.Online.registerSource；必须在 online.js 之后加载。
 *  - GD Studio（GD音乐台）：免 key、聚合 netease/kuwo/tencent/joox 等多平台曲库，
 *    搜索返回曲目元数据，播放 URL / 封面 / 歌词需按 id 二次解析（CORS 开放，可前端直连）
 *  - Jamendo：CC 授权完整曲目，需要在 jamendo.com 免费注册后填 Client ID（前端可用）
 *  - iTunes / Apple Music：免 key、曲库最全，但只提供 30 秒试听（previewUrl）
 */
(function (global) {
  'use strict';

  var CM = global.CM;
  if (!CM || !CM.Online || !CM.Online.registerSource) return;

  var LS_JAM = 'cm-jamendo-clientid';
  var LS_GD = 'cm-gd-source';

  function getJamendoId() { try { return localStorage.getItem(LS_JAM) || ''; } catch (e) { return ''; } }
  function setJamendoId(v) {
    try { (v && v.trim()) ? localStorage.setItem(LS_JAM, v.trim()) : localStorage.removeItem(LS_JAM); } catch (e) {}
  }

  /* ---------- GD Studio（GD音乐台，聚合多平台） ----------
   * API 文档：https://music-api.gdstudio.xyz/api.php
   * search -> [{id,name,artist[],album,pic_id,lyric_id,source}]
   * url    -> {url,br,size}   pic -> 返回图片 URL 文本   lyric -> {lyric,tlyric}
   * 频率限制（动态更新）：5 分钟内不超 50 次
   */
  var GD_BASE = 'https://music-api.gdstudio.xyz/api.php';
  var GD_SUBS = ['netease', 'kuwo', 'tencent', 'joox', 'bilibili', 'tidal', 'qobuz', 'apple', 'ytmusic', 'spotify'];

  function getGdSub() {
    try {
      var s = localStorage.getItem(LS_GD);
      return (s && GD_SUBS.indexOf(s) >= 0) ? s : 'netease';
    } catch (e) { return 'netease'; }
  }
  function setGdSub(v) {
    try {
      v = (v || '').trim().toLowerCase();
      (GD_SUBS.indexOf(v) >= 0) ? localStorage.setItem(LS_GD, v) : localStorage.removeItem(LS_GD);
    } catch (e) {}
  }
  function gdApi(params) {
    var qs = Object.keys(params).map(function (k) {
      return k + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return fetch(GD_BASE + '?' + qs).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      try { return JSON.parse(text); } catch (e) { return text; } // pic 端点直接返回 URL 文本
    });
  }

  // 二次解析：播放 URL + 封面（搜索结果不直接带，需按 id 换取）
  function gdResolve(item) {
    var sub = item.gsub || getGdSub();
    return gdApi({ types: 'url', source: sub, id: item.id, br: '320' }).then(function (j) {
      var url = j && j.url;
      if (!url) throw new Error('无播放链接');
      item.playUrl = url;
      if (item.picId) {
        return gdApi({ types: 'pic', source: sub, id: item.picId, size: '300' }).then(function (pic) {
          if (typeof pic === 'string' && pic.indexOf('http') === 0) item.cover = pic;
          return item;
        }).catch(function () { return item; }); // 封面失败不影响播放
      }
      return item;
    });
  }

  CM.Online.registerSource({
    id: 'gdstudio',
    name: 'GD 音乐台',
    hint: '免 key · 全曲库 · 多平台音源',
    needsConfig: true,
    configLabel: 'GD 音源平台',
    configHint: '可选：netease（默认）/ kuwo / tencent / joox / bilibili / tidal / qobuz / apple / ytmusic / spotify。频率限制：5 分钟内不超 50 次',
    getConfig: getGdSub,
    setConfig: setGdSub,
    search: function (query, limit) {
      return gdApi({
        types: 'search', source: getGdSub(),
        name: query, count: limit || 20, pages: '1'
      }).then(function (list) {
        if (!Array.isArray(list)) throw new Error('搜索失败');
        return list.filter(function (t) { return t && t.id; }).map(function (t) {
          return {
            sid: 'gdstudio',
            id: String(t.id),
            title: t.name || '未知标题',
            artist: Array.isArray(t.artist) ? t.artist.join(' / ') : (t.artist || '未知艺术家'),
            duration: 0,               // search 端点不返回时长
            cover: '',
            album: t.album || '',
            genre: '',
            playUrl: '',
            preview: false,
            needsResolve: true,        // 播放前需二次解析 URL
            lyricId: t.lyric_id || t.id,
            lyricSource: getGdSub(),
            picId: t.pic_id || '',
            gsub: getGdSub()
          };
        });
      });
    },
    resolve: gdResolve,
    verify: function (item) {
      return gdResolve(item).then(function () { return true; }).catch(function () { return false; });
    }
  });

  /* ---------- Jamendo（CC 音乐，完整曲目） ---------- */
  CM.Online.registerSource({
    id: 'jamendo',
    name: 'Jamendo',
    hint: 'CC 音乐 · 完整曲目 · 需 Client ID',
    needsConfig: true,
    configLabel: 'Jamendo Client ID',
    configHint: '在 jamendo.com 免费注册开发者后获得（可安全放在前端）',
    getConfig: getJamendoId,
    setConfig: setJamendoId,
    search: function (query, limit) {
      var cid = getJamendoId();
      if (!cid) return Promise.reject(new Error('请先填写 Jamendo Client ID'));
      var u = 'https://api.jamendo.com/v3.0/tracks/?client_id=' + encodeURIComponent(cid) +
              '&format=json&limit=' + (limit || 20) +
              '&audioformat=mp31&search=' + encodeURIComponent(query);
      return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.headers && j.headers.status === 'failed') {
          throw new Error(j.headers.error_message || 'Jamendo 请求失败');
        }
        var list = (j && j.results) || [];
        return list.filter(function (t) { return t && t.audio; }).map(function (t) {
          return {
            sid: 'jamendo',
            id: String(t.id),
            title: t.name || '未知标题',
            artist: t.artist_name || '未知艺术家',
            duration: parseInt(t.duration, 10) || 0,
            cover: t.image || '',
            album: t.album_name || '',
            genre: (t.musicinfo && t.musicinfo.tags && t.musicinfo.tags.genres && t.musicinfo.tags.genres[0]) || '',
            playUrl: t.audio,
            preview: false
          };
        });
      });
    }
  });

  /* ---------- iTunes / Apple Music（免 key，30 秒试听） ---------- */
  CM.Online.registerSource({
    id: 'itunes',
    name: 'iTunes 试听',
    hint: '免 key · 曲库最全 · 30 秒试听',
    search: function (query, limit) {
      var u = 'https://itunes.apple.com/search?media=music&entity=song&limit=' + (limit || 20) +
              '&term=' + encodeURIComponent(query);
      return fetch(u).then(function (r) { return r.json(); }).then(function (j) {
        var list = (j && j.results) || [];
        return list.filter(function (t) { return t && t.previewUrl; }).map(function (t) {
          return {
            sid: 'itunes',
            id: String(t.trackId),
            title: t.trackName || '未知标题',
            artist: t.artistName || '未知艺术家',
            duration: Math.round((t.trackTimeMillis || 0) / 1000),
            cover: (t.artworkUrl100 || '').replace('100x100', '300x300'),
            album: t.collectionName || '',
            genre: t.primaryGenreName || '',
            playUrl: t.previewUrl,
            preview: true            // 仅 30 秒试听
          };
        });
      });
    }
  });
})(window);
