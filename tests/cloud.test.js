/* tests/cloud.test.js — 前端云能力模块（js/cloud.js + js/account.js）
 * 覆盖：登录态与空间标识的来源、Bearer 令牌的携带、401 失效处理、
 *       播放/代理地址组装、上传表单、同步读写、旧口令空间接管。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

var SLUG = '0123456789abcdef0123';
var TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function load(routes, storage) {
  var f = helpers.mockFetch(routes || []);
  var cm = helpers.loadCM(['account.js', 'cloud.js'], { fetch: f, storage: storage });
  return { C: cm.Cloud, A: cm.Account, fetch: f };
}

// 直接写入一份登录态（等价于登录成功后的本地存储）
function signIn(c, token, slug, username) {
  c.A.save(token || TOKEN, {
    id: 1, username: username || 'lucas', displayName: '领主', spaceSlug: slug || SLUG
  });
}

/* ---------- 登录态 ---------- */

test('未登录：isLoggedIn 为假，且没有空间标识', function () {
  var c = load();
  assert.strictEqual(c.C.isLoggedIn(), false);
  assert.strictEqual(c.C.currentUser(), null);
  assert.strictEqual(c.C.getSlug(), '');
});

test('登录后：空间标识取账号里的值，并缓存到本地', function () {
  var c = load();
  signIn(c);
  assert.strictEqual(c.C.isLoggedIn(), true);
  assert.strictEqual(c.C.getSlug(), SLUG);
  assert.strictEqual(c.C.getSlug(), SLUG, '再次读取仍稳定');
});

test('登录后：账号里的空间标识优先于本地旧缓存', function () {
  var store = helpers.createStorage();
  store.setItem('cm-cloud-slug', 'ffffffffffffffffffff');
  var c = load([], store);
  signIn(c, TOKEN, SLUG);
  assert.strictEqual(c.C.getSlug(), SLUG);
});

test('退出登录后清掉空间缓存，播放地址不再带凭据', function () {
  var c = load();
  signIn(c);
  assert.strictEqual(c.C.getSlug(), SLUG);
  c.A.clear();
  c.C.clearSlug();
  assert.strictEqual(c.C.getSlug(), '');
  assert.strictEqual(c.C.playUrl('local-1'), '/api/audio/local-1');
});

/* ---------- 请求头 ---------- */

test('已登录：请求自动携带 Authorization: Bearer', async function () {
  var c = load([[/\/api\/ping/, function () { return helpers.jsonResponse({ ok: true }); }]]);
  signIn(c);
  await c.C.ping();
  assert.strictEqual(c.fetch.headerOf(0, 'Authorization'), 'Bearer ' + TOKEN);
});

test('未登录：请求不带 Authorization 头（由服务端回 401）', async function () {
  var c = load([[/\/api\/ping/, function () { return helpers.jsonResponse({ ok: true }); }]]);
  await c.C.ping();
  assert.strictEqual(c.fetch.headerOf(0, 'Authorization'), undefined);
});

test('不再使用旧的 X-Coral-Key 口令头', async function () {
  var c = load([[/\/api\/ping/, function () { return helpers.jsonResponse({ ok: true }); }]]);
  signIn(c);
  await c.C.ping();
  assert.strictEqual(c.fetch.headerOf(0, 'X-Coral-Key'), undefined);
});

test('401 视为会话失效：自动清空本地令牌与用户', async function () {
  var c = load([[/\/api\/state/, function () {
    return helpers.jsonResponse({ error: '登录已失效，请重新登录' }, 401);
  }]]);
  signIn(c);
  await assert.rejects(function () { return c.C.pullState(); }, function (e) {
    assert.strictEqual(e.message, '登录已失效，请重新登录');
    assert.strictEqual(e.status, 401);
    return true;
  });
  assert.strictEqual(c.A.isLoggedIn(), false);
  assert.strictEqual(c.C.isLoggedIn(), false);
});

test('非 401 错误不动本地登录态', async function () {
  var c = load([[/\/api\/audio/, function () { return helpers.jsonResponse({ error: '未绑定 R2' }, 503); }]]);
  signIn(c);
  await assert.rejects(function () { return c.C.listCloud(); });
  assert.strictEqual(c.A.isLoggedIn(), true);
});

test('错误响应：优先使用服务端 error 文案，并带 status', async function () {
  var c = load([[/\/api\/audio/, function () { return helpers.jsonResponse({ error: '未绑定 R2（MUSIC_BUCKET）' }, 503); }]]);
  signIn(c);
  await assert.rejects(function () { return c.C.listCloud(); }, function (e) {
    assert.strictEqual(e.message, '未绑定 R2（MUSIC_BUCKET）');
    assert.strictEqual(e.status, 503);
    return true;
  });
});

test('错误响应：非 JSON 时回退为 HTTP 状态文案', async function () {
  var c = load([[/\/api\/audio/, function () {
    return { ok: false, status: 503, text: function () { return Promise.resolve('bad gateway'); } };
  }]]);
  signIn(c);
  await assert.rejects(function () { return c.C.listCloud(); }, function (e) {
    assert.match(e.message, /503/);
    return true;
  });
});

/* ---------- 云端列表与地址组装 ---------- */

test('ping：成功后把账号里的空间标识写进缓存', async function () {
  var c = load([[/\/api\/ping/, function () {
    return helpers.jsonResponse({ ok: true, user: { spaceSlug: SLUG }, cloudTracks: 2 });
  }]]);
  signIn(c, TOKEN, '');
  var d = await c.C.ping();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(c.C.getSlug(), SLUG);
  assert.strictEqual(c.fetch.calls.length, 1);
});

