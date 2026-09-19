/* tests/probe/cloud-e2e.mjs — 云端链路端到端验证（真实 Pages 运行时）
 *
 * 为什么要它：单元测试用的是自造的内存 R2 替身，能验证「我的代码逻辑对」，
 * 但证明不了「在 Cloudflare Pages 的运行时里跑得起来」——ESM 导入、R2 binding 的
 * api 形态、Range 响应头、multipart 解析这些只有真运行时才说了算。
 *
 * 做法：拉起 `wrangler pages dev`（本地 Pages 运行时 + 本地模拟 R2），
 * 用真实 HTTP 请求把「上传 → 列表 → 播放 → 拖动(Range) → 同步 → 删除」走一遍。
 *
 * 用法：node tests/probe/cloud-e2e.mjs
 * 说明：不触碰线上资源（wrangler pages dev 默认用本地模拟存储，不加 --remote）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8788;
const BASE = 'http://127.0.0.1:' + PORT;
const PASS = 'e2e-probe-pass-2026';

const NODE_DIR = path.dirname(process.execPath);
const NPX = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js');

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra === undefined ? '' : '   → ' + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hdrs(extra = {}) { return Object.assign({ 'X-Coral-Key': PASS }, extra); }

async function waitReady(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/ping', { headers: hdrs() });
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(700);
  }
  return null;
}

const child = spawn(process.execPath, [NPX, '--yes', 'wrangler@latest', 'pages', 'dev', '.',
  '--port', String(PORT), '--ip', '127.0.0.1'], {
  cwd: ROOT,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

try {
  console.log('\n── 云端链路 E2E（真实 Pages 运行时）──\n');
  console.log('  启动 wrangler pages dev（首次需要准备运行时，请稍候）…');
  const ping = await waitReady();
  if (!ping) {
    check('wrangler pages dev 启动', false, serverLog.split('\n').slice(-6).join(' | '));
    throw new Error('运行时未就绪');
  }
  check('wrangler pages dev 启动并就绪', true);
  check('自检端点 /api/ping 正常', ping.ok === true, JSON.stringify(ping));
  check('R2 绑定 MUSIC_BUCKET 可用', ping.hasBucket === true && ping.bucketOk === true);
  check('自检回显口令派生出的空间标识', /^[0-9a-f]{20}$/.test(ping.slug || ''), ping.slug);
  const slug = ping.slug;

  // ---- 上传 ----
  const audioBytes = Buffer.from('CORAL-E2E-AUDIO-' + 'x'.repeat(500));
  const fd = new FormData();
  fd.append('file', new File([audioBytes], 'e2e-song.mp3', { type: 'audio/mpeg' }));
  fd.append('id', 'e2e-track-1');
  fd.append('title', '端到端测试曲');
  fd.append('artist', '探测者');
  const up = await (await fetch(BASE + '/api/audio', { method: 'POST', body: fd, headers: hdrs() })).json();
  check('上传音频到 R2', up.ok === true && /e2e-track-1\.mp3$/.test(up.key || ''), JSON.stringify(up));
  check('上传回显大小正确', up.size === audioBytes.length, 'size=' + up.size);

  // ---- 列表 ----
  const listed = await (await fetch(BASE + '/api/audio', { headers: hdrs() })).json();
  const hit = (listed.items || []).filter((i) => i.id === 'e2e-track-1')[0];
  check('列表能看到刚上传的曲目', !!hit, 'count=' + listed.count);
  check('列表带出标题与歌手（R2 自定义元数据）',
    hit && hit.title === '端到端测试曲' && hit.artist === '探测者',
    hit ? JSON.stringify({ title: hit.title, artist: hit.artist }) : '（未找到对象）');
  check('列表带出文件大小', !!hit && hit.size === audioBytes.length, hit ? 'size=' + hit.size : '');

  // ---- 播放（完整） ----
  const full = await fetch(BASE + '/api/audio/e2e-track-1?s=' + slug);
  check('播放返回 200', full.status === 200, 'status=' + full.status);
  check('播放声明 Accept-Ranges（拖动进度条的前提）', full.headers.get('accept-ranges') === 'bytes');
  check('播放 Content-Type 为音频', /audio\//.test(full.headers.get('content-type') || ''), full.headers.get('content-type'));
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check('播放内容与上传一致', fullBuf.equals(audioBytes), 'got=' + fullBuf.length + ' expect=' + audioBytes.length);

  // ---- 播放（Range：模拟拖动进度条） ----
  const part = await fetch(BASE + '/api/audio/e2e-track-1?s=' + slug, { headers: { Range: 'bytes=0-9' } });
  const partBuf = Buffer.from(await part.arrayBuffer());
  check('Range 请求返回 206', part.status === 206, 'status=' + part.status);
  check('Range 响应头正确', part.headers.get('content-range') === 'bytes 0-9/' + audioBytes.length,
    part.headers.get('content-range'));
  check('Range 分片内容正确', partBuf.equals(audioBytes.subarray(0, 10)), partBuf.toString());

  const badRange = await fetch(BASE + '/api/audio/e2e-track-1?s=' + slug, { headers: { Range: 'bytes=99999-' } });
  check('越界 Range 返回 416', badRange.status === 416, 'status=' + badRange.status);

  // ---- 空间隔离 ----
  const other = await fetch(BASE + '/api/audio/e2e-track-1?s=' + '0'.repeat(20));
  check('其他空间标识读不到本空间曲目', other.status === 404, 'status=' + other.status);

  const noKey = await fetch(BASE + '/api/audio');
  check('无口令访问列表被拒（401）', noKey.status === 401, 'status=' + noKey.status);

  // ---- 同步 ----
  const state = {
    state: {
      lists: [{ id: 'all', name: '全部', ids: ['e2e-track-1'] }],
      remote: [{ id: 'e2e-track-1', title: '端到端测试曲', artist: '探测者', url: '/api/audio/e2e-track-1?s=' + slug }],
      lyrics: { 'e2e-track-1': '[00:01.00]第一句' },
      settings: { theme: 'dark', volume: 0.5, eq: [1, 0, -1] },
      stats: { 'e2e-track-1': { c: 2, at: 1789000000000 } },
      progress: { 'e2e-track-1': 12.5 }
    }
  };
  const put = await (await fetch(BASE + '/api/state', {
    method: 'PUT', body: JSON.stringify(state), headers: hdrs({ 'Content-Type': 'application/json' })
  })).json();
  check('上传歌单快照成功', put.ok === true, JSON.stringify(put.counts));
  check('快照统计了各字段条数', put.counts && put.counts.lists === 1 && put.counts.stats === 1);

  const got = await (await fetch(BASE + '/api/state', { headers: hdrs() })).json();
  check('读回快照', got.empty === false && got.state.lists[0].ids[0] === 'e2e-track-1');
  check('读回的快照保留歌词与进度', got.state.lyrics['e2e-track-1'] === '[00:01.00]第一句' && got.state.progress['e2e-track-1'] === 12.5);

  // ---- 代理白名单 ----
  const denied = await fetch(BASE + '/api/proxy?s=' + slug + '&u=' + encodeURIComponent('https://evil.example.com/a.mp3'));
  check('代理拒绝白名单外域名（403）', denied.status === 403, 'status=' + denied.status);
  const badScheme = await fetch(BASE + '/api/proxy?s=' + slug + '&u=' + encodeURIComponent('http://api.audius.co/a.mp3'));
  check('代理拒绝非 https 目标（400）', badScheme.status === 400, 'status=' + badScheme.status + '（本地 fetch http 会失败，此处只验证入参校验）');

  // ---- 删除 ----
  const del = await (await fetch(BASE + '/api/audio/e2e-track-1', { method: 'DELETE', headers: hdrs() })).json();
  check('删除云端曲目', del.ok === true);
  const after = await fetch(BASE + '/api/audio/e2e-track-1?s=' + slug);
  check('删除后不再可播放（404）', after.status === 404, 'status=' + after.status);
  const delAgain = await fetch(BASE + '/api/audio/e2e-track-1', { method: 'DELETE', headers: hdrs() });
  check('重复删除返回 404', delAgain.status === 404, 'status=' + delAgain.status);
} catch (e) {
  check('E2E 执行完成', false, e && e.message);
} finally {
  try { child.kill(); } catch (e) {}
  // wrangler 会派生 workerd 子进程，Windows 下需按进程树清理
  await sleep(500);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 项通过');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'));
  process.exit(1);
}
console.log('云端端到端验证全部通过 ✓');
process.exit(0);
