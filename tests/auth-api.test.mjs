/* tests/auth-api.test.mjs — 账号体系（后端）
 *
 * 覆盖：
 *   · _lib/account.mjs 的纯逻辑：时间格式、PBKDF2、恒定时间比较、输入校验
 *   · _lib/session.mjs 的会话：Bearer 解析、过期、滑动续期、停用账号
 *   · 端点：/api/auth/register | login | logout | me | adopt
 *
 * 重点回归项：nowStr() 在东八区 00:00–08:00 之间必须进位到次日，
 * 不能算出 "24:xx:xx"（否则与 SQLite datetime('now','+8 hours') 的字符串比较全乱）。
 */
import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cloudEnv, ctx, readJSON, seedUser } from './fake-cloud.mjs';
import * as A from '../functions/_lib/account.mjs';
import { bearerToken, requireUser, requireCloud } from '../functions/_lib/session.mjs';
import { slugOf } from '../functions/_lib/core.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const registerApi = await import('../functions/api/auth/register.mjs');
const loginApi = await import('../functions/api/auth/login.mjs');
const logoutApi = await import('../functions/api/auth/logout.mjs');
const meApi = await import('../functions/api/auth/me.mjs');
const adoptApi = await import(pathToFileURL(path.join(ROOT, 'functions/api/auth/adopt.mjs')).href);

const PASSWORD = 'supersecret';
const OLD_PASS = 'coral-old-pass-2026';

