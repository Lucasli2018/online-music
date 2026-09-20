/* tests/functions.test.mjs — Pages Functions 云端能力
 *
 * 覆盖两层：
 *   ① functions/_lib/core.mjs 的纯逻辑（key 规约、Range 解析、同步负载白名单）
 *   ② 各端点的 onRequestXxx handler —— 内存版 R2 / D1 替身（tests/fake-cloud.mjs）
 *      + 真实的 Request/Response/FormData（Node 自带 undici 实现），因此接近端到端。
 *
 * 鉴权模型是 v2 的「账号密码 + Bearer 会话」，所有云端端点都要求登录；
 * 唯一的例外是 `GET /api/audio/:id?s=<slug>`（<audio src> 带不了请求头）。
 * 账号相关的端点（注册 / 登录 / 登出 / me / 接管旧空间）在 tests/auth-api.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  audioKey, audioPrefix, contentTypeOf, extOf, json, newShareCode,
  parseRange, safeId, sanitizeState, shareKey, slugOf, stateKey, toHex
} from '../functions/_lib/core.mjs';
import { cloudEnv, ctx, readJSON, seedUser, authed } from './fake-cloud.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const audio = await import('../functions/api/audio/index.mjs');
const audioId = await import(pathToFileURL(path.join(ROOT, 'functions/api/audio/[id].mjs')).href);
const stateApi = await import('../functions/api/state.mjs');
const proxyApi = await import('../functions/api/proxy.mjs');
const pingApi = await import('../functions/api/ping.mjs');

/* 准备一个「已注册 + 已登录」的环境，返回环境、令牌与空间标识 */
async function signedEnv(opts) {
  const e = cloudEnv();
  const u = await seedUser(e.DB, opts);
  return { e, token: u.token, slug: u.slug, user: u.row };
}

/* ===================== 一、core 纯逻辑 ===================== */

test('toHex: 字节转小写十六进制', () => {
  assert.strictEqual(toHex(new Uint8Array([0, 15, 16, 255])), '000f10ff');
});

test('slugOf: 稳定、20 位十六进制、不同口令不冲突', async () => {
  const a = await slugOf('coral-test-2026');
  const b = await slugOf('coral-test-2026');
  const c = await slugOf('coral-test-2026x');
  assert.strictEqual(a, b, '同一口令必须得到同一空间（接管旧空间时依赖这一点）');
  assert.notStrictEqual(a, c);
  assert.match(a, /^[0-9a-f]{20}$/);
});

test('extOf: 从文件名或 MIME 推断扩展名，非法回退 mp3', () => {
  assert.strictEqual(extOf('song.MP3', ''), 'mp3');
  assert.strictEqual(extOf('a.flac', ''), 'flac');
  assert.strictEqual(extOf('noext', 'audio/x-m4a'), 'm4a');
  assert.strictEqual(extOf('weird.xyz', ''), 'mp3');
  assert.strictEqual(extOf('', 'audio/ogg'), 'ogg');
  assert.strictEqual(extOf('a.wav', 'audio/mpeg'), 'wav', '文件扩展名优先');
});

test('contentTypeOf: 扩展名回映射 MIME，未知给二进制流', () => {
  assert.strictEqual(contentTypeOf('mp3'), 'audio/mpeg');
  assert.strictEqual(contentTypeOf('M4A'), 'audio/mp4');
  assert.strictEqual(contentTypeOf('zzz'), 'application/octet-stream');
});

test('safeId: 过滤路径穿越与危险字符', () => {
  assert.strictEqual(safeId('../../etc/passwd'), '....etcpasswd');
  assert.strictEqual(safeId('a b/c?d#e'), 'abcde');
  assert.strictEqual(safeId('local-1_x.mp3'), 'local-1_x.mp3');
  assert.strictEqual(safeId(''), '');
});

test('key 规约：音频 / 状态 / 分享三类前缀清晰隔离', () => {
  assert.strictEqual(audioKey('abc123', 't1', 'mp3'), 'audio/abc123/t1.mp3');
  assert.strictEqual(audioPrefix('abc123'), 'audio/abc123/');
  assert.strictEqual(stateKey('abc123'), 'state/abc123.json');
  assert.strictEqual(shareKey('code1'), 'share/code1.json');
});

