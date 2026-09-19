/* tests/functions.test.mjs — Pages Functions 云端能力
 *
 * 覆盖两层：
 *   ① functions/_lib/core.mjs 的纯逻辑（口令派生、key 规约、Range 解析、同步负载白名单）
 *   ② 各端点的 onRequestXxx handler —— 用内存版 R2 替身 + 真实的 Request/Response/FormData
 *      （Node 18+ 自带 undici 实现），因此接近端到端，而不是只测 mock。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  audioKey, audioPrefix, contentTypeOf, extOf, isPassOk, json, MIN_PASS, newShareCode,
  parseRange, passProblem, randomPass, safeId, sanitizeState, shareKey, slugOf, stateKey, toHex
} from '../functions/_lib/core.mjs';

const audio = await import('../functions/api/audio/index.mjs');
const audioId = await import(pathToFileURL(path.join(ROOT, 'functions/api/audio/[id].mjs')).href);
const stateApi = await import('../functions/api/state.mjs');
const proxyApi = await import('../functions/api/proxy.mjs');
const pingApi = await import('../functions/api/ping.mjs');

const PASS = 'coral-test-2026';   // 满足最小长度

/* ---------- 内存版 R2 替身 ---------- */
function fakeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value, opts) {
      const buf = Buffer.isBuffer(value) ? value
        : (typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));
      store.set(key, {
        buf,
        httpMetadata: (opts && opts.httpMetadata) || {},
        customMetadata: (opts && opts.customMetadata) || {},
        uploaded: new Date('2026-09-19T09:00:00Z')
      });
      return { key };
    },
    async get(key, opts) {
      const o = store.get(key);
      if (!o) return null;
      let body = o.buf, range = null;
      if (opts && opts.range) {
        const offset = opts.range.offset;
        const length = opts.range.length;
        body = o.buf.subarray(offset, offset + length);
        range = { offset, length };
      }
      return {
        key, size: o.buf.length, range,
        httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, uploaded: o.uploaded,
        body,
        text: async () => o.buf.toString('utf8'),
        arrayBuffer: async () => body
      };
    },
    async head(key) {
      const o = store.get(key);
      return o ? { key, size: o.buf.length, httpMetadata: o.httpMetadata } : null;
    },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, opts.limit || 1000)
        .map(([k, o]) => ({
          key: k, size: o.buf.length, uploaded: o.uploaded,
          httpMetadata: o.httpMetadata, customMetadata: o.customMetadata
        }));
      return { objects, truncated: false };
    }
  };
}

function env() { return { MUSIC_BUCKET: fakeBucket() }; }
function ctx(request, e, params) { return { request, env: e, params: params || {} }; }
async function readJSON(res) { return JSON.parse(await res.text()); }

/* ===================== 一、core 纯逻辑 ===================== */

test('toHex: 字节转小写十六进制', () => {
  assert.strictEqual(toHex(new Uint8Array([0, 15, 16, 255])), '000f10ff');
});

test('passProblem: 口令长度门槛与错误文案', () => {
  assert.ok(passProblem(''));
  assert.ok(passProblem('short'));
  assert.ok(new RegExp(String(MIN_PASS)).test(passProblem('12345')));
  assert.strictEqual(passProblem('0123456789'), null);
  assert.ok(passProblem('x'.repeat(129)));
  assert.strictEqual(isPassOk('0123456789'), true);
});

test('slugOf: 稳定、20 位十六进制、不同口令不冲突', async () => {
  const a = await slugOf(PASS);
  const b = await slugOf(PASS);
  const c = await slugOf(PASS + 'x');
  assert.strictEqual(a, b, '同一口令必须得到同一空间');
  assert.notStrictEqual(a, c);
  assert.match(a, /^[0-9a-f]{20}$/);
});

test('randomPass: 生成满足最小长度的可抄写口令', () => {
  const p = randomPass();
  assert.ok(p.length >= MIN_PASS);
  assert.match(p, /^[a-z2-9-]+$/);
  assert.notStrictEqual(randomPass(), randomPass());
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
  assert.strictEqual(parseRange(null, 1000), null);
  assert.strictEqual(parseRange('', 1000), null);
});