function post(url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return new Request(url, { method: 'POST', body: JSON.stringify(body), headers });
}
function get(url, token) {
  return new Request(url, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
}

/* ===================== 一、account.mjs 纯逻辑 ===================== */

test('nowStr: 东八区格式，且跨日边界正确进位', () => {
  assert.strictEqual(A.nowStr(Date.UTC(2026, 8, 20, 1, 2, 3)), '2026-09-20 09:02:03');
  // UTC 16:30 → 东八区次日 00:30，不能算成 "24:30"
  assert.strictEqual(A.nowStr(Date.UTC(2026, 8, 20, 16, 30, 0)), '2026-09-21 00:30:00');
  assert.strictEqual(A.nowStr(Date.UTC(2026, 8, 20, 23, 59, 59)), '2026-09-21 07:59:59');
  assert.match(A.nowStr(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('expiresStr: 按天推进，与 nowStr 同格式', () => {
  const base = Date.UTC(2026, 8, 20, 1, 0, 0);           // 东八区 09:00
  assert.strictEqual(A.expiresStr(1, base), '2026-09-21 09:00:00');
  assert.strictEqual(A.expiresStr(30, base), '2026-10-20 09:00:00');
});

test('iterFromEnv: 合法值生效，非法/缺失回退默认', () => {
  assert.strictEqual(A.iterFromEnv({ AUTH_ITER: '2000' }), 2000);
  assert.strictEqual(A.iterFromEnv({ AUTH_ITER: '0' }), A.DEFAULT_ITER);
  assert.strictEqual(A.iterFromEnv({ AUTH_ITER: 'abc' }), A.DEFAULT_ITER);
  assert.strictEqual(A.iterFromEnv({}), A.DEFAULT_ITER);
  assert.strictEqual(A.iterFromEnv(null), A.DEFAULT_ITER);
});

test('hashPassword: 同盐稳定、异盐不同、长度固定', async () => {
  const s1 = A.genSalt(), s2 = A.genSalt();
  const h1 = await A.hashPassword(PASSWORD, s1, 1000);
  assert.strictEqual(h1, await A.hashPassword(PASSWORD, s1, 1000));
  assert.notStrictEqual(h1, await A.hashPassword(PASSWORD, s2, 1000));
  assert.notStrictEqual(h1, await A.hashPassword(PASSWORD + 'x', s1, 1000));
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(s1, s2);
});

test('verifyPassword: 正确通过，错误拒绝', async () => {
  const salt = A.genSalt();
  const hash = await A.hashPassword(PASSWORD, salt, 1000);
  assert.strictEqual(await A.verifyPassword(PASSWORD, salt, 1000, hash), true);
  assert.strictEqual(await A.verifyPassword('wrongpass', salt, 1000, hash), false);
  assert.strictEqual(await A.verifyPassword(PASSWORD, salt, 2000, hash), false, '迭代数不同结果必不同');
});

test('safeEqual: 长度不同直接为假，内容不同为假', () => {
  assert.strictEqual(A.safeEqual('abc', 'abc'), true);
  assert.strictEqual(A.safeEqual('abc', 'abd'), false);
  assert.strictEqual(A.safeEqual('abc', 'abcd'), false);
  assert.strictEqual(A.safeEqual('', ''), true);
  assert.strictEqual(A.safeEqual(null, ''), true, 'null 归一化成空串');
});

test('genToken / newSlug: 随机、长度与字符集符合规约', () => {
  const t = A.genToken(32);
  assert.strictEqual(t.length, 64);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(t, A.genToken(32));
  assert.match(A.newSlug(), /^[0-9a-f]{20}$/, '空间 slug 与 v1 格式一致，R2 key 规则不用改');
});

test('用户名规则：长度与字符集', () => {
  assert.ok(A.usernameProblem('ab'));
  assert.ok(A.usernameProblem('a'.repeat(25)));
  assert.match(A.usernameProblem('中文名'), /小写字母/);
  assert.strictEqual(A.usernameProblem('Lucas'), null, '先规范化为小写再判，所以大写可以通过');
  assert.strictEqual(A.usernameProblem('  Lucas  '), null, '先 trim 再小写');
  assert.strictEqual(A.usernameProblem('lucas_01-x'), null);
  assert.strictEqual(A.normalizeUsername(' LucAs '), 'lucas');
});

test('密码规则：只卡长度，不要求符号', () => {
  assert.strictEqual(A.passwordProblem(''), '请填写密码');
  assert.match(A.passwordProblem('1234567'), /至少 8 位/);
  assert.strictEqual(A.passwordProblem('12345678'), null);
  assert.match(A.passwordProblem('x'.repeat(129)), /过长/);
});

test('displayNameOf: 空值回落用户名，超长截断', () => {
  assert.strictEqual(A.displayNameOf('', 'lucas'), 'lucas');
  assert.strictEqual(A.displayNameOf('   ', 'lucas'), 'lucas');
  assert.strictEqual(A.displayNameOf(' 领主 ', 'lucas'), '领主');
  assert.strictEqual(A.displayNameOf('x'.repeat(50), 'lucas').length, 32);
});

test('publicUser: 绝不外泄 hash / salt / iter', () => {
  const view = A.publicUser({
    id: 1, username: 'lucas', display_name: '领主', space_slug: 'a'.repeat(20),
    pass_hash: 'deadbeef', pass_salt: 'cafe', pass_iter: 100000,
    created_at: '2026-09-20 10:00:00', last_login_at: '2026-09-21 08:00:00'
  });
  assert.deepStrictEqual(Object.keys(view).sort(),
    ['createdAt', 'displayName', 'id', 'lastLoginAt', 'spaceSlug', 'username']);
  assert.strictEqual(view.spaceSlug, 'a'.repeat(20));
  assert.strictEqual(A.publicUser(null), null);
});

test('publicUser: 没设昵称时回落到用户名', () => {
  assert.strictEqual(A.publicUser({ username: 'lucas', display_name: '' }).displayName, 'lucas');
});

/* ===================== 二、session.mjs 会话 ===================== */

test('bearerToken: 只接受合规的 Bearer 令牌', () => {
  const mk = (v) => new Request('https://x/api/ping', { headers: v ? { Authorization: v } : {} });
  assert.strictEqual(bearerToken(mk('Bearer ' + 'a'.repeat(32))), 'a'.repeat(32));
  assert.strictEqual(bearerToken(mk('bearer ' + 'a'.repeat(32))), 'a'.repeat(32), '大小写不敏感');
  assert.strictEqual(bearerToken(mk('Bearer short')), '', '太短视为无效');
  assert.strictEqual(bearerToken(mk('Basic ' + 'a'.repeat(32))), '');
  assert.strictEqual(bearerToken(mk('')), '');
});

test('requireUser: 无令牌 → 401', async () => {
  const e = cloudEnv();
  const r = await requireUser(new Request('https://x/api/state'), e);
  assert.strictEqual(r.status, 401);
  assert.match(r.error, /未登录/);
});

test('requireUser: 无 D1 → 503', async () => {
  const r = await requireUser(new Request('https://x/api/state', {
    headers: { Authorization: 'Bearer ' + 'a'.repeat(32) }
  }), {});
  assert.strictEqual(r.status, 503);
  assert.match(r.error, /D1/);
});

test('requireUser: 有效令牌返回账号与该账号的 slug', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const r = await requireUser(get('https://x/api/state', u.token), e);
  assert.strictEqual(r.user.username, 'lucas');
  assert.strictEqual(r.user.space_slug, u.slug);
  assert.strictEqual(r.token, u.token);
});

test('requireUser: 会话过期 → 401 并顺手删除该会话行', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  e.DB._sessions[0].expires_at = '2000-01-01 00:00:00';
  const r = await requireUser(get('https://x/api/state', u.token), e);
  assert.strictEqual(r.status, 401);
  assert.match(r.error, /过期/);
  assert.strictEqual(e.DB._sessions.length, 0, '过期会话应被清掉');
});

test('requireUser: 剩余不足 7 天时滑动续期', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const soon = A.expiresStr(3);
  e.DB._sessions[0].expires_at = soon;
  const r = await requireUser(get('https://x/api/state', u.token), e);
  assert.ok(r.user, '仍未过期，应通过');
  assert.ok(e.DB._sessions[0].expires_at > soon, '应被推后到 ' + A.SESSION_DAYS + ' 天');
});

test('requireUser: 账号被停用 → 403', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  e.DB._users[0].status = 'banned';
  const r = await requireUser(get('https://x/api/state', u.token), e);
  assert.strictEqual(r.status, 403);
  assert.match(r.error, /停用/);
});

test('requireCloud: 有账号但没绑 R2 → 503', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  delete e.MUSIC_BUCKET;
  const r = await requireCloud(get('https://x/api/state', u.token), e);
  assert.strictEqual(r.status, 503);
  assert.match(r.error, /MUSIC_BUCKET/);
});

