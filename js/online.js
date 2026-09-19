/* online.js — 在线音乐音源（Audius）
 * 免 key、CORS 友好的公共音乐流媒体 API，可搜索并直接播放完整曲目。
 *  - 搜索：GET https://api.audius.co/v1/tracks/search?query=&app_name=&limit=
 *  - 播放：GET https://api.audius.co/v1/tracks/{id}/stream?app_name=   （302 → CDN，<audio> 直连可播）
 *  - 封面：track.artwork['480x480']
 * 说明：Audius 为境外服务，需联网；不可流式的曲目会被过滤掉。
 */
(function (global) {
  'use strict';

  var BASE = 'https://api.audius.co/v1';
  var APP = 'CoralMusic';   // Audius 要求标识调用方（无需注册，仅用于统计）
  var PAGE = 20;

  function streamUrl(id) {
    return BASE + '/tracks/' + encodeURIComponent(id) + '/stream?app_name=' + APP;
  }

  function normalize(t) {
    return {
      aid: t.id,
      title: t.title || '未知标题',
      artist: (t.user && t.user.name) || '未知艺术家',
      duration: t.duration || 0,
      cover: (t.artwork && (t.artwork['480x480'] || t.artwork['150x150'])) || '',
      genre: t.genre || '',
      playCount: t.play_count || 0
    };
  }

  // 关键词搜索，仅保留可流式播放的曲目
  function search(query, limit) {
    var q = (query || '').trim();
    if (!q) return Promise.resolve([]);
    var u = BASE + '/tracks/search?query=' + encodeURIComponent(q) +
            '&app_name=' + APP + '&limit=' + (limit || PAGE);
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var list = (j && j.data) || [];
      return list
        .filter(function (t) { return t && t.id && t.is_streamable !== false; })
        .map(normalize);
    });
  }

  // 归一化结果 -> 曲库记录（id 稳定，重复添加不会产生重复项）
  function toRecord(item) {
    return {
      id: 'audius-' + item.aid,
      title: item.title,
      artist: item.artist,
      url: streamUrl(item.aid),
      audiusId: item.aid,
      cover: item.cover || '',
      album: '',
      duration: item.duration || 0,
      source: 'online',
      addedAt: Date.now()
    };
  }

  global.CM = global.CM || {};
  global.CM.Online = { search: search, streamUrl: streamUrl, toRecord: toRecord, base: BASE, app: APP };
})(window);
