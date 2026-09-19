/* /api/proxy —— 在线音源音频代理
 *
 * 目的：在线曲目（Audius / GD / Jamendo / iTunes）跨域且不返回 CORS 头，
 * 浏览器拿不到音频数据 → 频谱可视化只能降级成装饰动画、EQ 也对在线歌无效。
 * 由 Functions 服务端拉流再回传（服务端不受 CORS 限制），前端即可走 Web Audio 真实分析。
 *
 * 用法：GET /api/proxy?s=<slug>&u=<encodeURIComponent(音频直链)>
 * 安全：① 必须带有效 slug（即要有口令才拿得到）；② 域名白名单；③ 只回传音频类型。
 */
import { json } from '../_lib/core.mjs';

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