/* ===================== 三、注册 ===================== */

test('注册: 成功返回 201、令牌与用户视图', async () => {
  const e = cloudEnv();
  const res = await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'Lucas', password: PASSWORD, displayName: '领主' }), e));
  assert.strictEqual(res.status, 201);
  const body = await readJSON(res);
  assert.strictEqual(body.ok, true);
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.strictEqual(body.user.username, 'lucas', '用户名规范化后落库');
  assert.strictEqual(body.user.displayName, '领主');
  assert.strictEqual(body.user.pass_hash, undefined);
  assert.deepStrictEqual(Object.keys(body.user).sort(),
    ['createdAt', 'displayName', 'id', 'lastLoginAt', 'spaceSlug', 'username']);
});

test('注册: 空间 slug 随机生成，与密码无关', async () => {
  const e = cloudEnv();
  const body = await readJSON(await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'lucas', password: PASSWORD }), e)));
  assert.match(body.user.spaceSlug, /^[0-9a-f]{20}$/);
  assert.notStrictEqual(body.user.spaceSlug, await slugOf(PASSWORD), '不再由密码派生');
  assert.notStrictEqual(body.user.spaceSlug, await slugOf(PASSWORD), '');
});

test('注册: 两个账号密码相同也得到不同空间', async () => {
  const e = cloudEnv();
  const a = await readJSON(await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'aaa', password: PASSWORD }), e)));
  const b = await readJSON(await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'bbb', password: PASSWORD }), e)));
  assert.notStrictEqual(a.user.spaceSlug, b.user.spaceSlug);
});

test('注册: 迭代数来自 AUTH_ITER 并落库', async () => {
  const e = cloudEnv({ AUTH_ITER: '2000' });
  await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'lucas', password: PASSWORD }), e));
  assert.strictEqual(e.DB._users[0].pass_iter, 2000);
  assert.strictEqual(e.DB._users[0].pass_salt.length, 32);
});

