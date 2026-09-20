/* /api/auth/logout —— 退出登录（销毁当前会话）
 *   POST  → { ok: true }
 *
 * 只删令牌那一行，不动账号、不动 R2 数据 —— 退出登录不应该有任何代价。
 * 未登录调用也返回 ok，前端不必区分。
 */
import { json } from '../../_lib/core.mjs';
import { bearerToken, destroySession } from '../../_lib/session.mjs';

export async function onRequestPost({ request, env }) {
  const token = bearerToken(request);
  if (token && env && env.DB) await destroySession(env, token);
  return json({ ok: true });
}