test('parseRange: 无 Range 头返回 null', () => {
  assert.strictEqual(parseRange(null, 100), null);
  assert.strictEqual(parseRange('', 100), null);
});

test('parseRange: 起止、开区间、后缀三种写法', () => {
  assert.deepStrictEqual(parseRange('bytes=0-9', 100), { offset: 0, length: 10 });
  assert.deepStrictEqual(parseRange('bytes=90-', 100), { offset: 90, length: 10 });
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { offset: 90, length: 10 });
});

test('parseRange: 末端越界被裁剪到文件末尾', () => {
  assert.deepStrictEqual(parseRange('bytes=95-200', 100), { offset: 95, length: 5 });
});

test('parseRange: 非法输入判定 invalid', () => {
  assert.strictEqual(parseRange('items=0-1', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=-', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=5-2', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=200-300', 100), 'invalid');
  assert.strictEqual(parseRange('bytes=0-10', 0), 'invalid');
});

test('sanitizeState: 白名单字段，丢弃未知结构与脏数据', () => {
  const out = sanitizeState({
    lists: [
      { id: 'all', name: '全部', ids: ['t1', 't2'], evil: 'x' },
      { id: 123, name: 'no-id' },              // id 非字符串 → 丢弃
      null
    ],
    remote: [{ id: 't1', title: 'A', artist: 'B', url: 'https://x/1.mp3', junk: 'y' }],
    lyrics: { t1: '[00:01.00]hello', t2: 12345 },
    settings: { theme: 'dark', volume: 0.8, hack: 'nope' },
    stats: { t1: { c: 3, at: 1789000000000 } },
    progress: { t1: 12.567, t2: -1 },
    device: 'test-agent',
    unknownBlock: { a: 1 }
  });
  assert.strictEqual(out.lists.length, 1);
  assert.strictEqual(out.lists[0].evil, undefined);
  assert.strictEqual(out.remote[0].junk, undefined);
  assert.strictEqual(out.lyrics.t2, undefined, '非字符串歌词被丢弃');
  assert.strictEqual(out.settings.hack, undefined);
  assert.strictEqual(out.unknownBlock, undefined);
  assert.strictEqual(out.progress.t1, 12.57, '进度保留两位小数');
  assert.strictEqual(out.progress.t2, undefined, '负数进度被丢弃');
  assert.strictEqual(out.device, 'test-agent');
  assert.ok(out.updatedAt > 0);
});

test('sanitizeState: 非法入参返回 null', () => {
  assert.strictEqual(sanitizeState(null), null);
  assert.strictEqual(sanitizeState('str'), null);
  assert.strictEqual(sanitizeState(42), null);
});

test('newShareCode: 长度固定且不含易混字符', () => {
  const c = newShareCode();
  assert.strictEqual(c.length, 10);
  assert.match(c, /^[a-z2-9]+$/);
  assert.ok(c.indexOf('l') < 0 && c.indexOf('o') < 0 && c.indexOf('1') < 0);
  assert.notStrictEqual(newShareCode(), newShareCode());
});

test('json: 默认不缓存并带 JSON 头', async () => {
  const res = json({ a: 1 }, 201);
  assert.strictEqual(res.status, 201);
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
  assert.deepStrictEqual(await readJSON(res), { a: 1 });
});

/* ===================== 二、/api/audio 列表与上传 ===================== */

test('列表: 未登录返回 401', async () => {
  const { e } = await signedEnv();
  const res = await audio.onRequestGet(ctx(new Request('https://x/api/audio'), e));
  assert.strictEqual(res.status, 401);
});

test('列表: 伪造的令牌同样 401', async () => {
  const { e } = await signedEnv();
  const req = authed('https://x/api/audio', 'f'.repeat(64));
  assert.strictEqual((await audio.onRequestGet(ctx(req, e))).status, 401);
});

test('列表: 未绑定 R2 时给出 503 而不是崩溃', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  delete e.MUSIC_BUCKET;
  const res = await audio.onRequestGet(ctx(authed('https://x/api/audio', u.token), e));
  assert.strictEqual(res.status, 503);
});

test('列表: 新账号的空间为空且 slug 来自账号而非密码', async () => {
  const { e, token, slug } = await signedEnv();
  const body = await readJSON(await audio.onRequestGet(ctx(authed('https://x/api/audio', token), e)));
  assert.strictEqual(body.slug, slug);
  assert.match(body.slug, /^[0-9a-f]{20}$/);
  assert.strictEqual(body.count, 0);
  assert.deepStrictEqual(body.items, []);
});

test('上传: 未登录被拒，不写任何对象', async () => {
  const { e } = await signedEnv();
  const fd = new FormData();
  fd.append('file', new File([Buffer.from('x')], 'a.mp3', { type: 'audio/mpeg' }));
  const res = await audio.onRequestPost(ctx(new Request('https://x/api/audio', { method: 'POST', body: fd }), e));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(e.MUSIC_BUCKET._store.size, 0);
});

test('上传: 非 multipart 请求被拒', async () => {
  const { e, token } = await signedEnv();
  const req = authed('https://x/api/audio', token, { method: 'POST', body: 'plain' });
  assert.strictEqual((await audio.onRequestPost(ctx(req, e))).status, 400);
});

test('上传: 成功写入账号空间并给出 key', async () => {
  const { e, token, slug } = await signedEnv();
  const fd = new FormData();
  fd.append('file', new File([Buffer.from('audio-bytes-here')], '晴天.mp3', { type: 'audio/mpeg' }));
  fd.append('id', 'local-1001');
  fd.append('title', '晴天');
  fd.append('artist', '周杰伦');
  const req = authed('https://x/api/audio', token, { method: 'POST', body: fd });

  const body = await readJSON(await audio.onRequestPost(ctx(req, e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.id, 'local-1001');
  assert.strictEqual(body.ext, 'mp3');
  assert.strictEqual(body.key, `audio/${slug}/local-1001.mp3`);

  const stored = e.MUSIC_BUCKET._store.get(body.key);
  assert.ok(stored, '对象应已写入存储');
  assert.strictEqual(stored.buf.toString('utf8'), 'audio-bytes-here');
  assert.strictEqual(stored.httpMetadata.contentType, 'audio/mpeg');
  assert.strictEqual(stored.customMetadata.title, '晴天');
});

test('上传后立即可在列表中看到', async () => {
  const { e, token } = await signedEnv();
  const fd = new FormData();
  fd.append('file', new File([Buffer.from('x')], 'demo.wav', { type: 'audio/wav' }));
  fd.append('id', 'demo');
  await audio.onRequestPost(ctx(authed('https://x/api/audio', token, { method: 'POST', body: fd }), e));

  const body = await readJSON(await audio.onRequestGet(ctx(authed('https://x/api/audio', token), e)));
  assert.strictEqual(body.count, 1);
  assert.strictEqual(body.items[0].id, 'demo');
  assert.strictEqual(body.items[0].ext, 'wav');
  assert.strictEqual(body.items[0].size, 1);
});

test('上传: 缺少 file 字段被拒', async () => {
  const { e, token } = await signedEnv();
  const fd = new FormData();
  fd.append('id', 'x');
  const req = authed('https://x/api/audio', token, { method: 'POST', body: fd });
  assert.strictEqual((await audio.onRequestPost(ctx(req, e))).status, 400);
});

test('上传: 超限文件返回 413', async () => {
  const { e, token } = await signedEnv();
  const big = Buffer.alloc(61 * 1024 * 1024, 1);
  const fd = new FormData();
  fd.append('file', new File([big], 'big.mp3', { type: 'audio/mpeg' }));
  const req = authed('https://x/api/audio', token, { method: 'POST', body: fd });
  assert.strictEqual((await audio.onRequestPost(ctx(req, e))).status, 413);
});

/* ===================== 三、/api/audio/:id 播放与删除 ===================== */

async function seed(e, id, bytes, ext = 'mp3', slug) {
  const key = `audio/${slug}/${id}.${ext}`;
  await e.MUSIC_BUCKET.put(key, Buffer.from(bytes), { httpMetadata: { contentType: contentTypeOf(ext) } });
  return { slug, key };
}

test('播放: 合法格式但不存在的空间返回 404（读凭据只是 slug）', async () => {
  const { e } = await signedEnv();
  const req = new Request('https://x/api/audio/t1?s=' + 'a'.repeat(20));
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 't1' }))).status, 404);
});