test('注册: 密码只存派生值，明文不落库', async () => {
  const e = cloudEnv();
  await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'lucas', password: PASSWORD }), e));
  const row = e.DB._users[0];
  assert.notStrictEqual(row.pass_hash, PASSWORD);
  assert.strictEqual(await A.verifyPassword(PASSWORD, row.pass_salt, row.pass_iter, row.pass_hash), true);
  assert.ok(JSON.stringify(row).indexOf(PASSWORD) < 0, '整行序列化里不该出现明文');
});

test('注册: 重复用户名返回 409（含大小写差异）', async () => {
  const e = cloudEnv();
  await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'lucas', password: PASSWORD }), e));
  const res = await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'LUCAS', password: PASSWORD }), e));
  assert.strictEqual(res.status, 409);
  assert.match((await readJSON(res)).error, /已被注册/);
});

test('注册: 并发同名时由唯一索引兜底，不会产生两个账号', async () => {
  const e = cloudEnv();
  // 绕过「先查一次」的友好提示，直接两次并发调用
  const [r1, r2] = await Promise.all([
    registerApi.onRequestPost(ctx(post('https://x/api/auth/register', { username: 'same', password: PASSWORD }), e)),
    registerApi.onRequestPost(ctx(post('https://x/api/auth/register', { username: 'same', password: PASSWORD }), e))
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepStrictEqual(codes, [201, 409]);
  assert.strictEqual(e.DB._users.length, 1);
});

test('注册: 弱密码与非法用户名都返回 400', async () => {
  const e = cloudEnv();
  const weak = await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'lucas', password: '123' }), e));
  assert.strictEqual(weak.status, 400);
  assert.match((await readJSON(weak)).error, /至少 8 位/);

  const bad = await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'L', password: PASSWORD }), e));
  assert.strictEqual(bad.status, 400);
  assert.match((await readJSON(bad)).error, /3-24/);
});

test('注册: 坏 JSON 与缺失字段返回 400，未绑定 D1 返回 503', async () => {
  const e = cloudEnv();
  const badJson = await registerApi.onRequestPost(ctx(
    new Request('https://x/api/auth/register', { method: 'POST', body: '{oops' }), e));
  assert.strictEqual(badJson.status, 400);

  const noDb = await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'lucas', password: PASSWORD }), {}));
  assert.strictEqual(noDb.status, 503);
  assert.match((await readJSON(noDb)).error, /D1/);
});

test('注册: 顺手清理过期会话', async () => {
  const e = cloudEnv();
  const stale = await seedUser(e.DB, { username: 'stale', token: 'f'.repeat(64) });
  e.DB._sessions[0].expires_at = '2000-01-01 00:00:00';
  await registerApi.onRequestPost(ctx(
    post('https://x/api/auth/register', { username: 'fresh', password: PASSWORD }), e));
  const tokens = e.DB._sessions.map(s => s.token);
  assert.ok(tokens.indexOf(stale.token) < 0, '过期会话应被清理');
  assert.strictEqual(e.DB._sessions.length, 1, '只剩新注册用户自己的会话');
});

/* ===================== 四、登录 ===================== */

test('登录: 成功返回令牌与用户', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB, { password: PASSWORD });
  const body = await readJSON(await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'Lucas ', password: PASSWORD }), e)));
  assert.strictEqual(body.ok, true);
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(body.token, u.token, '每次登录签发新令牌');
  assert.strictEqual(body.user.username, 'lucas');
  assert.strictEqual(e.DB._sessions.length, 2);
});

test('登录: 成功后更新 last_login_at 并清空失败计数', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { password: PASSWORD });
  await loginApi.onRequestPost(ctx(post('https://x/api/auth/login', { username: 'lucas', password: 'wrongpass' }), e));
  assert.strictEqual(e.DB._attempts.length, 1);

  await loginApi.onRequestPost(ctx(post('https://x/api/auth/login', { username: 'lucas', password: PASSWORD }), e));
  assert.strictEqual(e.DB._attempts.filter(a => !a.ok).length, 0, '失败计数应被清空');
  assert.ok(e.DB._users[0].last_login_at, '应记录登录时间');
});

