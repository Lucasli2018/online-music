/* account.js — 珊瑚音乐账号体系（注册 / 登录 / 会话 / 旧口令空间接管）
 *
 * 与 CM.Auth 的分工（名字很像，别搞混）：
 *   CM.Auth    —— Audius 第三方 OAuth，用于「按 Audius 账号取在线曲目」，与本站账号无关。
 *   CM.Account —— 本站自己的账号密码登录，决定云端曲库/歌单属于谁，也就是本文件。
 *
 * 会话怎么存的：服务端发一枚 Bearer token，前端放 localStorage，之后所有 /api 写操作
 * 都带 Authorization: Bearer <token>。token 本身不等于密码，服务端可随时删除让它失效。
 * 刻意不把密码或派生值留在本地 —— 本地只留 token + 一份用于渲染界面的用户信息。
 */
(function (global) {
  'use strict';

  var LS_TOKEN = 'cm-account-token';
  var LS_USER = 'cm-account-user';

  var USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
  var MIN_PASSWORD = 8;
  var MAX_PASSWORD = 128;

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {}
  }

  /* ---------- 本地状态 ---------- */
  function token() { return read(LS_TOKEN); }
  function user() {
    try { return JSON.parse(read(LS_USER) || 'null'); } catch (e) { return null; }
  }
  function isLoggedIn() { return !!token(); }

  function save(token_, user_) {
    write(LS_TOKEN, token_ || '');
    write(LS_USER, user_ ? JSON.stringify(user_) : '');
  }
  function clear() { save('', null); }

  /* ---------- 输入校验（与后端 _lib/account.mjs 同规则，前端先拦一道给即时反馈） ---------- */
  function normalizeUsername(u) { return String(u == null ? '' : u).trim().toLowerCase(); }

  function usernameProblem(u) {
    var name = normalizeUsername(u);
    if (!name) return '请填写用户名';
    if (!USERNAME_RE.test(name)) return '用户名需 3-24 位，仅限小写字母、数字、下划线、连字符';
    return null;
  }
  function passwordProblem(p) {
    var s = String(p == null ? '' : p);
    if (!s) return '请填写密码';
    if (s.length < MIN_PASSWORD) return '密码至少 ' + MIN_PASSWORD + ' 位';
    if (s.length > MAX_PASSWORD) return '密码过长（上限 ' + MAX_PASSWORD + ' 位）';
    return null;
  }

  /* ---------- 请求封装 ---------- */
  // auth=true 时带上令牌；401 一律视为「会话已失效」并清空本地状态，
  // 让 UI 自然地回到未登录态，而不是反复弹「请求失败」。
  function api(pathname, opts) {
    opts = opts || {};
    var headers = {};
    for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
    if (opts.auth !== false) {
      var t = token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
    }
    return fetch(pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!r.ok) {
          if (r.status === 401 && opts.auth !== false) clear();
          var err = new Error((data && data.error) || ('HTTP ' + r.status));
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- 注册 / 登录 / 登出 ---------- */
  function register(username, password, displayName) {
    var badU = usernameProblem(username);
    if (badU) return Promise.reject(new Error(badU));
    var badP = passwordProblem(password);
    if (badP) return Promise.reject(new Error(badP));
    return api('/api/auth/register', {
      method: 'POST',
      auth: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: normalizeUsername(username),
        password: password,
        displayName: String(displayName || '').trim()
      })
    }).then(function (d) {
      save(d && d.token, d && d.user);
      return (d && d.user) || null;
    });
  }

  function login(username, password) {
    return api('/api/auth/login', {
      method: 'POST',
      auth: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: normalizeUsername(username),
        password: String(password == null ? '' : password)
      })
    }).then(function (d) {
      save(d && d.token, d && d.user);
      return (d && d.user) || null;
    });
  }

  function logout() {
    var had = token();
    clear();
    if (!had) return Promise.resolve(true);
    // 先清本地再通知服务端：即使网络挂了，用户在本机也已经退出
    return api('/api/auth/logout', { method: 'POST', auth: false, headers: { Authorization: 'Bearer ' + had } })
      .then(function () { return true; }, function () { return true; });
  }

  /* 启动时用本地 token 换一次账号信息：既验证会话是否还有效，也把最新的
     spaceSlug 拿回来（cloud.js 的播放地址依赖它）。 */
  function refresh() {
    if (!token()) return Promise.resolve(null);
    return api('/api/auth/me').then(function (d) {
      if (d && d.user) {
        save(token(), d.user);
        return d;
      }
      return null;
    }).catch(function (e) {
      // 401 已在 api() 里清空；网络类错误就不动本地状态，等下次再试
      if (e && e.status === 401) return null;
      return { user: user(), offline: true };
    });
  }

  /* ---------- 接管旧口令空间 ---------- */
  // 逐批搬运，直到服务端说 done。onProgress 用于给用户看到「搬了多少」。
  function adopt(oldPass, onProgress, batch) {
    var pass = String(oldPass == null ? '' : oldPass);
    if (pass.length < 10) return Promise.reject(new Error('旧口令至少 10 位'));
    if (!isLoggedIn()) return Promise.reject(new Error('请先登录账号'));

    var size = batch || 20;
    var round = 0;
    var total = { copied: 0, skipped: 0, total: 0, state: 'skipped', rounds: 0, done: false };

    function step() {
      round++;
      if (round > 60) { total.done = false; return Promise.resolve(total); }  // 兜底：最多 60 轮（1200 个文件）
      return api('/api/auth/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPass: pass, batch: size })
      }).then(function (d) {
        d = d || {};
        total.copied += d.copied || 0;
        total.skipped += d.skipped || 0;
        total.total = d.total || total.total;
        total.rounds = round;
        if (d.state && d.state !== 'skipped') total.state = d.state;
        total.message = d.message || total.message;
        total.done = !!d.done;
        if (onProgress) onProgress(total);
        return total.done ? total : step();
      });
    }
    return step();
  }

  global.CM = global.CM || {};
  global.CM.Account = {
    MIN_PASSWORD: MIN_PASSWORD,
    token: token,
    user: user,
    isLoggedIn: isLoggedIn,
    save: save,
    clear: clear,
    api: api,
    register: register,
    login: login,
    logout: logout,
    refresh: refresh,
    adopt: adopt,
    normalizeUsername: normalizeUsername,
    usernameProblem: usernameProblem,
    passwordProblem: passwordProblem
  };
})(window);
