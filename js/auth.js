/* auth.js — Audius OAuth 2.0（Authorization Code + PKCE，纯前端，不依赖官方 SDK）
 * 用途：让用户用 Audius 账号登录，授权后以本人身份读取资料 / 自己的曲目。
 *
 * 关键事实（2026-09-19 实测）：
 *  - token 端点 https://api.audius.co/v1/oauth/token 支持浏览器跨域 POST（返回标准 OAuth 错误体）。
 *  - client_id = Audius API Key（官方允许放在前端代码里）。
 *  - 必须把「线上域名」登记进 Audius 开发者后台的 Redirect URI 白名单；
 *    本项目线上为 https://online-music.pages.dev/ （本地 localhost 不在白名单，无法完成真实授权）。
 *  - Bearer Token（app 级）属后端专用，本文件不使用也不存储它。
 */
(function (global) {
  'use strict';

  var AUTH_URL = 'https://api.audius.co/v1/oauth/authorize';
  var TOKEN_URL = 'https://api.audius.co/v1/oauth/token';
  var API = 'https://api.audius.co/v1';
  var LS_TOKEN = 'cm-audius-token';
  var SS_VERIFIER = 'cm-oauth-verifier';
  var SS_STATE = 'cm-oauth-state';
  var SCOPE = 'read';

  function b64url(bytes) {
    var u8 = new Uint8Array(bytes), s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomB64(n) {
    var buf = new Uint8Array(n);
    (global.crypto || global.msCrypto).getRandomValues(buf);
    return b64url(buf);
  }
  // S256: code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
  function challengeOf(verifier) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error('需要 HTTPS 环境（Web Crypto 不可用）'));
    }
    var data = new global.TextEncoder().encode(verifier);
    return global.crypto.subtle.digest('SHA-256', data).then(b64url);
  }

  // redirect_uri 动态取当前站点根（线上须与后台登记值完全一致）
  function redirectUri() {
    return global.location.origin + global.location.pathname.replace(/index\.html$/, '');
  }
  function apiKey() {
    try { return (global.CM && CM.Online && CM.Online.getApiKey) ? (CM.Online.getApiKey() || '') : ''; }
    catch (e) { return ''; }
  }

  function saveToken(d) {
    var t = {
      accessToken: d.access_token || '',
      refreshToken: d.refresh_token || '',
      expiresIn: d.expires_in || 0,
      tokenType: d.token_type || 'Bearer',
      obtainedAt: Date.now()
    };
    try { localStorage.setItem(LS_TOKEN, JSON.stringify(t)); } catch (e) {}
    return t;
  }
  function getToken() { try { return JSON.parse(localStorage.getItem(LS_TOKEN) || 'null'); } catch (e) { return null; } }
  function clearToken() { try { localStorage.removeItem(LS_TOKEN); } catch (e) {} }
  function isLoggedIn() { var t = getToken(); return !!(t && t.accessToken); }
  function isExpired() {
    var t = getToken();
    if (!t || !t.accessToken) return true;
    if (!t.expiresIn) return false;
    return Date.now() > (t.obtainedAt + (t.expiresIn - 60) * 1000);
  }

  // 构造授权 URL（抽出来便于单测）
  function buildAuthorizeUrl(verifier, state, challenge) {
    return AUTH_URL +
      '?client_id=' + encodeURIComponent(apiKey()) +
      '&redirect_uri=' + encodeURIComponent(redirectUri()) +
      '&response_type=code' +
      '&code_challenge=' + encodeURIComponent(challenge) +
      '&code_challenge_method=S256' +
      '&scope=' + SCOPE +
      '&state=' + encodeURIComponent(state);
  }

  // 1) 发起登录（整页跳转）
  function login() {
    if (!apiKey()) return Promise.reject(new Error('请先填写 Audius API Key'));
    var verifier = randomB64(32);   // 43 字符，符合 RFC7636
    var state = randomB64(16);
    try {
      sessionStorage.setItem(SS_VERIFIER, verifier);
      sessionStorage.setItem(SS_STATE, state);
    } catch (e) {}
    return challengeOf(verifier).then(function (challenge) {
      var u = buildAuthorizeUrl(verifier, state, challenge);
      global.location.href = u;
      return u;
    });
  }

  function postToken(params) {
    return fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j || !j.access_token) {
          throw new Error((j && (j.error_description || j.error)) || ('HTTP ' + r.status));
        }
        return saveToken(j);
      });
    });
  }

  // 2) 处理回调（页面带 ?code=&state= 时）
  function handleRedirect() {
    var q;
    try { q = new URLSearchParams(global.location.search); } catch (e) { return Promise.resolve(null); }
    var code = q.get('code'), state = q.get('state'), err = q.get('error');
    if (!code && !err) return Promise.resolve(null);

    var saved = '', savedState = '';
    try {
      saved = sessionStorage.getItem(SS_VERIFIER) || '';
      savedState = sessionStorage.getItem(SS_STATE) || '';
    } catch (e) {}

    function cleanupUrl() {
      try { global.history.replaceState({}, document.title, global.location.origin + global.location.pathname); } catch (e) {}
    }
    function clearSession() {
      try { sessionStorage.removeItem(SS_VERIFIER); sessionStorage.removeItem(SS_STATE); } catch (e) {}
    }

    if (err) { cleanupUrl(); clearSession(); return Promise.reject(new Error(err)); }
    if (!saved) { cleanupUrl(); return Promise.reject(new Error('登录会话已过期，请重新点击「连接 Audius 账号」')); }
    if (savedState && state !== savedState) { cleanupUrl(); clearSession(); return Promise.reject(new Error('state 校验失败，已中止')); }

    return postToken({
      grant_type: 'authorization_code',
      code: code,
      code_verifier: saved,
      client_id: apiKey(),
      redirect_uri: redirectUri()
    }).then(function (t) { cleanupUrl(); clearSession(); return t; },
            function (e) { cleanupUrl(); clearSession(); throw e; });
  }

  // 3) 刷新（有 refresh_token 时）
  function refresh() {
    var t = getToken();
    if (!t || !t.refreshToken) return Promise.reject(new Error('无 refresh_token'));
    return postToken({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: apiKey(),
      redirect_uri: redirectUri()
    });
  }

  function authedFetch(url) {
    var t = getToken();
    if (!t || !t.accessToken) return Promise.reject(new Error('未登录'));
    return fetch(url, { headers: { Authorization: 'Bearer ' + t.accessToken } });
  }

  // 4) 当前账号资料
  function fetchMe() {
    return authedFetch(API + '/users/me?app_name=CoralMusic')
      .then(function (r) {
        if (r.status === 401) { clearToken(); throw new Error('登录已失效，请重新连接'); }
        return r.json();
      })
      .then(function (j) { return (j && j.data) || null; });
  }

  // 5) 我的曲目（归一化交给 CM.Online.normalize 复用）
  function myTracks(limit) {
    return fetchMe().then(function (me) {
      if (!me || !me.id) throw new Error('无法获取账号信息');
      return fetch(API + '/users/' + encodeURIComponent(me.id) + '/tracks?app_name=CoralMusic&limit=' + (limit || 50))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var list = (j && j.data) || [];
          var norm = (global.CM && CM.Online && CM.Online.normalize) || function (t) { return t; };
          return list
            .filter(function (t) { return t && t.id && t.is_streamable !== false; })
            .map(norm);
        });
    });
  }

  global.CM = global.CM || {};
  global.CM.Auth = {
    login: login,
    handleRedirect: handleRedirect,
    refresh: refresh,
    getToken: getToken,
    clearToken: clearToken,
    isLoggedIn: isLoggedIn,
    isExpired: isExpired,
    fetchMe: fetchMe,
    myTracks: myTracks,
    authedFetch: authedFetch,
    redirectUri: redirectUri,
    challengeOf: challengeOf,
    buildAuthorizeUrl: buildAuthorizeUrl,
    AUTH_URL: AUTH_URL,
    TOKEN_URL: TOKEN_URL
  };
})(window);
