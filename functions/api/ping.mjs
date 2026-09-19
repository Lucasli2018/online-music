/* /api/ping —— 云端链路自检（部署后第一时间用它确认绑定是否生效）
 *   GET            → 检查 R2 绑定是否可用
 *   GET + 口令头    → 额外回显该口令对应的空间标识与已存曲目数，便于排查「数据去哪了」
 */
import { json, MIN_PASS, passProblem, slugOf, audioPrefix } from '../_lib/core.mjs';

export async function onRequestGet({ request, env }) {
  const hasBucket = !!(env && env.MUSIC_BUCKET);
  let bucketOk = false, reason = '';
  if (hasBucket) {
    try {
      await env.MUSIC_BUCKET.list({ limit: 1 });
      bucketOk = true;
    } catch (e) {
      reason = String((e && e.message) || e);
    }
  } else {
    reason = '环境里没有 MUSIC_BUCKET 绑定';
  }

  const pass = request.headers.get('X-Coral-Key') || '';
  const bad = passProblem(pass);
  const out = {
    ok: hasBucket && bucketOk,
    service: 'coral-music-cloud',
    hasBucket: hasBucket,
    bucketOk: bucketOk,
    minPass: MIN_PASS,
    reason: reason || undefined
  };

  if (!bad) {
    const slug = await slugOf(pass);
    out.slug = slug;
    if (bucketOk) {
      const listed = await env.MUSIC_BUCKET.list({ prefix: audioPrefix(slug), limit: 1000 });
      out.cloudTracks = (listed.objects || []).length;
    }
  }
  return json(out);
}