test('parseRange: 起止、开区间、后缀三种写法', () => {
  assert.deepStrictEqual(parseRange('bytes=0-499', 1000), { offset: 0, length: 500 });
  assert.deepStrictEqual(parseRange('bytes=500-', 1000), { offset: 500, length: 500 });
  assert.deepStrictEqual(parseRange('bytes=-200', 1000), { offset: 800, length: 200 });
  assert.deepStrictEqual(parseRange('bytes=0-', 1000), { offset: 0, length: 1000 });
});

test('parseRange: 末端越界被裁剪到文件末尾', () => {
  assert.deepStrictEqual(parseRange('bytes=900-99999', 1000), { offset: 900, length: 100 });
});

test('parseRange: 非法输入判定 invalid', () => {
  assert.strictEqual(parseRange('bytes=-', 1000), 'invalid');
  assert.strictEqual(parseRange('bytes=abc-def', 1000), 'invalid');
  assert.strictEqual(parseRange('bytes=600-500', 1000), 'invalid');
  assert.strictEqual(parseRange('bytes=1000-', 1000), 'invalid');
  assert.strictEqual(parseRange('bytes=-0', 1000), 'invalid');
  assert.strictEqual(parseRange('items=0-10', 1000), 'invalid');
  assert.strictEqual(parseRange('bytes=0-10', 0), 'invalid');
});

test('sanitizeState: 白名单字段，丢弃未知结构与脏数据', () => {
  const out = sanitizeState({
    lists: [{ id: 'all', name: '全部', ids: ['a', 'b'], evil: 1 }, { bad: true }, 'nope'],
    remote: [
      { id: 'r1', title: 'T', artist: 'A', url: 'https://x/1.mp3', duration: 12.6, junk: 'x' },
      { nope: true }
    ],
    lyrics: { t1: '[00:01.00]A', t2: 123 },
    settings: { theme: 'dark', volume: 0.5, hack: 'ignored' },
    stats: { t1: { c: 2.4, at: 100 }, bad: 'x' },
    progress: { t1: 42.567, t2: -5 },
    device: 'chrome',
    unknown: 'drop-me'
  });

  assert.deepStrictEqual(out.lists.map(l => l.id), ['all']);
  assert.strictEqual(out.lists[0].evil, undefined);
  assert.strictEqual(out.remote.length, 1);
  assert.strictEqual(out.remote[0].duration, 13);
  assert.strictEqual(out.remote[0].junk, undefined);
  assert.deepStrictEqual(out.lyrics, { t1: '[00:01.00]A' });
  assert.deepStrictEqual(out.settings, { theme: 'dark', volume: 0.5 });
  assert.strictEqual(out.stats.t1.c, 2);
  assert.strictEqual(out.progress.t1, 42.57);
  assert.strictEqual(out.progress.t2, undefined, '负数进度应被丢弃');
  assert.strictEqual(out.unknown, undefined);
  assert.strictEqual(typeof out.updatedAt, 'number');
});

test('sanitizeState: 非法入参返回 null', () => {
  assert.strictEqual(sanitizeState(null), null);
  assert.strictEqual(sanitizeState('str'), null);
  assert.strictEqual(sanitizeState(42), null);
});