test('登录: 密码错误与账号不存在返回同一文案（不泄露账号是否存在）', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { password: PASSWORD });
  const wrongPw = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'lucas', password: 'wrongpass' }), e));
  const noUser = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'nobody', password: PASSWORD }), e));

  assert.strictEqual(wrongPw.status, 401);
  assert.strictEqual(noUser.status, 401);
  const a = await readJSON(wrongPw), b = await readJSON(noUser);
  assert.strictEqual(a.error, b.error);
  assert.strictEqual(a.error, '用户名或密码不正确');
});

test('登录: 账号不存在时也走一次哈希（抹平时序差异）', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { password: PASSWORD });
  await loginApi.onRequestPost(ctx(post('https://x/api/auth/login', { username: 'nobody', password: PASSWORD }), e));
  // 未能直接断言耗时，但至少要确认失败被记下来且没有签发会话
  assert.strictEqual(e.DB._sessions.length, 1, '不存在账号不应产生会话');
  assert.strictEqual(e.DB._attempts.length, 1);
});

test('登录: 连续失败达上限后返回 429', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { password: PASSWORD });
  let last = 0;
  for (let i = 0; i < A.RATE_MAX_FAIL; i++) {
    last = (await loginApi.onRequestPost(ctx(
      post('https://x/api/auth/login', { username: 'lucas', password: 'wrongpass' }), e))).status;
    assert.strictEqual(last, 401);
  }
  const blocked = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'lucas', password: PASSWORD }), e));
  assert.strictEqual(blocked.status, 429);
  assert.match((await readJSON(blocked)).error, /失败次数过多/);
  assert.strictEqual(e.DB._sessions.length, 1, '限流期间即使密码正确也不放行');
});

test('登录: 限流只针对该用户名，不影响别人', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { username: 'victim', password: PASSWORD });
  await seedUser(e.DB, { username: 'other', password: PASSWORD, token: 'a'.repeat(64) });
  for (let i = 0; i < A.RATE_MAX_FAIL + 1; i++) {
    await loginApi.onRequestPost(ctx(post('https://x/api/auth/login', { username: 'victim', password: 'x'.repeat(9) }), e));
  }
  const ok = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'other', password: PASSWORD }), e));
  assert.strictEqual(ok.status, 200);
});

test('登录: 密码太短直接 401，不计入限流', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { password: PASSWORD });
  const res = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'lucas', password: '123' }), e));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(e.DB._attempts.length, 0);
});

test('登录: 账号被停用时不签发会话', async () => {
  const e = cloudEnv();
  await seedUser(e.DB, { password: PASSWORD });
  e.DB._users[0].status = 'banned';
  const res = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'lucas', password: PASSWORD }), e));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(e.DB._sessions.length, 1);
});

test('登录: AUTH_ITER 提高后自动升级老账号哈希', async () => {
  const e = cloudEnv({ AUTH_ITER: '3000' });
  await seedUser(e.DB, { password: PASSWORD, iter: 1000 });
  assert.strictEqual(e.DB._users[0].pass_iter, 1000);

  const res = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'lucas', password: PASSWORD }), e));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(e.DB._users[0].pass_iter, 3000, '成功后应升到当前迭代数');
  const row = e.DB._users[0];
  assert.strictEqual(await A.verifyPassword(PASSWORD, row.pass_salt, 3000, row.pass_hash), true, '旧密码仍然可用');
});

test('登录: AUTH_ITER 降低时不降级已有哈希', async () => {
  const e = cloudEnv({ AUTH_ITER: '1000' });
  await seedUser(e.DB, { password: PASSWORD, iter: 5000 });
  await loginApi.onRequestPost(ctx(post('https://x/api/auth/login', { username: 'lucas', password: PASSWORD }), e));
  assert.strictEqual(e.DB._users[0].pass_iter, 5000);
});

/* ===================== 五、登出与 me ===================== */

