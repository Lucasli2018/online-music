/* /api/audio —— 云端音频库（写操作需登录）
 *   GET  列表
 *   POST 上传（multipart/form-data: file / id / title / artist）
 */
import {
  audioKey, audioPrefix, contentTypeOf, extOf, json, MAX_UPLOAD, safeId
} from '../../_lib/core.mjs';
import { requireCloud } from '../../_lib/session.mjs';

export async function onRequestGet({ request, env }) {
  const a = await requireCloud(request, env);
  if (a.error) return json({ error: a.error }, a.status);
  const slug = a.slug;

  // 注意：R2 的 list 默认不返回 httpMetadata / customMetadata，必须显式 include，
  // 否则标题、歌手、内容类型全都会是空的（本地模拟与线上行为一致，已用 E2E 验证）
  const listed = await env.MUSIC_BUCKET.list({
    prefix: audioPrefix(slug),
    limit: 1000,
    include: ['httpMetadata', 'customMetadata']
  });
  const prefix = audioPrefix(slug);
  const items = (listed.objects || []).map(function (o) {
    const rest = o.key.slice(prefix.length);
    const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(rest);
    return {
      key: o.key,
      id: m ? m[1] : rest,
      ext: m ? m[2] : '',
      size: o.size,
      title: (o.customMetadata && o.customMetadata.title) || '',
      artist: (o.customMetadata && o.customMetadata.artist) || '',
      uploaded: o.uploaded ? new Date(o.uploaded).getTime() : 0
    };
  });
  return json({ slug, count: items.length, items: items, truncated: !!listed.truncated });
}

export async function onRequestPost({ request, env }) {
  const a = await requireCloud(request, env);
  if (a.error) return json({ error: a.error }, a.status);
  const slug = a.slug;

  const ct = request.headers.get('Content-Type') || '';
  if (ct.indexOf('multipart/form-data') < 0) {
    return json({ error: '请使用 multipart/form-data 上传' }, 400);
  }

  let form;
  try { form = await request.formData(); }
  catch (e) { return json({ error: '表单解析失败' }, 400); }

  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ error: '缺少 file 字段' }, 400);
  if (!file.size) return json({ error: '文件为空' }, 400);
  if (file.size > MAX_UPLOAD) {
    return json({ error: '文件超过 ' + Math.round(MAX_UPLOAD / 1024 / 1024) + 'MB 上限' }, 413);
  }

  const rawName = String(file.name || '');
  const id = safeId(form.get('id') || rawName.replace(/\.[^.]+$/, '') || String(Date.now()));
  if (!id) return json({ error: '无法确定曲目 id' }, 400);
  const ext = extOf(rawName, file.type);
  const key = audioKey(slug, id, ext);

  // 注意：用 arrayBuffer 而不是 file.stream() —— request.formData() 已把 body 读入内存，
  // 再切片不会新增峰值；而 R2.put 对「长度未知的 ReadableStream」在某些运行时不可靠。
  const buf = await file.arrayBuffer();
  await env.MUSIC_BUCKET.put(key, buf, {
    httpMetadata: { contentType: contentTypeOf(ext) },
    customMetadata: {
      title: String(form.get('title') || '').slice(0, 200),
      artist: String(form.get('artist') || '').slice(0, 200)
    }
  });

  return json({ ok: true, key: key, id: id, ext: ext, size: file.size, slug: slug });
}