test('newShareCode: 长度固定且不含易混字符', () => {
  const c = newShareCode();
  assert.strictEqual(c.length, 10);
  // 字母表刻意剔除 l / o 等易混字符
  assert.match(c, /^[a-km-np-z2-9]+$/);
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

test('列表: 缺少口令返回 401', async () => {
  const e = env();
  const res = await audio.onRequestGet(ctx(new Request('https://x/api/audio'), e));
  assert.strictEqual(res.status, 401);
});

test('列表: 口令过短同样 401', async () => {
  const e = env();
  const req = new Request('https://x/api/audio', { headers: { 'X-Coral-Key': '123' } });
  assert.strictEqual((await audio.onRequestGet(ctx(req, e))).status, 401);
});

test('列表: 未绑定 R2 时给出 503 而不是崩溃', async () => {
  const req = new Request('https://x/api/audio', { headers: { 'X-Coral-Key': PASS } });
  const res = await audio.onRequestGet(ctx(req, {}));
  assert.strictEqual(res.status, 503);
});

test('列表: 空空间返回 slug 与 0 条', async () => {
  const e = env();
  const req = new Request('https://x/api/audio', { headers: { 'X-Coral-Key': PASS } });
  const body = await readJSON(await audio.onRequestGet(ctx(req, e)));
  assert.strictEqual(body.slug, await slugOf(PASS));
  assert.strictEqual(body.count, 0);
  assert.deepStrictEqual(body.items, []);
});

test('上传: 非 multipart 请求被拒', async () => {
  const e = env();
  const req = new Request('https://x/api/audio', {
    method: 'POST', body: 'plain', headers: { 'X-Coral-Key': PASS }
  });
  assert.strictEqual((await audio.onRequestPost(ctx(req, e))).status, 400);
});

test('上传: 成功写入 R2 并给出 key', async () => {
  const e = env();
  const fd = new FormData();
  fd.append('file', new File([Buffer.from('audio-bytes-here')], '晴天.mp3', { type: 'audio/mpeg' }));
  fd.append('id', 'local-1001');
  fd.append('title', '晴天');
  fd.append('artist', '周杰伦');
  const req = new Request('https://x/api/audio', { method: 'POST', body: fd, headers: { 'X-Coral-Key': PASS } });

  const body = await readJSON(await audio.onRequestPost(ctx(req, e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.id, 'local-1001');
  assert.strictEqual(body.ext, 'mp3');

  const slug = await slugOf(PASS);
  assert.strictEqual(body.key, `audio/${slug}/local-1001.mp3`);
  const stored = e.MUSIC_BUCKET._store.get(body.key);
  assert.ok(stored, '对象应已写入存储');
  assert.strictEqual(stored.buf.toString('utf8'), 'audio-bytes-here');
  assert.strictEqual(stored.httpMetadata.contentType, 'audio/mpeg');
  assert.strictEqual(stored.customMetadata.title, '晴天');
});

test('上传后立即可在列表中看到', async () => {
  const e = env();
  const fd = new FormData();
  fd.append('file', new File([Buffer.from('x')], 'demo.wav', { type: 'audio/wav' }));
  fd.append('id', 'demo');
  await audio.onRequestPost(ctx(
    new Request('https://x/api/audio', { method: 'POST', body: fd, headers: { 'X-Coral-Key': PASS } }), e));

  const body = await readJSON(await audio.onRequestGet(ctx(
    new Request('https://x/api/audio', { headers: { 'X-Coral-Key': PASS } }), e)));
  assert.strictEqual(body.count, 1);
  assert.strictEqual(body.items[0].id, 'demo');
  assert.strictEqual(body.items[0].ext, 'wav');
  assert.strictEqual(body.items[0].size, 1);
});

test('上传: 缺少 file 字段被拒', async () => {
  const e = env();
  const fd = new FormData();
  fd.append('id', 'x');
  const req = new Request('https://x/api/audio', { method: 'POST', body: fd, headers: { 'X-Coral-Key': PASS } });
  assert.strictEqual((await audio.onRequestPost(ctx(req, e))).status, 400);
});

test('上传: 超限文件返回 413', async () => {
  const e = env();
  const big = Buffer.alloc(61 * 1024 * 1024, 1);
  const fd = new FormData();
  fd.append('file', new File([big], 'big.mp3', { type: 'audio/mpeg' }));
  const req = new Request('https://x/api/audio', { method: 'POST', body: fd, headers: { 'X-Coral-Key': PASS } });
  assert.strictEqual((await audio.onRequestPost(ctx(req, e))).status, 413);
});

/* ===================== 三、/api/audio/:id 播放与删除 ===================== */

async function seed(e, id, bytes, ext = 'mp3') {
  const slug = await slugOf(PASS);
  const key = `audio/${slug}/${id}.${ext}`;
  await e.MUSIC_BUCKET.put(key, Buffer.from(bytes), { httpMetadata: { contentType: contentTypeOf(ext) } });
  return { slug, key };
}

test('播放: 非法 slug 返回 401', async () => {
  const e = env();
  const req = new Request('https://x/api/audio/t1?s=not-a-slug');
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 't1' }))).status, 401);
});

test('播放: 曲目不存在返回 404', async () => {
  const e = env();
  const slug = await slugOf(PASS);
  const req = new Request('https://x/api/audio/ghost?s=' + slug);
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 'ghost' }))).status, 404);
});