test('登出: 删除当前会话，其它设备不受影响', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const second = await loginApi.onRequestPost(ctx(
    post('https://x/api/auth/login', { username: 'lucas', password: PASSWORD }), e));
  const otherToken = (await readJSON(second)).token;

  const body = await readJSON(await logoutApi.onRequestPost(ctx(
    post('https://x/api/auth/logout', {}, u.token), e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(e.DB._sessions.length, 1);
  assert.strictEqual(e.DB._sessions[0].token, otherToken);

  const me = await meApi.onRequestGet(ctx(get('https://x/api/auth/me', otherToken), e));
  assert.strictEqual(me.status, 200, '另一台设备仍然在线');
});

test('登出: 未登录调用也返回 ok（无需报错）', async () => {
  const e = cloudEnv();
  const body = await readJSON(await logoutApi.onRequestPost(ctx(
    post('https://x/api/auth/logout', {}), e)));
  assert.strictEqual(body.ok, true);
});

test('me: 返回账号视图与云端曲目数', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  await e.MUSIC_BUCKET.put('audio/' + u.slug + '/a.mp3', Buffer.from('x'));
  await e.MUSIC_BUCKET.put('audio/' + u.slug + '/b.mp3', Buffer.from('x'));
  const body = await readJSON(await meApi.onRequestGet(ctx(get('https://x/api/auth/me', u.token), e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.user.username, 'lucas');
  assert.strictEqual(body.cloudTracks, 2);
});

test('me: 未登录 401，令牌失效 401', async () => {
  const e = cloudEnv();
  await seedUser(e.DB);
  assert.strictEqual((await meApi.onRequestGet(ctx(get('https://x/api/auth/me'), e))).status, 401);
  assert.strictEqual((await meApi.onRequestGet(ctx(get('https://x/api/auth/me', 'f'.repeat(64)), e))).status, 401);
});

test('me: R2 未绑定时仍能确认登录态', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  delete e.MUSIC_BUCKET;
  const body = await readJSON(await meApi.onRequestGet(ctx(get('https://x/api/auth/me', u.token), e)));
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.cloudTracks, 0);
});

/* ===================== 六、接管旧口令空间 ===================== */

// 造一个 v1 风格的空间：audio/<oldSlug>/*.mp3 + state/<oldSlug>.json
async function seedOldSpace(e, opts) {
  const oldSlug = await slugOf(OLD_PASS);
  const n = (opts && opts.tracks) || 3;
  for (let i = 1; i <= n; i++) {
    await e.MUSIC_BUCKET.put('audio/' + oldSlug + '/old-' + i + '.mp3', Buffer.from('old-audio-' + i), {
      httpMetadata: { contentType: 'audio/mpeg' },
      customMetadata: { title: '老歌 ' + i, artist: '老歌手' }
    });
  }
  if (!opts || opts.state !== false) {
    await e.MUSIC_BUCKET.put('state/' + oldSlug + '.json', JSON.stringify({
      lists: [{ id: 'all', name: '全部', ids: ['old-1'] }], updatedAt: 1789000000000
    }), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  }
  return oldSlug;
}

test('接管: 未登录 401', async () => {
  const e = cloudEnv();
  await seedOldSpace(e);
  const res = await adoptApi.onRequestPost(ctx(post('https://x/api/auth/adopt', { oldPass: OLD_PASS }), e));
  assert.strictEqual(res.status, 401);
});

test('接管: 口令太短 400，口令即当前空间 400', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const short = await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: 'short' }, u.token), e));
  assert.strictEqual(short.status, 400);
  assert.match((await readJSON(short)).error, /10 位/);
});

test('接管: 把旧空间音频复制到账号空间，元数据一并带过来', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const oldSlug = await seedOldSpace(e, { tracks: 3 });

  const body = await readJSON(await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e)));

  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.copied, 3);
  assert.strictEqual(body.remaining, 0);
  assert.strictEqual(body.done, true);

  const moved = e.MUSIC_BUCKET._store.get('audio/' + u.slug + '/old-1.mp3');
  assert.ok(moved, '应出现在账号空间');
  assert.strictEqual(moved.buf.toString('utf8'), 'old-audio-1');
  assert.strictEqual(moved.customMetadata.title, '老歌 1');
  assert.strictEqual(moved.httpMetadata.contentType, 'audio/mpeg');
  assert.notStrictEqual(oldSlug, u.slug);
});