test('播放: 非法 slug 返回 401', async () => {
  const { e } = await signedEnv();
  const req = new Request('https://x/api/audio/t1?s=not-a-slug');
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 't1' }))).status, 401);
});

test('播放: 不需要登录（<audio src> 带不了 Authorization 头）', async () => {
  const { e, slug } = await signedEnv();
  await seed(e, 't1', 'abcdefghij', 'mp3', slug);
  const req = new Request('https://x/api/audio/t1?s=' + slug);
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'abcdefghij');
});

test('播放: 曲目不存在返回 404', async () => {
  const { e, slug } = await signedEnv();
  const req = new Request('https://x/api/audio/ghost?s=' + slug);
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 'ghost' }))).status, 404);
});

test('播放: 完整下载返回 200 与 Accept-Ranges', async () => {
  const { e, slug } = await signedEnv();
  await seed(e, 't1', 'abcdefghij', 'mp3', slug);
  const req = new Request('https://x/api/audio/t1?s=' + slug);
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('Content-Length'), '10');
  assert.strictEqual(res.headers.get('Accept-Ranges'), 'bytes');
  assert.match(res.headers.get('Content-Type'), /audio\/mpeg/);
});

test('播放: Range 请求返回 206 与正确分片（进度条拖动依赖）', async () => {
  const { e, slug } = await signedEnv();
  await seed(e, 't1', 'abcdefghij', 'mp3', slug);
  const req = new Request('https://x/api/audio/t1?s=' + slug, { headers: { Range: 'bytes=2-5' } });
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.strictEqual(res.headers.get('Content-Length'), '4');
  assert.strictEqual(await res.text(), 'cdef');
});

