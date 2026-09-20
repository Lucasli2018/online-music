/* tests/account.test.js — 前端账号模块（js/account.js）
 * 覆盖输入校验、注册/登录/登出的本地状态变迁、会话失效处理、
 * 以及「401 一律清空本地登录态」这条贯穿所有请求的约定。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

var TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
var USER = { id: 7, username: 'lucas', displayName: '领主', spaceSlug: '0123456789abcdef0123' };

function load(routes, storage) {
  var f = helpers.mockFetch(routes || []);
  var cm = helpers.loadCM(['account.js'], { fetch: f, storage: storage });
  return { A: cm.Account, fetch: f };
}

/* ---------- 输入校验（前端先拦一道，给即时反馈） ---------- */

test('usernameProblem：不合格的用户名各有明确文案', function () {
  assert.strictEqual(load().A.usernameProblem(''), '请填写用户名');
  assert.match(load().A.usernameProblem('ab'), /3-24/);
  assert.match(load().A.usernameProblem('a'.repeat(25)), /3-24/);
  assert.match(load().A.usernameProblem('中文名'), /小写字母/);
  assert.match(load().A.usernameProblem('lucas!'), /小写字母/);
  assert.strictEqual(load().A.usernameProblem('Lucas'), null, '规范化为小写后合法');
  assert.strictEqual(load().A.usernameProblem('lucas'), null);
  assert.strictEqual(load().A.usernameProblem('lucas_01-x'), null);
});

test('normalizeUsername：去空白并统一小写', function () {
  var A = load().A;
  assert.strictEqual(A.normalizeUsername('  Lucas  '), 'lucas');
  assert.strictEqual(A.normalizeUsername(null), '');
});

test('用户名校验前会先规范化，所以「 Lucas 」可以通过', function () {
  assert.strictEqual(load().A.usernameProblem('  Lucas  '), null);
});

test('passwordProblem：只卡长度，不搞「必须含符号」那套', function () {
  var A = load().A;
  assert.strictEqual(A.passwordProblem(''), '请填写密码');
  assert.match(A.passwordProblem('1234567'), /至少 8 位/);
  assert.strictEqual(A.passwordProblem('12345678'), null);
  assert.strictEqual(A.passwordProblem('全是中文的密码也很长'), null);
  assert.match(A.passwordProblem('x'.repeat(129)), /过长/);
});

/* ---------- 注册 / 登录 ---------- */

test('register：提交规范化用户名，成功后落本地令牌', async function () {
  var c = load([[/\/api\/auth\/register/, function () {
    return helpers.jsonResponse({ ok: true, token: TOKEN, user: USER }, 201);
  }]]);
  var u = await c.A.register('  Lucas ', 'supersecret', '领主');
  assert.strictEqual(u.username, 'lucas');
  assert.strictEqual(c.A.isLoggedIn(), true);
  assert.strictEqual(c.A.token(), TOKEN);
  assert.strictEqual(c.A.user().spaceSlug, USER.spaceSlug);

  var body = JSON.parse(c.fetch.bodyOf(0));
  assert.strictEqual(body.username, 'lucas');
  assert.strictEqual(body.password, 'supersecret');
  assert.strictEqual(body.displayName, '领主');
  assert.strictEqual(c.fetch.methodOf(0), 'POST');
});

test('register：本地校验失败时不发请求', async function () {
  var c = load();
  await assert.rejects(function () { return c.A.register('ab', 'supersecret'); }, function (e) {
    assert.match(e.message, /3-24/);
    return true;
  });
  await assert.rejects(function () { return c.A.register('lucas', 'short'); }, function (e) {
    assert.match(e.message, /至少 8 位/);
    return true;
  });
  assert.strictEqual(c.fetch.calls.length, 0);
});

test('register：服务端 409 时不落任何本地登录态', async function () {
  var c = load([[/\/api\/auth\/register/, function () {
    return helpers.jsonResponse({ error: '该用户名已被注册' }, 409);
  }]]);
  await assert.rejects(function () { return c.A.register('lucas', 'supersecret'); }, function (e) {
    assert.strictEqual(e.message, '该用户名已被注册');
    assert.strictEqual(e.status, 409);
    return true;
  });
  assert.strictEqual(c.A.isLoggedIn(), false);
});

test('login：成功后落本地令牌与用户', async function () {
  var c = load([[/\/api\/auth\/login/, function () {
    return helpers.jsonResponse({ ok: true, token: TOKEN, user: USER });
  }]]);
  var u = await c.A.login('LUCAS', 'supersecret');
  assert.strictEqual(u.displayName, '领主');
  assert.strictEqual(c.A.token(), TOKEN);
});

