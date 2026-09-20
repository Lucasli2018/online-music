/* tests/probe/cloud-e2e.mjs — 云端链路端到端验证（真实 Pages 运行时）
 *
 * 为什么要它：单元测试用的是自造的内存 R2 / D1 替身，能验证「我的代码逻辑对」，
 * 但证明不了「在 Cloudflare Pages 的运行时里跑得起来」——ESM 导入、R2 binding 的
 * api 形态、Range 响应头、multipart 解析、D1 的 prepare/bind 语义，
 * 这些只有真运行时才说了算。
 *
 * 做法：先把 migrations 应用到本地 D1，再拉起 `wrangler pages dev`（本地模拟 R2 + D1），
 * 用真实 HTTP 请求把「注册 → 登录 → 上传 → 列表 → 播放 → 拖动(Range) → 同步 → 接管旧空间 → 登出」
 * 走一遍。
 *
 * 用法：node tests/probe/cloud-e2e.mjs
 * 说明：不触碰线上资源（wrangler pages dev 默认用本地模拟存储，不加 --remote）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Acc from '../../functions/_lib/account.mjs';
import { slugOf } from '../../functions/_lib/core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8788;
const BASE = 'http://127.0.0.1:' + PORT;
const PERSIST = '.wrangler-dev-state';
const DB_NAME = 'online-music-db';

const NODE_DIR = path.dirname(process.execPath);
const NPX = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js');

/* 定位 wrangler 入口：优先用本机已安装的那份。
 * 为什么不用 npx：npx 会先去动自己的缓存目录（safe-delete），在受限环境里会直接挂掉；
 * 而且每次都可能联网拉最新版。找不到本地安装时才回退 npx。
 * 注意 Windows 必须传盘符风格路径（D:/...）——Git Bash 风格的 /d/... 会被 Node 当成 "F:\d\..."。 */
const WRANGLER_CANDIDATES = [
  process.env.WRANGLER_BIN,
  'D:/npm-global/node_modules/wrangler/bin/wrangler.js',
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/wrangler/bin/wrangler.js',
  path.join(NODE_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
].filter(Boolean);
const WRANGLER_JS = WRANGLER_CANDIDATES.filter((p) => {
  try { return fs.existsSync(p); } catch (e) { return false; }
})[0] || '';

function wranglerArgs(args) {
  return WRANGLER_JS
    ? [WRANGLER_JS].concat(args)
    : [NPX, '--yes', 'wrangler@latest'].concat(args);
}

/* 本次探针用的账号（用户名带随机后缀，避免与上次残留冲突） */
const SUFFIX = Date.now().toString(36).slice(-6);
const USER_A = 'e2ea' + SUFFIX;
const USER_C = 'e2ec' + SUFFIX;
const USER_OLD = 'e2eold' + SUFFIX;      // 预置的「v1 空间持有者」，用来喂接管流程
const PASSWORD = 'e2e-secret-2026';
// 旧口令也带后缀：否则 slugOf() 每次都算出同一个空间标识，第二次跑会撞上 users.space_slug 唯一索引
const OLD_PASS = 'e2e-old-pass-' + SUFFIX;
const OLD_TOKEN = Acc.genToken(32);      // 预置账号的会话令牌，写完 D1 直接拿来用

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra === undefined ? '' : '   → ' + extra));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = '';
function auth(extra = {}) { return Object.assign({ Authorization: 'Bearer ' + token }, extra); }
function jsonAuth(extra = {}) { return auth(Object.assign({ 'Content-Type': 'application/json' }, extra)); }

function wrangler(args) {
  return spawnSync(process.execPath, wranglerArgs(args), {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, env: process.env
  });
}

async function waitReady(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/ping');
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(700);
  }
  return null;
}

/* ---------- 1) 准备本地 D1（应用 migrations） ---------- */
console.log('\n── 云端链路 E2E（真实 Pages 运行时 + 本地 R2 / D1）──\n');
console.log('  应用 D1 migrations 到本地模拟库…');
const mig = wrangler(['d1', 'migrations', 'apply', DB_NAME, '--local', '--persist-to', PERSIST]);
const migOut = (mig.stdout || '') + (mig.stderr || '');
if (mig.status !== 0) {
  console.log('  migrations 输出：\n' + migOut.split('\n').slice(-15).join('\n'));
}

