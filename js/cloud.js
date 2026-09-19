/* cloud.js — 云端能力（Cloudflare Pages Functions + R2）
 *
 * 数据流：
 *   口令（本机 localStorage）→ 请求头 X-Coral-Key → 服务端派生空间 slug
 *   音频播放地址 /api/audio/<id>?s=<slug>（同源 → 可走 Web Audio，真频谱与 EQ 生效）
 *   在线音源音频 /api/proxy?s=<slug>&u=<原始直链>（服务端拉流，绕开跨域限制）
 *
 * 降级原则：本地静态服务器（无 /api/*）下所有调用都会失败，
 * 必须给出明确提示且不影响本地播放、上传、歌单等既有功能。
 */
(function (global) {
  'use strict';

  var LS_PASS = 'cm-cloud-pass';
  var LS_SLUG = 'cm-cloud-slug';
  var LS_LAST = 'cm-cloud-last';
  var MIN_PASS = 10;

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {}
  }

  function getPass() { return read(LS_PASS); }
  function setPass(p) {
    write(LS_PASS, String(p == null ? '' : p));
    write(LS_SLUG, '');   // 口令换了就是另一个空间，缓存作废
  }
  function passProblem(p) {
    if (p === undefined) p = getPass();
    p = String(p || '');
    if (!p) return '尚未设置口令';
    if (p.length < MIN_PASS) return '口令至少 ' + MIN_PASS + ' 位';
    if (p.length > 128) return '口令过长';
    return null;
  }
  function hasPass() { return passProblem() === null; }
  function getSlug() { return read(LS_SLUG); }
  function getLastSync() { return Number(read(LS_LAST)) || 0; }
  function markSync(t) { write(LS_LAST, String(t || Date.now())); }

  function randomPass() {
    var alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    var buf = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(buf);
    else for (var i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
    var out = '';
    for (var j = 0; j < 16; j++) {
      out += alphabet[buf[j] % alphabet.length];
      if (j % 4 === 3 && j !== 15) out += '-';
    }
    return out;
  }

  /* 统一请求封装：自动带口令头、解析 JSON 错误 */
  function api(pathname, opts) {
    opts = opts || {};
    var headers = {};
    for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
    var p = getPass();
    if (p) headers['X-Coral-Key'] = p;
    return fetch(pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  function ping() {
    return api('/api/ping').then(function (d) {
      if (d && d.slug) write(LS_SLUG, d.slug);
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

  global.CM = global.CM || {};
  global.CM.Cloud = {
    MIN_PASS: MIN_PASS,
    getPass: getPass, setPass: setPass, passProblem: passProblem, hasPass: hasPass,
    getSlug: getSlug, getLastSync: getLastSync, markSync: markSync, randomPass: randomPass,
    api: api,
    ping: ping, listCloud: listCloud, uploadFile: uploadFile, removeCloud: removeCloud,
    playUrl: playUrl, proxyUrl: proxyUrl,
    pullState: pullState, pushState: pushState
  };
})(window);
