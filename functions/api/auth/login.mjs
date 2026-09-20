/* /api/auth/login —— 账号密码登录
 *   POST { username, password } → 200 { token, user }
 *
 * 两个刻意为之的细节：
 *  1) 用户名不存在时也照样做一次 PBKDF2（用固定假盐），让「账号不存在」和「密码错误」
 *     耗时相当，避免通过响应时间枚举出哪些用户名已注册。
 *  2) 失败一律回同一句「用户名或密码不正确」，不区分是哪个错。
 */
import { json } from '../../_lib/core.mjs';
import {
  DEFAULT_ITER, hashPassword, iterFromEnv, passwordProblem, publicUser,
  SESSION_DAYS, normalizeUsername, verifyPassword
} from '../../_lib/account.mjs';
import { clearAttempts, createSession, isRateLimited, recordAttempt, clientIp } from '../../_lib/session.mjs';
import { findByName, noteLogin } from '../../_lib/users.mjs';

const DUMMY_SALT = '00000000000000000000000000000000';

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB) return json({ error: '未绑定 D1（DB）' }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'JSON 解析失败' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不合法' }, 400);

  const username = normalizeUsername(body.username);
  const password = String(body.password == null ? '' : body.password);
  if (!username) return json({ error: '请填写用户名' }, 400);
  if (passwordProblem(password)) return json({ error: '用户名或密码不正确' }, 401);

  const ip = clientIp(request);
  if (await isRateLimited(env, username)) {
    return json({ error: '失败次数过多，请稍后再试' }, 429);
  }

  const user = await findByName(env, username);
  if (!user || user.status !== 'active') {
    // 走一遍等价耗时的哈希，抹平时序差异
    await hashPassword(password, DUMMY_SALT, iterFromEnv(env)).catch(function () { return null; });
    await recordAttempt(env, username, ip, false);
    return json({ error: '用户名或密码不正确' }, 401);
  }

  const ok = await verifyPassword(password, user.pass_salt, Number(user.pass_iter) || DEFAULT_ITER, user.pass_hash);
  if (!ok) {
    await recordAttempt(env, username, ip, false);
    return json({ error: '用户名或密码不正确' }, 401);
  }

  await clearAttempts(env, username);
  await recordAttempt(env, username, ip, true);
  await noteLogin(env, user, password);

  const token = await createSession(env, user.id, request);
  return json({ ok: true, token: token, user: publicUser(user), expiresDays: SESSION_DAYS });
}
