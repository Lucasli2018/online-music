/* /api/ping —— 云端链路自检（部署后第一时间用它确认绑定是否生效）
 *   GET              → 检查 R2 与 D1 绑定、账号表是否就绪
 *   GET + Bearer     → 额外回显当前账号与空间曲目数，便于排查「数据去哪了」
 *
 * 这个接口永远返回 200，把所有异常写进 body —— 它的职责是诊断，不是拦截。
 */
import { audioPrefix, json } from '../_lib/core.mjs';
import { publicUser } from '../_lib/account.mjs';
import { requireUser } from '../_lib/session.mjs';

export async function onRequestGet({ request, env }) {
  const out = {
    ok: false,
    service: 'coral-music-cloud',
    auth: 'account',
    hasBucket: !!(env && env.MUSIC_BUCKET),
    bucketOk: false,
    hasDb: !!(env && env.DB),
    dbOk: false,
    accounts: 0,
    reason: ''
  };

  if (out.hasBucket) {
    try {
      await env.MUSIC_BUCKET.list({ limit: 1 });
      out.bucketOk = true;
    } catch (e) {
      out.reason = String((e && e.message) || e);
    }
  } else {
    out.reason = '环境里没有 MUSIC_BUCKET 绑定';
  }

  if (out.hasDb) {
    try {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      out.dbOk = true;
      out.accounts = (row && row.n) || 0;
    } catch (e) {
      // 表不存在时这里会报 "no such table: users" —— 正对应「迁移还没应用」
      out.reason = out.reason || ('账号表不可用：' + String((e && e.message) || e));
    }
  } else if (!out.reason) {
    out.reason = '环境里没有 DB（D1）绑定';
  }

  out.ok = out.hasBucket && out.bucketOk && out.hasDb && out.dbOk;

  // 带了令牌就顺手回显账号信息（令牌无效不算错误，只是 loggedIn=false）
  const auth = await requireUser(request, env);
  out.loggedIn = !!auth.user;
  if (auth.user) {
    out.user = publicUser(auth.user);
    if (out.bucketOk) {
      try {
        const listed = await env.MUSIC_BUCKET.list({ prefix: audioPrefix(auth.user.space_slug), limit: 1000 });
        out.cloudTracks = (listed.objects || []).length;
      } catch (e) { /* 计数失败不影响自检结论 */ }
    }
  } else if (auth.error && auth.status !== 401) {
    out.authError = auth.error;
  }

  return json(out);
}
