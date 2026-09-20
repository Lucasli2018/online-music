/* cloud.js — 云端能力（Cloudflare Pages Functions + R2）
 *
 * 数据流：
 *   账号会话（localStorage 里的 Bearer token）→ 请求头 Authorization → 服务端按账号查 space_slug
 *   音频播放地址 /api/audio/<id>?s=<slug>（同源 → 可走 Web Audio，真频谱与 EQ 生效）
 *   在线音源音频 /api/proxy?s=<slug>&u=<原始直链>（服务端拉流，绕开跨域限制）
 *
 * 与旧版的差别：不再有「同步口令」。登录态由 CM.Account 统一持有，本模块只负责
 * 「拿着当前账号去云端做事」；未登录时所有写操作会在前端直接被拦下，不会白发请求。
 *
 * 降级原则：本地静态服务器（无 /api/*）下所有调用都会失败，
 * 必须给出明确提示且不影响本地播放、上传、歌单等既有功能。
 */
(function (global) {
  'use strict';

  var LS_SLUG = 'cm-cloud-slug';   // 空间标识缓存：<audio src> 要用，避免每首歌都等一次接口
  var LS_LAST = 'cm-cloud-last';   // 上次同步时间

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {}
  }

  function account() { return (global.CM && CM.Account) || null; }

  function isLoggedIn() { var a = account(); return !!(a && a.isLoggedIn()); }
  function currentUser() { var a = account(); return (a && a.user()) || null; }

  // 空间标识优先取账号里的（权威），退回本地缓存（离线/接口不可用时仍能拼出播放地址）
  function getSlug() {
    var u = currentUser();
    if (u && u.spaceSlug) { write(LS_SLUG, u.spaceSlug); return u.spaceSlug; }
    return read(LS_SLUG);
  }
  function clearSlug() { write(LS_SLUG, ''); }

  function getLastSync() { return Number(read(LS_LAST)) || 0; }
  function markSync(t) { write(LS_LAST, String(t || Date.now())); }

  /* 请求走 CM.Account.api，令牌与 401 失效处理都在那边统一收口 */
  function api(pathname, opts) {
    var a = account();
    if (!a) return Promise.reject(new Error('账号模块未加载'));
    return a.api(pathname, opts);
  }

  function ping() {
    return api('/api/ping').then(function (d) {
      if (d && d.user && d.user.spaceSlug) write(LS_SLUG, d.user.spaceSlug);
      return d;
    });
  }
  function listCloud() {
    return api('/api/audio').then(function (d) {
      if (d && d.slug) write(LS_SLUG, d.slug);
      return d;
    });
  }
  function uploadFile(file, meta) {
    var fd = new FormData();
    fd.append('file', file, file.name || 'audio.mp3');
    if (meta && meta.id) fd.append('id', meta.id);
    if (meta && meta.title) fd.append('title', meta.title);
    if (meta && meta.artist) fd.append('artist', meta.artist);
    return api('/api/audio', { method: 'POST', body: fd });
  }
  function removeCloud(id) {
    return api('/api/audio/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  /* 播放地址：<audio src> 无法带请求头，故用 ?s=<slug> 作读凭据 */
  function playUrl(id) {
    var s = getSlug();
    return '/api/audio/' + encodeURIComponent(id) + (s ? '?s=' + s : '');
  }
  /* 在线音频代理地址（服务端拉流 → 同源 → 可做真实频谱分析） */
  function proxyUrl(u) {
    var s = getSlug();
    if (!s || !u) return u;
    if (u.indexOf('/api/') === 0) return u;             // 已是站内地址
    return '/api/proxy?s=' + s + '&u=' + encodeURIComponent(u);
  }

  function pullState() { return api('/api/state'); }
  function pushState(state) {
    return api('/api/state', { method: 'PUT', body: JSON.stringify({ state: state }) })
      .then(function (d) { markSync(d && d.updatedAt ? d.updatedAt : Date.now()); return d; });
  }

  /* 旧「同步口令」空间的数据接管：登录后调用，见 js/account.js 的 CM.Account.adopt */
  function adoptOldPass(oldPass, onProgress) {
    var a = account();
    if (!a) return Promise.reject(new Error('账号模块未加载'));
    return a.adopt(oldPass, onProgress).then(function (r) {
      clearSlug();     // 让下次 getSlug() 重新按账号取，避免继续用旧的缓存值
      if (a.refresh) return a.refresh().then(function () { return r; }, function () { return r; });
      return r;
    });
  }

  global.CM = global.CM || {};
  global.CM.Cloud = {
    isLoggedIn: isLoggedIn, currentUser: currentUser,
    getSlug: getSlug, clearSlug: clearSlug, getLastSync: getLastSync, markSync: markSync,
    api: api,
    ping: ping, listCloud: listCloud, uploadFile: uploadFile, removeCloud: removeCloud,
    playUrl: playUrl, proxyUrl: proxyUrl,
    pullState: pullState, pushState: pushState,
    adoptOldPass: adoptOldPass
  };
})(window);