test('播放: 非法 Range 返回 416 并带上总长度', async () => {
  const { e, slug } = await signedEnv();
  await seed(e, 't1', 'abcdefghij', 'mp3', slug);
  const req = new Request('https://x/api/audio/t1?s=' + slug, { headers: { Range: 'bytes=99-200' } });
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 416);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes */10');
});

test('播放: 用别的空间 slug 读不到他人的曲目（空间隔离）', async () => {
  const { e, slug } = await signedEnv();
  const other = await seedUser(e.DB, { username: 'other', slug: 'f'.repeat(20) });
  await seed(e, 't1', 'secret-audio', 'mp3', slug);
  const req = new Request('https://x/api/audio/t1?s=' + other.slug);
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 't1' }))).status, 404);
});

test('播放: 空间标识不是路径穿越的入口', async () => {
  const { e } = await signedEnv();
  const req = new Request('https://x/api/audio/..%2F..%2Fstate?s=' + 'c'.repeat(20));
  const res = await audioId.onRequestGet(ctx(req, e, { id: '../../state' }));
  assert.ok(res.status === 400 || res.status === 404, '不该命中别的 key，实际 ' + res.status);
});

test('删除: 未登录 401，登录后正常删除', async () => {
  const { e, token, slug } = await signedEnv();
  const { key } = await seed(e, 't1', 'abc', 'mp3', slug);
  assert.strictEqual(
    (await audioId.onRequestDelete(ctx(new Request('https://x/api/audio/t1'), e, { id: 't1' }))).status, 401);

  const req = authed('https://x/api/audio/t1', token, { method: 'DELETE' });
  const body = await readJSON(await audioId.onRequestDelete(ctx(req, e, { id: 't1' })));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(e.MUSIC_BUCKET._store.has(key), false);
});

test('删除: 删不到别人的曲目（只在自己的空间里找）', async () => {
  const { e, token, slug } = await signedEnv();
  const other = await seedUser(e.DB, { username: 'other', slug: 'f'.repeat(20) });
  await seed(e, 't1', 'abc', 'mp3', other.slug);
  const req = authed('https://x/api/audio/t1', token, { method: 'DELETE' });
  assert.strictEqual((await audioId.onRequestDelete(ctx(req, e, { id: 't1' }))).status, 404);
  assert.strictEqual(slug === other.slug, false);
});

