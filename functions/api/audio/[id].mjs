/* /api/audio/:id —— 单个云端音频
 *   GET    ?s=<slug>                流式播放，支持 Range（进度条拖动必需）
 *   DELETE 需口令头，删除该曲目
 *
 * 鉴权说明：<audio src> 无法携带自定义请求头，因此读操作以 ?s=<slug> 作凭据
 * （slug 由口令派生、不反向暴露口令）。写操作一律要求 X-Coral-Key 口令头。
 */
import {
  audioPrefix, authSlug, contentTypeOf, json, parseRange, safeId
} from '../../_lib/core.mjs';

const SLUG_RE = /^[0-9a-f]{20}$/;

async function findObject(env, slug, id) {
  const base = audioPrefix(slug) + safeId(id);
  const listed = await env.MUSIC_BUCKET.list({
    prefix: base,
    limit: 20,
    include: ['httpMetadata', 'customMetadata']   // list 默认不返回元数据
  });
  const hit = (listed.objects || []).filter(function (o) {
    return o.key === base || o.key.indexOf(base + '.') === 0;
  })[0];
  return hit || null;
}

export async function onRequestGet({ request, env, params }) {
  if (!env || !env.MUSIC_BUCKET) return new Response('未绑定 R2', { status: 503 });

  const slug = new URL(request.url).searchParams.get('s') || '';
  if (!SLUG_RE.test(slug)) return new Response('缺少有效的空间标识', { status: 401 });

  const id = safeId(Array.isArray(params.id) ? params.id.join('/') : params.id);
  if (!id) return new Response('曲目 id 不合法', { status: 400 });

  const obj = await findObject(env, slug, id);
  if (!obj) return new Response('曲目不存在', { status: 404 });

  const range = parseRange(request.headers.get('Range'), obj.size);
  if (range === 'invalid') {
    return new Response('Range 不合法', {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + obj.size }
    });
  }

  const got = range
    ? await env.MUSIC_BUCKET.get(obj.key, { range: { offset: range.offset, length: range.length } })
    : await env.MUSIC_BUCKET.get(obj.key);
  if (!got) return new Response('曲目不存在', { status: 404 });

  const headers = new Headers();
  const ext = (/\.([A-Za-z0-9]+)$/.exec(obj.key) || [])[1] || '';
  headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || contentTypeOf(ext));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  if (range) {
    headers.set('Content-Range', 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + obj.size);
    headers.set('Content-Length', String(range.length));
    return new Response(got.body, { status: 206, headers: headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(got.body, { status: 200, headers: headers });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env || !env.MUSIC_BUCKET) return json({ error: '未绑定 R2' }, 503);

  const slug = await authSlug(request);
  if (!slug) return json({ error: '口令不合法（至少 10 位）' }, 401);

  const id = safeId(Array.isArray(params.id) ? params.id.join('/') : params.id);
  if (!id) return json({ error: '曲目 id 不合法' }, 400);

  const obj = await findObject(env, slug, id);
  if (!obj) return json({ error: '曲目不存在' }, 404);

  await env.MUSIC_BUCKET.delete(obj.key);
  return json({ ok: true, key: obj.key });
}