test('login：密码错误时透传服务端文案，且不写令牌', async function () {
  var c = load([[/\/api\/auth\/login/, function () {
    return helpers.jsonResponse({ error: '用户名或密码不正确' }, 401);
  }]]);
  await assert.rejects(function () { return c.A.login('lucas', 'wrongpass'); }, function (e) {
    assert.strictEqual(e.message, '用户名或密码不正确');
    return true;
  });
  assert.strictEqual(c.A.isLoggedIn(), false);
});

test('login：限流时给出可操作的提示', async function () {
  var c = load([[/\/api\/auth\/login/, function () {
    return helpers.jsonResponse({ error: '失败次数过多，请稍后再试' }, 429);
  }]]);
  await assert.rejects(function () { return c.A.login('lucas', 'x'.repeat(9)); }, function (e) {
    assert.strictEqual(e.status, 429);
    return true;
  });
});

/* ---------- 登出 ---------- */

test('logout：清本地状态并向服务端作废令牌', async function () {
  var c = load([[/\/api\/auth\/logout/, function () { return helpers.jsonResponse({ ok: true }); }]]);
  c.A.save(TOKEN, USER);
  await c.A.logout();
  assert.strictEqual(c.A.isLoggedIn(), false);
  assert.strictEqual(c.A.user(), null);
  assert.strictEqual(c.fetch.calls[0], '/api/auth/logout');
  assert.strictEqual(c.fetch.headerOf(0, 'Authorization'), 'Bearer ' + TOKEN);
});

test('logout：网络失败也不影响本地已退出的事实', async function () {
  var c = load([[/\/api\/auth\/logout/, function () {
    return { ok: false, status: 500, text: function () { return Promise.resolve('boom'); } };
  }]]);
  c.A.save(TOKEN, USER);
  await c.A.logout();
  assert.strictEqual(c.A.isLoggedIn(), false);
});

test('logout：本来就没登录时不发请求', async function () {
  var c = load();
  await c.A.logout();
  assert.strictEqual(c.fetch.calls.length, 0);
});

/* ---------- refresh（启动时验证会话） ---------- */

test('refresh：成功则刷新用户信息', async function () {
  var moved = Object.assign({}, USER, { spaceSlug: 'ffffffffffffffffffff' });
  var c = load([[/\/api\/auth\/me/, function () {
    return helpers.jsonResponse({ ok: true, user: moved, cloudTracks: 3 });
  }]]);
  c.A.save(TOKEN, USER);
  var d = await c.A.refresh();
  assert.strictEqual(d.cloudTracks, 3);
  assert.strictEqual(c.A.user().spaceSlug, 'ffffffffffffffffffff');
  assert.strictEqual(c.A.token(), TOKEN, '令牌本身不变');
});

test('refresh：未登录时直接返回 null，不发请求', async function () {
  var c = load();
  assert.strictEqual(await c.A.refresh(), null);
  assert.strictEqual(c.fetch.calls.length, 0);
});

test('refresh：令牌失效则清空本地登录态', async function () {
  var c = load([[/\/api\/auth\/me/, function () {
    return helpers.jsonResponse({ error: '登录已失效，请重新登录' }, 401);
  }]]);
  c.A.save(TOKEN, USER);
  assert.strictEqual(await c.A.refresh(), null);
  assert.strictEqual(c.A.isLoggedIn(), false);
});

test('refresh：网络异常时保留本地状态，只标记 offline', async function () {
  var c = load();   // 没有任何路由 → mockFetch 直接 reject
  c.A.save(TOKEN, USER);
  var d = await c.A.refresh();
  assert.strictEqual(d.offline, true);
  assert.strictEqual(c.A.isLoggedIn(), true, '断网不该把用户踢下线');
  assert.strictEqual(c.A.user().username, 'lucas');
});

/* ---------- api 封装 ---------- */

test('api：默认 GET，解析 JSON，解析失败返回 null', async function () {
  var c = load([[/\/api\/ping/, function () {
    return { ok: true, status: 200, text: function () { return Promise.resolve(''); } };
  }]]);
  assert.strictEqual(await c.A.api('/api/ping'), null);
  assert.strictEqual(c.fetch.methodOf(0), 'GET');
});

test('api：可显式跳过鉴权（登录/注册接口本身不需要令牌）', async function () {
  var c = load([[/\/api\/auth\/login/, function () { return helpers.jsonResponse({ ok: true }); }]]);
  c.A.save(TOKEN, USER);
  await c.A.api('/api/auth/login', { method: 'POST', auth: false });
  assert.strictEqual(c.fetch.headerOf(0, 'Authorization'), undefined);
});