test('删除: 不存在的曲目返回 404', async () => {
  const { e, token } = await signedEnv();
  const req = authed('https://x/api/audio/ghost', token, { method: 'DELETE' });
  assert.strictEqual((await audioId.onRequestDelete(ctx(req, e, { id: 'ghost' }))).status, 404);
});

/* ===================== 四、/api/state 同步 ===================== */

test('同步: 新空间返回 empty 标记', async () => {
  const { e, token } = await signedEnv();
  const body = await readJSON(await stateApi.onRequestGet(ctx(authed('https://x/api/state', token), e)));
  assert.strictEqual(body.empty, true);
  assert.strictEqual(body.state, null);
});

test('同步: 上传后能原样读回（含统计与进度）', async () => {
  const { e, token } = await signedEnv();
  const payload = {
    state: {
      lists: [{ id: 'all', name: '全部', ids: ['t1'] }],
      remote: [{ id: 't1', title: '曲目', artist: '歌手', url: 'https://x/1.mp3' }],
      lyrics: { t1: '[00:01.00]A' },
      settings: { theme: 'dark' },
      stats: { t1: { c: 3, at: 1789000000000 } },
      progress: { t1: 12.5 }
    }
  };
  const putBody = await readJSON(await stateApi.onRequestPut(ctx(
    authed('https://x/api/state', token, { method: 'PUT', body: JSON.stringify(payload) }), e)));
  assert.strictEqual(putBody.ok, true);
  assert.strictEqual(putBody.counts.lists, 1);
  assert.strictEqual(putBody.counts.stats, 1);

  const getBody = await readJSON(await stateApi.onRequestGet(ctx(authed('https://x/api/state', token), e)));
  assert.strictEqual(getBody.empty, false);
  assert.strictEqual(getBody.state.lists[0].ids[0], 't1');
  assert.strictEqual(getBody.state.stats.t1.c, 3);
  assert.strictEqual(getBody.state.progress.t1, 12.5);
  assert.ok(getBody.updatedAt > 0);
});

test('同步: 直接传 state 对象（不裹一层）也能存', async () => {
  const { e, token } = await signedEnv();
  await stateApi.onRequestPut(ctx(authed('https://x/api/state', token, {
    method: 'PUT', body: JSON.stringify({ lists: [{ id: 'x', name: 'X', ids: [] }] })
  }), e));
  const body = await readJSON(await stateApi.onRequestGet(ctx(authed('https://x/api/state', token), e)));
  assert.strictEqual(body.state.lists[0].id, 'x');
});

test('同步: 坏 JSON 返回 400', async () => {
  const { e, token } = await signedEnv();
  const req = authed('https://x/api/state', token, { method: 'PUT', body: '{不是 JSON' });
  assert.strictEqual((await stateApi.onRequestPut(ctx(req, e))).status, 400);
});

test('同步: 未登录时读写都被拒，且不落任何数据', async () => {
  const { e } = await signedEnv();
  assert.strictEqual((await stateApi.onRequestGet(ctx(new Request('https://x/api/state'), e))).status, 401);
  assert.strictEqual((await stateApi.onRequestPut(ctx(new Request('https://x/api/state', {
    method: 'PUT', body: '{}'
  }), e))).status, 401);
  assert.strictEqual(e.MUSIC_BUCKET._store.size, 0);
});

test('同步: 两个账号互不干扰', async () => {
  const { e, token } = await signedEnv();
  const other = await seedUser(e.DB, { username: 'other', slug: 'f'.repeat(20) });

  await stateApi.onRequestPut(ctx(authed('https://x/api/state', token, {
    method: 'PUT', body: JSON.stringify({ lists: [{ id: 'mine', name: 'M', ids: [] }] })
  }), e));

  const body = await readJSON(await stateApi.onRequestGet(ctx(authed('https://x/api/state', other.token), e)));
  assert.strictEqual(body.empty, true, '另一账号应看到自己的空空间');
  assert.strictEqual(e.MUSIC_BUCKET._store.has('state/' + other.slug + '.json'), false);
});

/* ===================== 五、/api/proxy 代理 ===================== */