/* 在运行时启动之前，往本地 D1 预置一个「v1 空间持有者」：
 * 它的空间标识被直接写成 slugOf(旧口令)，于是它上传的东西天然落在那个「旧空间」里，
 * 正好可以被别的账号用旧口令接管走。
 *
 * 为什么不在运行时起来之后再改：wrangler d1 execute 与运行中的 workerd 同时写同一个
 * SQLite 文件会撞锁（SQLITE_BUSY），时好时坏。启动前一次性写死最稳，
 * 而且顺带覆盖了「手工构造的历史数据」这个真实场景。 */
async function seedOldSpaceUser() {
  const oldSlug = await slugOf(OLD_PASS);
  const salt = Acc.genSalt();
  const hash = await Acc.hashPassword(PASSWORD, salt, 1000);
  const now = Acc.nowStr();
  const sql = [
    'INSERT INTO users (username, display_name, pass_hash, pass_salt, pass_iter, space_slug, created_at)',
    "VALUES ('" + USER_OLD + "', '旧空间持有者', '" + hash + "', '" + salt + "', 1000, '" + oldSlug + "', '" + now + "');",
    'INSERT INTO sessions (token, user_id, created_at, expires_at, agent)',
    "VALUES ('" + OLD_TOKEN + "', (SELECT id FROM users WHERE username = '" + USER_OLD + "'), '" + now + "', '" + Acc.expiresStr(30) + "', 'probe');"
  ].join('\n');

  fs.writeFileSync(path.join(ROOT, PERSIST, '_probe_seed.sql'), sql, 'utf8');

  let last = null;
  for (let i = 0; i < 3; i++) {
    last = wrangler(['d1', 'execute', DB_NAME, '--local', '--persist-to', PERSIST,
      '--file', path.join(PERSIST, '_probe_seed.sql'), '--yes']);
    if (last.status === 0) break;
    await sleep(1200);
  }
  return { oldSlug, ok: !!(last && last.status === 0), detail: last };
}

console.log('  预置「v1 空间持有者」账号（空间标识 = slugOf(旧口令)）…');
const seeded = await seedOldSpaceUser();
const oldSlug = seeded.oldSlug;
if (!seeded.ok) {
  console.log('  预置失败，输出：\n' + ((seeded.detail && (seeded.detail.stdout + seeded.detail.stderr)) || '').split('\n').slice(-12).join('\n'));
}

