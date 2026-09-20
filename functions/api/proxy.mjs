/* /api/proxy —— 在线音源音频代理
 *
 * 目的：在线曲目（Audius / GD / Jamendo / iTunes）跨域且不返回 CORS 头，
 * 浏览器拿不到音频数据 → 频谱可视化只能降级成装饰动画、EQ 也对在线歌无效。
 * 由 Functions 服务端拉流再回传（服务端不受 CORS 限制），前端即可走 Web Audio 真实分析。
 *
 * 用法：GET /api/proxy?s=<slug>&u=<encodeURIComponent(音频直链)>
 * 安全：① 必须带**已注册账号的真实空间 slug**；② 域名白名单；③ 只回传音频类型。
 *
 * 为什么这里要比 /api/audio/:id 多查一次 D1：
 *   audio/:id 只能命中「调用者已知道 20 位 hex slug 的」那个空间的音频，拿不到别的；
 *   而 proxy 能代为请求任意外部地址，一旦 slug 只校验格式，它就退化成公开代理。
 *   所以这里必须确认 slug 真的对应一个账号（users.space_slug 唯一索引，查得很快）。
 */
import { json } from '../_lib/core.mjs';
import { findBySlug } from '../_lib/users.mjs';

const SLUG_RE = /^[0-9a-f]{20}$/;

// 只代理已知在线音源的域名，避免这个端点变成通用开放代理
const ALLOW_HOSTS = [
  /(^|\.)audius\.co$/,
  /(^|\.)gdstudio\.xyz$/,
  /(^|\.)jamendo\.com$/,
  /(^|\.)mzstatic\.com$/,
  /(^|\.)apple\.com$/,
  /(^|\.)soundhelix\.com$/,
  /(^|\.)cloudflarestorage\.com$/,
  /(^|\.)r2\.dev$/
];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('s') || '';
  if (!SLUG_RE.test(slug)) return new Response('缺少空间标识', { status: 401 });
  if (env && env.DB) {
    const owner = await findBySlug(env, slug);
    if (!owner) return new Response('空间标识无效', { status: 401 });
  }

  const target = url.searchParams.get('u') || '';
  let u;
  try { u = new URL(target); } catch (e) { return new Response('目标地址不合法', { status: 400 }); }
  if (u.protocol !== 'https:') return new Response('只允许 https 目标', { status: 400 });
  if (!ALLOW_HOSTS.some(function (re) { return re.test(u.hostname); })) {
    return new Response('该域名不在代理白名单内', { status: 403 });
  }

  const range = request.headers.get('Range');
  let upstream;
  try {
    upstream = await fetch(u.toString(), {
      headers: range ? { Range: range } : {},
      redirect: 'follow'
    });
  } catch (e) {
    return new Response('上游请求失败', { status: 502 });
  }

  if (upstream.status !== 200 && upstream.status !== 206) {
    return new Response('上游返回 ' + upstream.status, { status: 502 });
  }

  const ct = (upstream.headers.get('Content-Type') || '').toLowerCase();
  const audioish = !ct || ct.indexOf('audio') >= 0 || ct.indexOf('video') >= 0 ||
                   ct.indexOf('octet-stream') >= 0 || ct.indexOf('mpegurl') >= 0;
  if (!audioish) return new Response('上游不是音频流', { status: 415 });

  const headers = new Headers();
  headers.set('Content-Type', ct || 'audio/mpeg');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'no-store');
  ['content-length', 'content-range'].forEach(function (h) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  });

  return new Response(upstream.body, { status: upstream.status, headers: headers });
}

export async function onRequestPost({ request }) {
  return json({ error: '仅支持 GET' }, 405);
}