function withFetchStub(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

test('代理: 缺少或格式非法的 slug 返回 401', async () => {
  const { e } = await signedEnv();
  const url = 'https://x/api/proxy?u=' + encodeURIComponent('https://api.audius.co/v1/tracks/1/stream');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), e))).status, 401);
});

test('代理: 格式合法但不对应任何账号的 slug 也 401（防开放代理）', async () => {
  const { e } = await signedEnv();
  const url = 'https://x/api/proxy?s=' + 'b'.repeat(20) + '&u=' + encodeURIComponent('https://api.audius.co/x');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), e))).status, 401);
});

test('代理: 非白名单域名返回 403', async () => {
  const { e, slug } = await signedEnv();
  const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://evil.example.com/a.mp3');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), e))).status, 403);
});

test('代理: 非 https 目标返回 400', async () => {
  const { e, slug } = await signedEnv();
  const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('http://api.audius.co/a.mp3');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), e))).status, 400);
});

test('代理: 白名单音源正常回传并透传 Range 头', async () => {
  const { e, slug } = await signedEnv();
  const seen = {};
  await withFetchStub(async (u, opts) => {
    seen.url = String(u);
    seen.range = opts && opts.headers && opts.headers.Range;
    return new Response('proxied-audio', {
      status: 206,
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-12/100' }
    });
  }, async () => {
    const target = 'https://api.audius.co/v1/tracks/abc/stream';
    const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent(target);
    const res = await proxyApi.onRequestGet(ctx(new Request(url, { headers: { Range: 'bytes=0-12' } }), e));
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('Content-Range'), 'bytes 0-12/100');
    assert.strictEqual(res.headers.get('Accept-Ranges'), 'bytes');
    assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(await res.text(), 'proxied-audio');
  });
  assert.strictEqual(seen.url, 'https://api.audius.co/v1/tracks/abc/stream');
  assert.strictEqual(seen.range, 'bytes=0-12');
});

test('代理: 上游非音频类型返回 415', async () => {
  const { e, slug } = await signedEnv();
  await withFetchStub(async () => new Response('<html>oops</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  }), async () => {
    const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://api.audius.co/x');
    assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), e))).status, 415);
  });
});

test('代理: 上游 404 转成 502', async () => {
  const { e, slug } = await signedEnv();
  await withFetchStub(async () => new Response('nope', { status: 404 }), async () => {
    const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://api.audius.co/x');
    assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), e))).status, 502);
  });
});

/* ===================== 六、/api/ping 自检 ===================== */

test('自检: 绑定正常时返回 ok 与账号数', async () => {
  const { e, token } = await signedEnv();
  const body = await readJSON(await pingApi.onRequestGet(ctx(authed('https://x/api/ping', token), e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.hasBucket, true);
  assert.strictEqual(body.bucketOk, true);
  assert.strictEqual(body.dbOk, true);
  assert.strictEqual(body.auth, 'account');
  assert.strictEqual(body.accounts, 1);
  assert.strictEqual(body.loggedIn, true);
  assert.strictEqual(body.cloudTracks, 0);
});

test('自检: 未绑定 R2 时 ok=false 且给出原因', async () => {
  const e = cloudEnv();
  delete e.MUSIC_BUCKET;
  const body = await readJSON(await pingApi.onRequestGet(ctx(new Request('https://x/api/ping'), e)));
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.hasBucket, false);
  assert.strictEqual(body.dbOk, true, 'D1 正常，问题只在 R2');
  assert.match(body.reason, /MUSIC_BUCKET/);
});

test('自检: 未绑定 D1 时明确指向账号表', async () => {
  const body = await readJSON(await pingApi.onRequestGet(ctx(new Request('https://x/api/ping'), {
    MUSIC_BUCKET: cloudEnv().MUSIC_BUCKET
  })));
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.hasDb, false);
  assert.match(body.reason, /D1/);
});

test('自检: 不带令牌也能用（只报绑定状态，不算错误）', async () => {
  const { e } = await signedEnv();
  const body = await readJSON(await pingApi.onRequestGet(ctx(new Request('https://x/api/ping'), e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.loggedIn, false);
  assert.strictEqual(body.user, undefined);
  assert.strictEqual(body.authError, undefined);
});
