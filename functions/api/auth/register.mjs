/* /api/auth/register —— 注册账号（用户名 + 密码）
 *   POST { username, password, displayName? } → 201 { token, user }
 *
 * 注册成功即建立会话（返回 Bearer token），省掉「注册完还要再登一次」。
 * 空间 slug 由服务端随机生成，与密码无关 —— 这是与旧「口令即密钥」最本质的差别。
 */
import { json } from '../../_lib/core.mjs';
import {
  displayNameOf, passwordProblem, publicUser, SESSION_DAYS, usernameProblem
} from '../../_lib/account.mjs';
import { createSession, purgeExpiredSessions } from '../../_lib/session.mjs';
import { createUser, findByName } from '../../_lib/users.mjs';

export async function onRequestPost({ request, env }) {
  if (!env || !env.DB) return json({ error: '未绑定 D1（DB）' }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'JSON 解析失败' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不合法' }, 400);

  const badName = usernameProblem(body.username);
  if (badName) return json({ error: badName }, 400);
  const badPass = passwordProblem(body.password);
  if (badPass) return json({ error: badPass }, 400);

  // 先查一次给出友好提示；真正的唯一性由索引兜底（并发注册时 createUser 会返回 409）
  const existed = await findByName(env, body.username);
  if (existed) return json({ error: '该用户名已被注册' }, 409);

  const created = await createUser(env, {
    username: body.username,
    password: body.password,
    displayName: displayNameOf(body.displayName, body.username)
  });
  if (created.error) return json({ error: created.error }, created.status);

  purgeExpiredSessions(env);   // 顺手清过期会话，不需要 Cron
  const token = await createSession(env, created.id, request);
  return json({ ok: true, token: token, user: publicUser(created), expiresDays: SESSION_DAYS }, 201);
}