/* ---------- 2) 启动 Pages 运行时 ---------- */
const child = spawn(process.execPath, wranglerArgs(['pages', 'dev', '.',
  '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', PERSIST]), {
  cwd: ROOT,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

const t0 = Date.now();
try {
  console.log('  启动 wrangler pages dev（首次需要准备运行时，请稍候）…');
  const ping = await waitReady();
  if (!ping) {
    check('wrangler pages dev 启动', false, serverLog.split('\n').slice(-8).join(' | '));
    throw new Error('运行时未就绪');
  }
  check('wrangler pages dev 启动并就绪', true, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  check('自检端点 /api/ping 正常', ping.ok === true, JSON.stringify(ping));
  check('R2 绑定 MUSIC_BUCKET 可用', ping.hasBucket === true && ping.bucketOk === true);
  check('D1 绑定 DB 可用（账号表已建）', ping.hasDb === true && ping.dbOk === true,
    ping.reason || 'accounts=' + ping.accounts);
  check('鉴权模型已是账号制', ping.auth === 'account', String(ping.auth));
  check('未登录时自检仍可用且不算错误', ping.loggedIn === false && ping.authError === undefined);

  // ---- 注册 ----
  let t = Date.now();
  const regRes = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER_A, password: PASSWORD, displayName: '探测者A' })
  });
  const regMs = Date.now() - t;
  const reg = await regRes.json();
  check('注册账号返回 201', regRes.status === 201, 'status=' + regRes.status + ' ' + JSON.stringify(reg.error || ''));
  check('注册即签发会话令牌', /^[0-9a-f]{64}$/.test(reg.token || ''), (reg.token || '').slice(0, 12) + '…');
  check('空间 slug 随机生成且与密码无关', /^[0-9a-f]{20}$/.test((reg.user || {}).spaceSlug || ''),
    (reg.user || {}).spaceSlug);
  check('注册响应不含任何密码派生值',
    reg.user && reg.user.pass_hash === undefined && reg.user.pass_salt === undefined);
  console.log('        · 注册耗时（含 PBKDF2 派生）：' + regMs + ' ms');
  token = reg.token;
  const slugA = reg.user.spaceSlug;

  // ---- 注册的边界 ----
  const dup = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER_A.toUpperCase(), password: PASSWORD })
  });
  check('重复用户名（含大小写差异）返回 409', dup.status === 409, 'status=' + dup.status);

  const weak = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2eweak' + SUFFIX, password: '123' })
  });
  check('弱密码返回 400', weak.status === 400, 'status=' + weak.status);

  // ---- me ----
  const me = await (await fetch(BASE + '/api/auth/me', { headers: auth() })).json();
  check('/api/auth/me 返回当前账号', me.ok === true && me.user.username === USER_A, JSON.stringify(me.user || {}));
  check('me 不泄露密码派生值', me.user.pass_hash === undefined && me.user.pass_salt === undefined);
  check('未登录访问 me 返回 401',
    (await fetch(BASE + '/api/auth/me')).status === 401);

  // ---- 上传 ----
  const audioBytes = Buffer.from('CORAL-E2E-AUDIO-' + 'x'.repeat(500));
  const fd = new FormData();
  fd.append('file', new File([audioBytes], 'e2e-song.mp3', { type: 'audio/mpeg' }));
  fd.append('id', 'e2e-track-1');
  fd.append('title', '端到端测试曲');
  fd.append('artist', '探测者');
  const up = await (await fetch(BASE + '/api/audio', { method: 'POST', body: fd, headers: auth() })).json();
  check('上传音频到 R2', up.ok === true && /e2e-track-1\.mp3$/.test(up.key || ''), JSON.stringify(up));
  check('上传写入的是账号空间', up.key === 'audio/' + slugA + '/e2e-track-1.mp3', up.key);
  check('上传回显大小正确', up.size === audioBytes.length, 'size=' + up.size);

  const anonUp = new FormData();
  anonUp.append('file', new File([Buffer.from('x')], 'anon.mp3', { type: 'audio/mpeg' }));
  check('未登录上传被拒（401）',
    (await fetch(BASE + '/api/audio', { method: 'POST', body: anonUp })).status === 401);

  // ---- 列表 ----
  const listed = await (await fetch(BASE + '/api/audio', { headers: auth() })).json();
  const hit = (listed.items || []).filter((i) => i.id === 'e2e-track-1')[0];
  check('列表能看到刚上传的曲目', !!hit, 'count=' + listed.count);
  check('列表带出标题与歌手（R2 自定义元数据）',
    hit && hit.title === '端到端测试曲' && hit.artist === '探测者',
    hit ? JSON.stringify({ title: hit.title, artist: hit.artist }) : '（未找到对象）');
  check('列表带出文件大小', !!hit && hit.size === audioBytes.length, hit ? 'size=' + hit.size : '');

  // ---- 播放（完整） ----
  const full = await fetch(BASE + '/api/audio/e2e-track-1?s=' + slugA);
  check('播放返回 200（无需令牌）', full.status === 200, 'status=' + full.status);
  check('播放声明 Accept-Ranges（拖动进度条的前提）', full.headers.get('accept-ranges') === 'bytes');
  check('播放 Content-Type 为音频', /audio\//.test(full.headers.get('content-type') || ''), full.headers.get('content-type'));
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check('播放内容与上传一致', fullBuf.equals(audioBytes), 'got=' + fullBuf.length + ' expect=' + audioBytes.length);

  // ---- 播放（Range：模拟拖动进度条） ----
  const part = await fetch(BASE + '/api/audio/e2e-track-1?s=' + slugA, { headers: { Range: 'bytes=0-9' } });
  const partBuf = Buffer.from(await part.arrayBuffer());
  check('Range 请求返回 206', part.status === 206, 'status=' + part.status);
  check('Range 响应头正确', part.headers.get('content-range') === 'bytes 0-9/' + audioBytes.length,
    part.headers.get('content-range'));
  check('Range 分片内容正确', partBuf.equals(audioBytes.subarray(0, 10)), partBuf.toString());
  check('越界 Range 返回 416',
    (await fetch(BASE + '/api/audio/e2e-track-1?s=' + slugA, { headers: { Range: 'bytes=99999-' } })).status === 416);

  // ---- 空间隔离 ----
  const other = await fetch(BASE + '/api/audio/e2e-track-1?s=' + '0'.repeat(20));
  check('其他空间标识读不到本空间曲目', other.status === 404, 'status=' + other.status);
  check('无令牌访问列表被拒（401）', (await fetch(BASE + '/api/audio')).status === 401);
  check('伪造令牌访问列表被拒（401）',
    (await fetch(BASE + '/api/audio', { headers: { Authorization: 'Bearer ' + 'f'.repeat(64) } })).status === 401);

  // ---- 同步 ----
  const state = {
    state: {
      lists: [{ id: 'all', name: '全部', ids: ['e2e-track-1'] }],
      remote: [{ id: 'e2e-track-1', title: '端到端测试曲', artist: '探测者', url: '/api/audio/e2e-track-1?s=' + slugA }],
      lyrics: { 'e2e-track-1': '[00:01.00]第一句' },
      settings: { theme: 'dark', volume: 0.5, eq: [1, 0, -1] },
      stats: { 'e2e-track-1': { c: 2, at: 1789000000000 } },
      progress: { 'e2e-track-1': 12.5 }
    }
  };
  const put = await (await fetch(BASE + '/api/state', {
    method: 'PUT', body: JSON.stringify(state), headers: jsonAuth()
  })).json();
  check('上传歌单快照成功', put.ok === true, JSON.stringify(put.counts));
  check('快照统计了各字段条数', put.counts && put.counts.lists === 1 && put.counts.stats === 1);

  const got = await (await fetch(BASE + '/api/state', { headers: auth() })).json();
  check('读回快照', got.empty === false && got.state.lists[0].ids[0] === 'e2e-track-1');
  check('读回的快照保留歌词与进度',
    got.state.lyrics['e2e-track-1'] === '[00:01.00]第一句' && got.state.progress['e2e-track-1'] === 12.5);
  check('未登录读快照被拒（401）', (await fetch(BASE + '/api/state')).status === 401);

  // ---- 登出与再登录 ----
  const meTime0 = Date.now();
  check('登出接口返回 ok',
    (await (await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: auth() })).json()).ok === true);
  check('登出后令牌立即失效（401）', (await fetch(BASE + '/api/auth/me', { headers: auth() })).status === 401);

  const badLogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER_A, password: 'not-the-password' })
  });
  check('错误密码登录返回 401', badLogin.status === 401, 'status=' + badLogin.status);

  t = Date.now();
  const loginRes = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER_A, password: PASSWORD })
  });
  const loginMs = Date.now() - t;
  const login = await loginRes.json();
  check('重新登录成功并签发新令牌', loginRes.status === 200 && /^[0-9a-f]{64}$/.test(login.token || ''),
    'status=' + loginRes.status);
  check('重新登录后空间标识不变', login.user.spaceSlug === slugA, login.user.spaceSlug);
  console.log('        · 登录耗时（含 PBKDF2 校验）：' + loginMs + ' ms');
  if (loginMs > 200) {
    console.log('        · 提示：本地 workerd 是调试构建，PBKDF2 比线上慢不少；');
    console.log('          这是墙钟耗时，不是 CPU 时间。线上真实值要用一次真实登录确认，');
    console.log('          若线上报 500 / 1102（CPU time exceeded）就把 AUTH_ITER 降下来。');
  }
  check('登录耗时未超时（PBKDF2 迭代数适合当前运行时）', loginMs < 5000, loginMs + ' ms');
  token = login.token;

  check('登录后仍能读到之前同步的快照',
    (await (await fetch(BASE + '/api/state', { headers: auth() })).json()).state.lists[0].id === 'all');
  const meTime1 = Date.now() - meTime0;

  // ---- 旧「同步口令」空间接管 ----
  // 「旧空间」（空间标识 = slugOf(旧口令)）已在启动运行时之前预置好，这里直接用它的令牌上传，
  // 于是对象落在旧空间里，正好可以让 A 通过旧口令接管过去。
  check('预置的 v1 空间持有者账号已就位', seeded.ok, oldSlug);

  const oldFd = new FormData();
  oldFd.append('file', new File([Buffer.from('OLD-SPACE-AUDIO-1')], 'old-1.mp3', { type: 'audio/mpeg' }));
  oldFd.append('id', 'old-1');
  oldFd.append('title', '老歌一');
  const bHeaders = { Authorization: 'Bearer ' + OLD_TOKEN };
  const oldUp = await (await fetch(BASE + '/api/audio', { method: 'POST', body: oldFd, headers: bHeaders })).json();
  check('旧空间里放入一首歌', oldUp.ok === true, JSON.stringify(oldUp));
  check('旧空间的 key 正是 slugOf(旧口令)',
    oldUp.key === 'audio/' + oldSlug + '/old-1.mp3', oldUp.key);

  await fetch(BASE + '/api/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OLD_TOKEN },
    body: JSON.stringify({ state: { lists: [{ id: 'all', name: '旧歌单', ids: ['old-1'] }] } })
  });

  const adoptRes = await fetch(BASE + '/api/auth/adopt', {
    method: 'POST', headers: jsonAuth(), body: JSON.stringify({ oldPass: OLD_PASS, batch: 10 })
  });
  const adopt = await adoptRes.json();
  check('接管旧口令空间成功', adoptRes.status === 200 && adopt.ok === true, JSON.stringify(adopt));
  check('接管复制了旧空间的音频', adopt.copied >= 1, 'copied=' + adopt.copied + ' total=' + adopt.total);
  // 账号 A 前面已经同步过自己的歌单，所以旧空间的备份必须被让开 —— 接管不能覆盖已有数据
  check('账号已有备份时不覆盖（state=skipped）', adopt.state === 'skipped', 'state=' + adopt.state);

  const afterAdopt = await (await fetch(BASE + '/api/audio', { headers: auth() })).json();
  const adopted = (afterAdopt.items || []).filter((i) => i.id === 'old-1')[0];
  check('接管后账号 A 的云端曲库里有那首老歌', !!adopted, 'count=' + afterAdopt.count);
  check('接管保留了原始元数据', adopted && adopted.title === '老歌一', adopted ? adopted.title : '');
  const adoptedState = await (await fetch(BASE + '/api/state', { headers: auth() })).json();
  check('接管未覆盖账号 A 已有的快照', adoptedState.state.lists[0].id === 'all', adoptedState.state.lists[0].id);

  const dupAdopt = await (await fetch(BASE + '/api/auth/adopt', {
    method: 'POST', headers: jsonAuth(), body: JSON.stringify({ oldPass: OLD_PASS, batch: 10 })
  })).json();
  check('重复接管幂等（不再重复复制）', dupAdopt.copied === 0 && dupAdopt.skipped >= 1, JSON.stringify(dupAdopt));
  check('接管不影响源空间数据（只复制不删除）',
    (await fetch(BASE + '/api/audio/old-1?s=' + oldSlug)).status === 200);

  // 换一个「还没有任何备份」的账号再接管一次：这次旧空间的歌单备份应当被接管过来
  const regC = await (await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER_C, password: PASSWORD })
  })).json();
  const adoptC = await (await fetch(BASE + '/api/auth/adopt', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + regC.token },
    body: JSON.stringify({ oldPass: OLD_PASS, batch: 10 })
  })).json();
  check('空账号接管控到歌单备份（state=adopted）', adoptC.state === 'adopted', JSON.stringify(adoptC));
  const stateC = await (await fetch(BASE + '/api/state', {
    headers: { Authorization: 'Bearer ' + regC.token }
  })).json();
  check('接管过来的歌单内容可用', stateC.state && stateC.state.lists[0].name === '旧歌单',
    JSON.stringify((stateC.state || {}).lists || null));

  const adoptShort = await fetch(BASE + '/api/auth/adopt', {
    method: 'POST', headers: jsonAuth(), body: JSON.stringify({ oldPass: 'short' })
  });
  check('接管接口拒绝过短的旧口令（400）', adoptShort.status === 400, 'status=' + adoptShort.status);

  // ---- 代理白名单 ----
  const denied = await fetch(BASE + '/api/proxy?s=' + slugA + '&u=' + encodeURIComponent('https://evil.example.com/a.mp3'));
  check('代理拒绝白名单外域名（403）', denied.status === 403, 'status=' + denied.status);
  check('代理拒绝不对应任何账号的 slug（401）',
    (await fetch(BASE + '/api/proxy?s=' + '1'.repeat(20) + '&u=' + encodeURIComponent('https://api.audius.co/a.mp3'))).status === 401);
  const badScheme = await fetch(BASE + '/api/proxy?s=' + slugA + '&u=' + encodeURIComponent('http://api.audius.co/a.mp3'));
  check('代理拒绝非 https 目标（400）', badScheme.status === 400, 'status=' + badScheme.status);

  // ---- 删除 ----
  const del = await (await fetch(BASE + '/api/audio/e2e-track-1', { method: 'DELETE', headers: auth() })).json();
  check('删除云端曲目', del.ok === true);
  check('删除后不再可播放（404）', (await fetch(BASE + '/api/audio/e2e-track-1?s=' + slugA)).status === 404);
  check('重复删除返回 404',
    (await fetch(BASE + '/api/audio/e2e-track-1', { method: 'DELETE', headers: auth() })).status === 404);

  // A 接管来的 old-1 是自己的副本，可以删；删完源空间（B 的空间）里那份仍在
  check('可以删除自己空间里的副本',
    (await (await fetch(BASE + '/api/audio/old-1', { method: 'DELETE', headers: auth() })).status) === 200);
  check('删除副本不影响源空间', (await fetch(BASE + '/api/audio/old-1?s=' + oldSlug)).status === 200);

  console.log('        · 会话链路总耗时：' + meTime1 + ' ms');
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