test('listCloud：返回曲目列表并缓存服务端给的 slug', async function () {
  var c = load([[/\/api\/audio$/, function () {
    return helpers.jsonResponse({
      slug: SLUG, count: 1,
      items: [{ id: 'local-1', ext: 'mp3', size: 2048, title: '歌', artist: '手', uploaded: 1 }]
    });
  }]]);
  signIn(c, TOKEN, '');
  var d = await c.C.listCloud();
  assert.strictEqual(d.count, 1);
  assert.strictEqual(d.items[0].id, 'local-1');
  assert.strictEqual(c.C.getSlug(), SLUG);
});

test('playUrl：带 slug 作读凭据（<audio src> 无法带请求头）', function () {
  var c = load();
  signIn(c);
  assert.strictEqual(c.C.playUrl('local-1'), '/api/audio/local-1?s=' + SLUG);
});

test('playUrl：对 id 做 URL 编码', function () {
  var c = load();
  signIn(c);
  assert.match(c.C.playUrl('a b/c'), /a%20b%2Fc/);
});

test('proxyUrl：拼代理地址并编码原始直链', function () {
  var c = load();
  signIn(c);
  var u = c.C.proxyUrl('https://api.audius.co/v1/tracks/1/stream?x=1');
  assert.match(u, new RegExp('^/api/proxy\\?s=' + SLUG + '&u='));
  assert.ok(u.indexOf(encodeURIComponent('https://api.audius.co')) > 0);
});

test('proxyUrl：站内地址原样返回', function () {
  var c = load();
  signIn(c);
  assert.strictEqual(c.C.proxyUrl('/api/audio/x'), '/api/audio/x');
  assert.strictEqual(c.C.proxyUrl(''), '');
});

/* ---------- 上传 / 删除 / 同步 ---------- */

test('uploadFile：以 multipart 提交', async function () {
  var c = load([[/\/api\/audio/, function () { return helpers.jsonResponse({ ok: true, key: 'audio/x/y.mp3' }); }]]);
  signIn(c);
  var blob = new Blob([Buffer.from('abc')], { type: 'audio/mpeg' });
  var d = await c.C.uploadFile(blob, { id: 'local-9', title: 'T', artist: 'A' });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(c.fetch.calls.length, 1);
  assert.strictEqual(c.fetch.methodOf(0), 'POST');
});

test('removeCloud：DELETE 到对应 id 路径并编码', async function () {
  var c = load([[/\/api\/audio\//, function () { return helpers.jsonResponse({ ok: true }); }]]);
  signIn(c);
  await c.C.removeCloud('local 1');
  assert.match(c.fetch.calls[0], /\/api\/audio\/local%201$/);
  assert.strictEqual(c.fetch.methodOf(0), 'DELETE');
});

test('pushState：成功后记录上次同步时间', async function () {
  var c = load([[/\/api\/state/, function () {
    return helpers.jsonResponse({ ok: true, bytes: 1234, updatedAt: 1789000000000 });
  }]]);
  signIn(c);
  assert.strictEqual(c.C.getLastSync(), 0);
  await c.C.pushState({ lists: [] });
  assert.strictEqual(c.C.getLastSync(), 1789000000000);
});

test('pullState：返回云端快照', async function () {
  var c = load([[/\/api\/state/, function () {
    return helpers.jsonResponse({ slug: SLUG, empty: false, state: { lists: [{ id: 'all', name: '全部', ids: [] }] }, updatedAt: 5 });
  }]]);
  signIn(c);
  var d = await c.C.pullState();
  assert.strictEqual(d.empty, false);
  assert.strictEqual(d.state.lists[0].id, 'all');
});

test('pullState：云端无备份时 empty 为真', async function () {
  var c = load([[/\/api\/state/, function () {
    return helpers.jsonResponse({ slug: SLUG, empty: true, state: null, updatedAt: 0 });
  }]]);
  signIn(c);
  var d = await c.C.pullState();
  assert.strictEqual(d.empty, true);
  assert.strictEqual(d.state, null);
});

/* ---------- 旧口令空间接管 ---------- */

test('adoptOldPass：分批搬运直到服务端说 done', async function () {
  var calls = 0;
  var c = load([[/\/api\/auth\/adopt/, function (u, init) {
    calls++;
    var body = JSON.parse(init.body);
    assert.strictEqual(body.oldPass, 'coral-pass-2026');
    // 第一批还剩 3 个，第二批收尾
    return helpers.jsonResponse(calls === 1
      ? { ok: true, copied: 20, skipped: 0, total: 23, remaining: 3, state: 'skipped', done: false }
      : { ok: true, copied: 3, skipped: 0, total: 23, remaining: 0, state: 'adopted', done: true });
  }]]);
  signIn(c);

  var progress = [];
  var r = await c.C.adoptOldPass('coral-pass-2026', function (p) { progress.push(p.copied); });
  assert.strictEqual(calls, 2, '两轮搬运');
  assert.strictEqual(r.copied, 23);
  assert.strictEqual(r.state, 'adopted');
  assert.strictEqual(r.done, true);
  assert.deepStrictEqual(progress, [20, 23], '进度回调逐轮累加');
});

test('adoptOldPass：口令不足 10 位直接拒绝，不发请求', async function () {
  var c = load();
  signIn(c);
  await assert.rejects(function () { return c.C.adoptOldPass('short'); }, function (e) {
    assert.match(e.message, /10 位/);
    return true;
  });
  assert.strictEqual(c.fetch.calls.length, 0);
});

test('adoptOldPass：未登录时拒绝', async function () {
  var c = load();
  await assert.rejects(function () { return c.C.adoptOldPass('coral-pass-2026'); }, function (e) {
    assert.match(e.message, /请先登录/);
    return true;
  });
  assert.strictEqual(c.fetch.calls.length, 0);
});