test('播放: 完整下载返回 200 与 Accept-Ranges', async () => {
  const e = env();
  const { slug } = await seed(e, 't1', 'abcdefghij');
  const req = new Request('https://x/api/audio/t1?s=' + slug);
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('Content-Length'), '10');
  assert.strictEqual(res.headers.get('Accept-Ranges'), 'bytes');
  assert.match(res.headers.get('Content-Type'), /audio\/mpeg/);
  assert.strictEqual(await res.text(), 'abcdefghij');
});

test('播放: Range 请求返回 206 与正确分片（进度条拖动依赖）', async () => {
  const e = env();
  const { slug } = await seed(e, 't1', 'abcdefghij');
  const req = new Request('https://x/api/audio/t1?s=' + slug, { headers: { Range: 'bytes=2-5' } });
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.strictEqual(res.headers.get('Content-Length'), '4');
  assert.strictEqual(await res.text(), 'cdef');
});

test('播放: 非法 Range 返回 416 并带上总长度', async () => {
  const e = env();
  const { slug } = await seed(e, 't1', 'abcdefghij');
  const req = new Request('https://x/api/audio/t1?s=' + slug, { headers: { Range: 'bytes=99-200' } });
  const res = await audioId.onRequestGet(ctx(req, e, { id: 't1' }));
  assert.strictEqual(res.status, 416);
  assert.strictEqual(res.headers.get('Content-Range'), 'bytes */10');
});

test('播放: 用别的 slug 读不到他人的曲目（空间隔离）', async () => {
  const e = env();
  await seed(e, 't1', 'secret-audio');
  const otherSlug = await slugOf('another-pass-2026');
  const req = new Request('https://x/api/audio/t1?s=' + otherSlug);
  assert.strictEqual((await audioId.onRequestGet(ctx(req, e, { id: 't1' }))).status, 404);
});

test('删除: 缺少口令 401，有口令正常删除', async () => {
  const e = env();
  const { slug, key } = await seed(e, 't1', 'abc');
  assert.strictEqual(
    (await audioId.onRequestDelete(ctx(new Request('https://x/api/audio/t1'), e, { id: 't1' }))).status, 401);

  const req = new Request('https://x/api/audio/t1', { method: 'DELETE', headers: { 'X-Coral-Key': PASS } });
  const body = await readJSON(await audioId.onRequestDelete(ctx(req, e, { id: 't1' })));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(e.MUSIC_BUCKET._store.has(key), false);
  assert.strictEqual(slug, await slugOf(PASS));
});

test('删除: 不存在的曲目返回 404', async () => {
  const e = env();
  const req = new Request('https://x/api/audio/ghost', { method: 'DELETE', headers: { 'X-Coral-Key': PASS } });
  assert.strictEqual((await audioId.onRequestDelete(ctx(req, e, { id: 'ghost' }))).status, 404);
});

/* ===================== 四、/api/state 同步 ===================== */

test('同步: 空空间返回 empty 标记', async () => {
  const e = env();
  const req = new Request('https://x/api/state', { headers: { 'X-Coral-Key': PASS } });
  const body = await readJSON(await stateApi.onRequestGet(ctx(req, e)));
  assert.strictEqual(body.empty, true);
  assert.strictEqual(body.state, null);
});

test('同步: 上传后能原样读回（含统计与进度）', async () => {
  const e = env();
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
  const putRes = await stateApi.onRequestPut(ctx(new Request('https://x/api/state', {
    method: 'PUT', body: JSON.stringify(payload), headers: { 'X-Coral-Key': PASS }
  }), e));
  const putBody = await readJSON(putRes);
  assert.strictEqual(putBody.ok, true);
  assert.strictEqual(putBody.counts.lists, 1);
  assert.strictEqual(putBody.counts.stats, 1);

  const getBody = await readJSON(await stateApi.onRequestGet(ctx(
    new Request('https://x/api/state', { headers: { 'X-Coral-Key': PASS } }), e)));
  assert.strictEqual(getBody.empty, false);
  assert.strictEqual(getBody.state.lists[0].ids[0], 't1');
  assert.strictEqual(getBody.state.stats.t1.c, 3);
  assert.strictEqual(getBody.state.progress.t1, 12.5);
  assert.ok(getBody.updatedAt > 0);
});