test('接管: 源空间只读不动（不删除他人的数据）', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const oldSlug = await seedOldSpace(e, { tracks: 2 });
  await adoptApi.onRequestPost(ctx(post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e));

  assert.ok(e.MUSIC_BUCKET._store.has('audio/' + oldSlug + '/old-1.mp3'), '源音频仍在');
  assert.ok(e.MUSIC_BUCKET._store.has('state/' + oldSlug + '.json'), '源备份仍在');
});

test('接管: 歌单备份在目标为空时接管，已有则不覆盖', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  await seedOldSpace(e, { tracks: 1 });

  await adoptApi.onRequestPost(ctx(post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e));
  let state = JSON.parse(e.MUSIC_BUCKET._store.get('state/' + u.slug + '.json').buf.toString('utf8'));
  assert.strictEqual(state.lists[0].name, '全部');

  // 换一份自己的备份后再次接管，不应被覆盖
  await e.MUSIC_BUCKET.put('state/' + u.slug + '.json', JSON.stringify({ lists: [{ id: 'mine', name: '我的', ids: [] }] }));
  const body = await readJSON(await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e)));
  assert.strictEqual(body.state, 'skipped');
  state = JSON.parse(e.MUSIC_BUCKET._store.get('state/' + u.slug + '.json').buf.toString('utf8'));
  assert.strictEqual(state.lists[0].name, '我的');
});

test('接管: 幂等 —— 重复接管不会产生重复文件', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  await seedOldSpace(e, { tracks: 3 });

  await adoptApi.onRequestPost(ctx(post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e));
  const body = await readJSON(await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e)));

  assert.strictEqual(body.copied, 0);
  assert.strictEqual(body.skipped, 3);
  assert.strictEqual(body.done, true);
  const keys = [...e.MUSIC_BUCKET._store.keys()].filter(k => k.indexOf('audio/' + u.slug + '/') === 0);
  assert.strictEqual(keys.length, 3);
});

test('接管: 分批搬运，remaining 递进直到 done', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  await seedOldSpace(e, { tracks: 25, state: false });

  const seen = [];
  let body;
  for (let i = 0; i < 10; i++) {
    body = await readJSON(await adoptApi.onRequestPost(ctx(
      post('https://x/api/auth/adopt', { oldPass: OLD_PASS, batch: 10 }, u.token), e)));
    seen.push({ copied: body.copied, remaining: body.remaining, done: body.done });
    if (body.done) break;
  }
  assert.deepStrictEqual(seen, [
    { copied: 10, remaining: 15, done: false },
    { copied: 10, remaining: 5, done: false },
    { copied: 5, remaining: 0, done: true }
  ]);
  const keys = [...e.MUSIC_BUCKET._store.keys()].filter(k => k.indexOf('audio/' + u.slug + '/') === 0);
  assert.strictEqual(keys.length, 25);
});

test('接管: 旧口令下没有数据时给出友好结果', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const body = await readJSON(await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e)));
  assert.strictEqual(body.done, true);
  assert.strictEqual(body.total, 0);
  assert.strictEqual(body.copied, 0);
  assert.match(body.message, /没有云端曲目/);
});

test('接管: 完整搬完后记录 migrated_from', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  const oldSlug = await seedOldSpace(e, { tracks: 2 });
  await adoptApi.onRequestPost(ctx(post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e));
  assert.strictEqual(e.DB._users[0].migrated_from, oldSlug);
});

test('接管: 口令等于当前账号空间时拒绝', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB, { slug: await slugOf(OLD_PASS) });
  const res = await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e));
  assert.strictEqual(res.status, 400);
  assert.match((await readJSON(res)).error, /当前账号的空间/);
});

test('接管: 未绑定 R2 返回 503', async () => {
  const e = cloudEnv();
  const u = await seedUser(e.DB);
  delete e.MUSIC_BUCKET;
  const res = await adoptApi.onRequestPost(ctx(
    post('https://x/api/auth/adopt', { oldPass: OLD_PASS }, u.token), e));
  assert.strictEqual(res.status, 503);
});
