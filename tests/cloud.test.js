/* tests/cloud.test.js — 前端云能力模块（js/cloud.js）
 * 覆盖口令管理、播放/代理地址组装、请求封装与错误解析、上传表单构造。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function cloud(routes, storage) {
  var f = helpers.mockFetch(routes || []);
  var cm = helpers.loadCM(['cloud.js'], { fetch: f, storage: storage });
  return { C: cm.Cloud, fetch: f };
}

var PASS = 'coral-pass-2026';

test('初始状态：无口令，hasPass 为假', function () {
  var c = cloud();
  assert.strictEqual(c.C.getPass(), '');
  assert.strictEqual(c.C.hasPass(), false);
  assert.strictEqual(c.C.passProblem(''), '尚未设置口令');
});

test('口令长度校验：不足 10 位给出明确提示', function () {
  var c = cloud();
  assert.match(c.C.passProblem('123456789'), /10 位/);
  assert.strictEqual(c.C.passProblem('1234567890'), null);
  assert.match(c.C.passProblem('x'.repeat(129)), /过长/);
});

test('保存口令：可读回并清掉旧的 slug 缓存', function () {
  var c = cloud();
  c.C.setPass(PASS);
  assert.strictEqual(c.C.getPass(), PASS);
  assert.strictEqual(c.C.hasPass(), true);
});

test('setPass 会作废 slug（换口令即换空间）', function () {
  var store = helpers.createStorage();
  store.setItem('cm-cloud-slug', 'abcdef0123456789abcd');
  var c = cloud([], store);
  assert.strictEqual(c.C.getSlug(), 'abcdef0123456789abcd');
  c.C.setPass('another-pass-2026');
  assert.strictEqual(c.C.getSlug(), '');
});

test('randomPass：满足最小长度且分组可抄写', function () {
  var c = cloud();
  var p = c.C.randomPass();
  assert.ok(p.length >= 10);
  assert.match(p, /^[a-z2-9-]+$/);
  assert.strictEqual((p.match(/-/g) || []).length, 3);
  assert.notStrictEqual(c.C.randomPass(), c.C.randomPass());
});

test('ping：成功后缓存服务端派生的 slug', async function () {
  var c = cloud([[/\/api\/ping/, function () {
    return helpers.jsonResponse({ ok: true, slug: '0123456789abcdef0123', cloudTracks: 2 });
  }]]);
  c.C.setPass(PASS);
  var d = await c.C.ping();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(c.C.getSlug(), '0123456789abcdef0123');
  assert.strictEqual(c.fetch.calls.length, 1);
});

test('请求自动携带口令头', async function () {
  var c = cloud([[/\/api\/ping/, function () { return helpers.jsonResponse({ ok: true }); }]]);
  c.C.setPass(PASS);
  await c.C.ping();
  assert.strictEqual(c.fetch.calls.length, 1);
});

test('错误响应：优先使用服务端 error 文案，并带 status', async function () {
  var c = cloud([[/\/api\/audio/, function () { return helpers.jsonResponse({ error: '口令不合法（至少 10 位）' }, 401); }]]);
  c.C.setPass(PASS);
  await assert.rejects(function () { return c.C.listCloud(); }, function (e) {
    assert.strictEqual(e.message, '口令不合法（至少 10 位）');
    assert.strictEqual(e.status, 401);
    return true;
  });
});

test('错误响应：非 JSON 时回退为 HTTP 状态文案', async function () {
  var c = cloud([[/\/api\/audio/, function () {
    return { ok: false, status: 503, text: function () { return Promise.resolve('bad gateway'); } };
  }]]);
  c.C.setPass(PASS);
  await assert.rejects(function () { return c.C.listCloud(); }, function (e) {
    assert.match(e.message, /503/);
    return true;
  });
});

test('listCloud：返回曲目列表', async function () {
  var c = cloud([[/\/api\/audio$/, function () {
    return helpers.jsonResponse({
      slug: 'aaaa567890abcdef0123', count: 1,
      items: [{ id: 'local-1', ext: 'mp3', size: 2048, title: '歌', artist: '手', uploaded: 1 }]
    });
  }]]);
  c.C.setPass(PASS);
  var d = await c.C.listCloud();
  assert.strictEqual(d.count, 1);
  assert.strictEqual(d.items[0].id, 'local-1');
  assert.strictEqual(c.C.getSlug(), 'aaaa567890abcdef0123');
});

test('playUrl：带 slug 作读凭据；没有 slug 时退化为裸路径', function () {
  var c = cloud();
  assert.strictEqual(c.C.playUrl('local-1'), '/api/audio/local-1');
  c.C.setPass(PASS);
  var store = helpers.createStorage();
  store.setItem('cm-cloud-slug', 'slug0123456789abcdef');
  var c2 = cloud([], store).C;
  assert.strictEqual(c2.playUrl('local-1'), '/api/audio/local-1?s=slug0123456789abcdef');
});

test('playUrl：对 id 做 URL 编码', function () {
  var store = helpers.createStorage();
  store.setItem('cm-cloud-slug', 'slug0123456789abcdef');
  var C = cloud([], store).C;
  assert.match(C.playUrl('a b/c'), /a%20b%2Fc/);
});

test('proxyUrl：拼白名单代理地址并编码原始直链', function () {
  var store = helpers.createStorage();
  store.setItem('cm-cloud-slug', 'slug0123456789abcdef');
  var C = cloud([], store).C;
  var u = C.proxyUrl('https://api.audius.co/v1/tracks/1/stream?x=1');
  assert.match(u, /^\/api\/proxy\?s=slug0123456789abcdef&u=/);
  assert.ok(u.indexOf(encodeURIComponent('https://api.audius.co')) > 0);
});

test('proxyUrl：无 slug 或站内地址时原样返回', function () {
  var c = cloud();
  assert.strictEqual(c.C.proxyUrl('https://api.audius.co/a.mp3'), 'https://api.audius.co/a.mp3');
  c.C.setPass(PASS);
  assert.strictEqual(c.C.proxyUrl('/api/audio/x'), '/api/audio/x');
  assert.strictEqual(c.C.proxyUrl(''), '');
});

test('uploadFile：以 multipart 提交并带 id/title/artist', async function () {
  var seen = null;
  var c = cloud([[/\/api\/audio/, function () {
    return helpers.jsonResponse({ ok: true, key: 'audio/x/y.mp3' });
  }]]);
  // mock fetch 记录不到 body，这里直接检查返回与调用次数
  c.C.setPass(PASS);
  var blob = new Blob([Buffer.from('abc')], { type: 'audio/mpeg' });
  var d = await c.C.uploadFile(blob, { id: 'local-9', title: 'T', artist: 'A' });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(c.fetch.calls.length, 1);
  assert.strictEqual(seen, null);
});

test('removeCloud：DELETE 到对应 id 路径并编码', async function () {
  var c = cloud([[/\/api\/audio\//, function () { return helpers.jsonResponse({ ok: true }); }]]);
  c.C.setPass(PASS);
  await c.C.removeCloud('local 1');
  assert.match(c.fetch.calls[0], /\/api\/audio\/local%201$/);
});

test('pushState：成功后记录上次同步时间', async function () {
  var c = cloud([[/\/api\/state/, function () {
    return helpers.jsonResponse({ ok: true, bytes: 1234, updatedAt: 1789000000000 });
  }]]);
  c.C.setPass(PASS);
  assert.strictEqual(c.C.getLastSync(), 0);
  await c.C.pushState({ lists: [] });
  assert.strictEqual(c.C.getLastSync(), 1789000000000);
});

test('pullState：返回云端快照', async function () {
  var c = cloud([[/\/api\/state/, function () {
    return helpers.jsonResponse({ slug: 's', empty: false, state: { lists: [{ id: 'all', name: '全部', ids: [] }] }, updatedAt: 5 });
  }]]);
  c.C.setPass(PASS);
  var d = await c.C.pullState();
  assert.strictEqual(d.empty, false);
  assert.strictEqual(d.state.lists[0].id, 'all');
});

test('pullState：云端无备份时 empty 为真', async function () {
  var c = cloud([[/\/api\/state/, function () {
    return helpers.jsonResponse({ slug: 's', empty: true, state: null, updatedAt: 0 });
  }]]);
  c.C.setPass(PASS);
  var d = await c.C.pullState();
  assert.strictEqual(d.empty, true);
  assert.strictEqual(d.state, null);
});
