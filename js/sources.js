/* sources.js — 追加在线音源（Jamendo / iTunes）
 * 依赖 online.js 暴露的 CM.Online.registerSource；必须在 online.js 之后加载。
 * 两者均满足「CORS 开放 + 可直接播放」：
 *  - Jamendo：CC 授权完整曲目，需要在 jamendo.com 免费注册后填 Client ID（前端可用）
 *  - iTunes / Apple Music：免 key、曲库最全，但只提供 30 秒试听（previewUrl）
 */
(function (global) {
  'use strict';

  var CM = global.CM;
  if (!CM || !CM.Online || !CM.Online.registerSource) return;

  var LS_JAM = 'cm-jamendo-clientid';

  function getJamendoId() { try { return localStorage.getItem(LS_JAM) || ''; } catch (e) { return ''; } }
  function setJamendoId(v) {
    try { (v && v.trim()) ? localStorage.setItem(LS_JAM, v.trim()) : localStorage.removeItem(LS_JAM); } catch (e) {}
  }

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
