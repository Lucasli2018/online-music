/* online.js — 在线音乐（多音源调度）
 * 统一接口（都作用于「当前音源」）：
 *   search(query, limit) -> [{ sid, id, title, artist, duration, cover, album, playUrl, preview }]
 *   toRecord(item)       -> 曲库记录（source: 'online'）
 *   verify(item)         -> Promise<boolean> 该曲是否真实可播
 * 内置音源：Audius（免 key、完整曲目）；Jamendo / iTunes 由 sources.js 追加注册。
 * 准入原则：必须「免 key（或前端可安全使用的 key）+ CORS 开放 + 可直接播放」。
 */
(function (global) {
  'use strict';

  var API = 'https://api.audius.co/v1';
  var APP = 'CoralMusic';                 // Audius 要求标识调用方
  var LS_KEY = 'cm-audius-apikey';        // 只存 API Key（官方允许放前端）
  var LS_SRC = 'cm-online-source';

  var sources = {};       // id -> { id, name, hint, search, verify, needsConfig, ... }
  var current = 'audius';

  /* ---------- 音源注册表 ---------- */
  function registerSource(def) { if (def && def.id) sources[def.id] = def; }
  function getSources() { return Object.keys(sources).map(function (k) { return sources[k]; }); }
  function setSource(id) {
    if (!sources[id]) return false;
    current = id;
    try { localStorage.setItem(LS_SRC, id); } catch (e) {}
    return true;
  }
  function getSource() { return current; }
  function loadSource() {
    try { var s = localStorage.getItem(LS_SRC); if (s && sources[s]) current = s; } catch (e) {}
  }

  /* ---------- Audius 鉴权（仅 API Key） ---------- */
  function getApiKey() { try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } }
  function setApiKey(k) {
    try { (k && k.trim()) ? localStorage.setItem(LS_KEY, k.trim()) : localStorage.removeItem(LS_KEY); } catch (e) {}
  }
  function authQS() {
    var k = getApiKey();
    return '&app_name=' + APP + (k ? ('&api_key=' + encodeURIComponent(k)) : '');
  }

  /* ---------- 统一入口 ---------- */
  function search(query, limit) {
    var src = sources[current];
    if (!src || !src.search) return Promise.resolve([]);
    return src.search(query, limit || 20);
  }
  function toRecord(item) {
    var sid = item.sid || current;
    // Audius 沿用历史 id 规则（audius-xxx），避免与已入库曲目重复
    var id = (sid === 'audius' ? 'audius-' : 'ol-' + sid + '-') + item.id;
    var rec = {
      id: id,
      title: item.title || '未知标题',
      artist: item.artist || '未知艺术家',
      url: item.playUrl,
      cover: item.cover || '',
      album: item.album || '',
      duration: item.duration || 0,
      preview: !!item.preview,
      sid: sid,
      oid: item.id,
      source: 'online',
      addedAt: Date.now()
    };
    // GD Studio 等需要二次解析的音源：保留歌词 id / 封面 id / 子源，供后续重解析与歌词匹配
    if (item.lyricId) { rec.lid = item.lyricId; rec.lsrc = item.lyricSource || sid; }
    if (item.picId) rec.pid = item.picId;
    if (item.gsub) rec.gsub = item.gsub;
    return rec;
  }
  function verify(item) {
    if (!item) return Promise.resolve(false);
    var src = sources[item.sid || current];
    if (!src) return Promise.resolve(false);
    if (src.verify) return src.verify(item);
    return Promise.resolve(!!item.playUrl);
  }
  // 播放前准备：对需要二次解析的音源（GD Studio）换取真实播放 URL 与封面。
  // 不需要解析的音源（Audius/Jamendo/iTunes）原样返回。
  function prepare(item) {
    if (!item) return Promise.resolve(item);
    var src = sources[item.sid || current];
    if (!src || !src.resolve) return Promise.resolve(item);
    return src.resolve(item).then(function () { return item; });
  }

  /* ---------- 内置音源：Audius ---------- */
  function normalize(t) {
    return {
      sid: 'audius',
      id: t.id,
      title: t.title || '未知标题',
      artist: (t.user && t.user.name) || '未知艺术家',
      duration: t.duration || 0,
      cover: (t.artwork && (t.artwork['480x480'] || t.artwork['150x150'])) || '',
      album: '',
      genre: t.genre || '',
      playUrl: streamUrl(t.id),
      preview: false
    };
  }
  function streamUrl(id) {
    return API + '/tracks/' + encodeURIComponent(id) + '/stream?app_name=' + APP;
  }
  function audiusSearch(query, limit) {
    var q = (query || '').trim();
    if (!q) return Promise.resolve([]);
    var u = API + '/tracks/search?query=' + encodeURIComponent(q) + authQS() + '&limit=' + (limit || 20);
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var list = (j && j.data) || [];
      return list
        .filter(function (t) { return t && t.id && t.is_streamable !== false && !t.is_stream_gated; })
        .map(normalize);
    });
  }
  function audiusVerify(item) {
    if (!item || !item.id) return Promise.resolve(false);
    return fetch(API + '/tracks/' + encodeURIComponent(item.id) + '?' + authQS().slice(1))
      .then(function (r) { return !!r.ok; })
      .catch(function () { return false; });
  }

  registerSource({
    id: 'audius',
    name: 'Audius',
    hint: '免 key · 完整曲目 · 支持登录',
    search: audiusSearch,
    verify: audiusVerify
  });

  global.CM = global.CM || {};
  global.CM.Online = {
    registerSource: registerSource,
    getSources: getSources,
    setSource: setSource,
    getSource: getSource,
    loadSource: loadSource,
    search: search,
    toRecord: toRecord,
    verify: verify,
    prepare: prepare,
    normalize: normalize,
    streamUrl: streamUrl,
    getApiKey: getApiKey,
    setApiKey: setApiKey,
    base: API,
    app: APP
  };
})(window);
