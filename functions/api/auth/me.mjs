/* /api/auth/me —— 当前登录账号
 *   GET → { user, cloudTracks }
 *
 * 前端启动时用它验证本地缓存的 token 是否还有效（顺带把空间里的曲目数带回来，
 * 省掉一次 /api/audio 调用）。
 */
import { json, audioPrefix } from '../../_lib/core.mjs';
import { publicUser } from '../../_lib/account.mjs';
import { requireUser } from '../../_lib/session.mjs';

export async function onRequestGet({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.error) return json({ error: auth.error }, auth.status);

  const out = { ok: true, user: publicUser(auth.user), cloudTracks: 0 };
  if (env && env.MUSIC_BUCKET && auth.user.space_slug) {
    try {
      const listed = await env.MUSIC_BUCKET.list({ prefix: audioPrefix(auth.user.space_slug), limit: 1000 });
      out.cloudTracks = (listed.objects || []).length;
    } catch (e) { /* 计数失败不影响「已登录」这个结论 */ }
  }
  return json(out);
}