test('同步: 直接传 state 对象（不裹一层）也能存', async () => {
  const e = env();
  await stateApi.onRequestPut(ctx(new Request('https://x/api/state', {
    method: 'PUT', body: JSON.stringify({ lists: [{ id: 'x', name: 'X', ids: [] }] }),
    headers: { 'X-Coral-Key': PASS }
  }), e));
  const body = await readJSON(await stateApi.onRequestGet(ctx(
    new Request('https://x/api/state', { headers: { 'X-Coral-Key': PASS } }), e)));
  assert.strictEqual(body.state.lists[0].id, 'x');
});

test('同步: 坏 JSON 返回 400', async () => {
  const e = env();
  const req = new Request('https://x/api/state', {
    method: 'PUT', body: '{不是 JSON', headers: { 'X-Coral-Key': PASS }
  });
  assert.strictEqual((await stateApi.onRequestPut(ctx(req, e))).status, 400);
});

test('同步: 缺少口令时读写都被拒', async () => {
  const e = env();
  assert.strictEqual((await stateApi.onRequestGet(ctx(new Request('https://x/api/state'), e))).status, 401);
  assert.strictEqual((await stateApi.onRequestPut(ctx(new Request('https://x/api/state', {
    method: 'PUT', body: '{}'
  }), e))).status, 401);
});

test('同步: 两个口令互不干扰', async () => {
  const e = env();
  const other = 'other-pass-2026x';
  await stateApi.onRequestPut(ctx(new Request('https://x/api/state', {
    method: 'PUT', body: JSON.stringify({ lists: [{ id: 'mine', name: 'M', ids: [] }] }),
    headers: { 'X-Coral-Key': PASS }
  }), e));

  const body = await readJSON(await stateApi.onRequestGet(ctx(
    new Request('https://x/api/state', { headers: { 'X-Coral-Key': other } }), e)));
  assert.strictEqual(body.empty, true, '另一口令应看到自己的空空间');
});

/* ===================== 五、/api/proxy 代理 ===================== */

function withFetchStub(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}

test('代理: 缺少或非法 slug 返回 401', async () => {
  const url = 'https://x/api/proxy?u=' + encodeURIComponent('https://api.audius.co/v1/tracks/1/stream');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), env()))).status, 401);
});

test('代理: 非白名单域名返回 403', async () => {
  const slug = await slugOf(PASS);
  const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://evil.example.com/a.mp3');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), env()))).status, 403);
});

test('代理: 非 https 目标返回 400', async () => {
  const slug = await slugOf(PASS);
  const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('http://api.audius.co/a.mp3');
  assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), env()))).status, 400);
});

test('代理: 白名单音源正常回传并透传 Range 头', async () => {
  const slug = await slugOf(PASS);
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
    const res = await proxyApi.onRequestGet(ctx(new Request(url, { headers: { Range: 'bytes=0-12' } }), env()));
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
  const slug = await slugOf(PASS);
  await withFetchStub(async () => new Response('<html>oops</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  }), async () => {
    const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://api.audius.co/x');
    assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), env()))).status, 415);
  });
});

test('代理: 上游 404 转成 502', async () => {
  const slug = await slugOf(PASS);
  await withFetchStub(async () => new Response('nope', { status: 404 }), async () => {
    const url = 'https://x/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://api.audius.co/x');
    assert.strictEqual((await proxyApi.onRequestGet(ctx(new Request(url), env()))).status, 502);
  });
});

/* ===================== 六、/api/ping 自检 ===================== */

test('自检: 绑定正常时返回 ok 与空间信息', async () => {
  const e = env();
  const req = new Request('https://x/api/ping', { headers: { 'X-Coral-Key': PASS } });
  const body = await readJSON(await pingApi.onRequestGet(ctx(req, e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.hasBucket, true);
  assert.strictEqual(body.bucketOk, true);
  assert.strictEqual(body.slug, await slugOf(PASS));
  assert.strictEqual(body.cloudTracks, 0);
});

test('自检: 未绑定 R2 时 ok=false 且给出原因', async () => {
  const body = await readJSON(await pingApi.onRequestGet(ctx(new Request('https://x/api/ping'), {})));
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.hasBucket, false);
  assert.match(body.reason, /MUSIC_BUCKET/);
});

test('自检: 不带口令也能用（只报绑定状态）', async () => {
  const body = await readJSON(await pingApi.onRequestGet(ctx(new Request('https://x/api/ping'), env())));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.slug, undefined);
});
