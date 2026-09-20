/* /api/state —— 跨设备同步曲库 / 歌单 / 设置 / 播放统计与进度
 *   GET  读回云端快照（需登录）
 *   PUT  上传本地快照（需登录；body 为 {state:{...}} 或直接是 state 对象）
 *
 * 冲突策略：服务端不做合并，只记录 updatedAt。前端负责在覆盖前做时间比较与提示，
 * 避免自动覆盖把用户的歌单弄丢。
 */
import { json, sanitizeState, stateKey } from '../_lib/core.mjs';
import { requireCloud } from '../_lib/session.mjs';

export async function onRequestGet({ request, env }) {
  const a = await requireCloud(request, env);
  if (a.error) return json({ error: a.error }, a.status);
  const slug = a.slug;

  const obj = await env.MUSIC_BUCKET.get(stateKey(slug));
  if (!obj) return json({ slug: slug, empty: true, state: null, updatedAt: 0 });

  let state = null;
  try { state = JSON.parse(await obj.text()); } catch (e) { state = null; }
  return json({
    slug: slug,
    empty: !state,
    state: state,
    updatedAt: (state && state.updatedAt) || 0
  });
}

export async function onRequestPut({ request, env }) {
  const a = await requireCloud(request, env);
  if (a.error) return json({ error: a.error }, a.status);
  const slug = a.slug;

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'JSON 解析失败' }, 400); }

  const state = sanitizeState(body && body.state ? body.state : body);
  if (!state) return json({ error: '数据格式不合法' }, 400);

  state.updatedAt = Date.now();
  const text = JSON.stringify(state);
  if (text.length > 8 * 1024 * 1024) return json({ error: '数据过大（上限 8MB）' }, 413);

  await env.MUSIC_BUCKET.put(stateKey(slug), text, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' }
  });
  return json({
    ok: true,
    slug: slug,
    bytes: text.length,
    updatedAt: state.updatedAt,
    counts: {
      lists: (state.lists || []).length,
      remote: (state.remote || []).length,
      lyrics: Object.keys(state.lyrics || {}).length,
      stats: Object.keys(state.stats || {}).length
    }
  });
}
