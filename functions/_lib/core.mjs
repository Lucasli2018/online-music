/* core.mjs — 珊瑚音乐云端能力的共享纯逻辑（Pages Functions 专用）
 *
 * 为什么是 .mjs：Pages Functions 支持 .mjs 扩展名，而 Node 只把 .mjs 当 ESM，
 * 这样同一份源码既能被 Pages 打包，也能被 tests/ 用 `import()` 直接单测（项目零依赖、无 package.json）。
 *
 * 数据布局（R2 bucket: music-audio，绑定名 MUSIC_BUCKET）
 *   audio/<slug>/<id>.<ext>   用户上传的音频
 *   state/<slug>.json         曲库 / 歌单 / 设置 / 统计 / 播放进度
 *   share/<code>.json         公开分享的歌单快照（只读）
 *
 * 鉴权模型（务实的「口令即密钥」）
 *   slug = SHA-256(SALT | 口令) 前 20 位十六进制。
 *   口令只出现在请求头 X-Coral-Key，服务端据此算出自己的空间；
 *   音频播放地址用 ?s=<slug>（<audio src> 无法带自定义头），
 *   因此 slug 泄漏只等于「只读可播放」泄漏，不泄漏口令本身，也不会泄漏写权限。
 *   注意：这里刻意不做 PBKDF2 —— 校验过程不存在「口令比对」，任何口令都会映射出一个空间，
 *   提高迭代次数对防爆破毫无帮助，反而会撞上 Workers 的 CPU 时间上限。
 *   真正的强度来自口令长度，故强制 ≥ 10 位并在 UI 提供随机口令生成。
 */

export const SALT = 'coral-music-v1';
export const PBKDF_PREFIX = 'coral';
export const MIN_PASS = 10;
export const MAX_UPLOAD = 60 * 1024 * 1024;   // 单文件 60MB（Pages Functions 请求体上限内）
export const SIGN_TTL = 6 * 3600;             // 播放地址有效期（秒）

const HEX = '0123456789abcdef';

export function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

/* ---------- 响应helper ---------- */
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, extra)
  });
}

/* ---------- 鉴权 ---------- */
export function passProblem(pass) {
  const p = String(pass || '');
  if (!p) return '缺少同步口令';
  if (p.length < MIN_PASS) return '口令至少 ' + MIN_PASS + ' 位';
  if (p.length > 128) return '口令过长';
  return null;
}

export function isPassOk(pass) { return passProblem(pass) === null; }

export async function slugOf(pass) {
  const data = new TextEncoder().encode(SALT + '|' + String(pass || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest).slice(0, 20);
}

// 从请求头取口令并换算为空间 slug；不合法返回 null
export async function authSlug(request) {
  const pass = request.headers.get('X-Coral-Key') || '';
  if (!isPassOk(pass)) return null;
  return slugOf(pass);
}

// 生成一份便于抄写的随机口令（4 组 4 字符）
export function randomPass() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 16; i++) {
    s += alphabet[buf[i] % alphabet.length];
    if (i % 4 === 3 && i !== 15) s += '-';
  }
  return s;
}

/* ---------- key 规约 ---------- */
export function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);
}

const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus', 'webm', 'weba', 'mp4'];

export function extOf(filename, contentType) {
  const name = String(filename || '');
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (m && AUDIO_EXT.indexOf(m[1].toLowerCase()) >= 0) return m[1].toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  const map = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
    'audio/x-flac': 'flac', 'audio/aac': 'aac', 'audio/opus': 'opus',
    'audio/webm': 'webm', 'video/webm': 'webm'
  };
  return map[ct] || 'mp3';
}

export function contentTypeOf(ext) {
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus', webm: 'audio/webm',
    weba: 'audio/webm', mp4: 'audio/mp4'
  };
  return map[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

export function audioKey(slug, id, ext) {
  return 'audio/' + slug + '/' + safeId(id) + (ext ? '.' + ext : '');
}
export function audioPrefix(slug) { return 'audio/' + slug + '/'; }
export function stateKey(slug) { return 'state/' + slug + '.json'; }
export function shareKey(code) { return 'share/' + safeId(code) + '.json'; }

/* ---------- Range 解析（音频拖动进度必需） ---------- */
// 返回 {offset, length} | null（无 Range 头）| 'invalid'
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return 'invalid';
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return 'invalid';
  if (!Number.isFinite(size) || size <= 0) return 'invalid';

  let start, end;
  if (!hasStart) {
    const suffix = parseInt(m[2], 10);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  if (end > size - 1) end = size - 1;
  return { offset: start, length: end - start + 1 };
}

/* ---------- 同步负载校验 ---------- */
// 只保留白名单字段并做体量限制，避免把 R2 当成任意内容的垃圾桶
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  if (Array.isArray(raw.lists)) {
    out.lists = raw.lists.filter(function (l) {
      return l && typeof l === 'object' && typeof l.id === 'string' && Array.isArray(l.ids);
    }).slice(0, 200).map(function (l) {
      return {
        id: safeId(l.id),
        name: String(l.name || '歌单').slice(0, 80),
        ids: l.ids.slice(0, 5000).map(safeId).filter(Boolean)
      };
    });
  }
  if (Array.isArray(raw.remote)) {
    out.remote = raw.remote.slice(0, 5000).filter(function (t) {
      return t && typeof t === 'object' && t.id;
    }).map(function (t) {
      const rec = {
        id: safeId(t.id), title: String(t.title || '').slice(0, 200),
        artist: String(t.artist || '').slice(0, 200), url: String(t.url || '').slice(0, 2000)
      };
      if (t.cover) rec.cover = String(t.cover).slice(0, 2000);
      if (t.album) rec.album = String(t.album).slice(0, 200);
      if (typeof t.duration === 'number') rec.duration = Math.max(0, Math.round(t.duration));
      if (t.source) rec.source = safeId(t.source);
      if (t.sid) rec.sid = safeId(t.sid);
      if (t.oid) rec.oid = String(t.oid).slice(0, 120);
      if (t.lid) rec.lid = String(t.lid).slice(0, 120);
      if (t.lsrc) rec.lsrc = safeId(t.lsrc);
      if (t.pid) rec.pid = String(t.pid).slice(0, 120);
      if (t.gsub) rec.gsub = safeId(t.gsub);
      if (t.cloudKey) rec.cloudKey = String(t.cloudKey).slice(0, 300);
      if (t.preview) rec.preview = true;
      if (t.addedAt) rec.addedAt = Number(t.addedAt) || 0;
      return rec;
    });
  }
  if (raw.lyrics && typeof raw.lyrics === 'object') {
    const lyr = {};
    let n = 0;
    for (const k of Object.keys(raw.lyrics)) {
      if (n >= 2000) break;
      const v = raw.lyrics[k];
      if (typeof v !== 'string') continue;
      lyr[safeId(k)] = v.slice(0, 20000);
      n++;
    }
    out.lyrics = lyr;
  }
  if (raw.settings && typeof raw.settings === 'object') {
    const s = {};
    ['theme', 'volume', 'rate', 'eq', 'lyricOffset', 'deskLyrics'].forEach(function (k) {
      if (raw.settings[k] !== undefined) s[k] = raw.settings[k];
    });
    out.settings = s;
  }
  if (raw.stats && typeof raw.stats === 'object') {
    const st = {};
    let n = 0;
    for (const k of Object.keys(raw.stats)) {
      if (n >= 5000) break;
      const v = raw.stats[k];
      if (!v || typeof v !== 'object') continue;
      st[safeId(k)] = { c: Math.max(0, Math.round(Number(v.c) || 0)), at: Math.max(0, Number(v.at) || 0) };
      n++;
    }
    out.stats = st;
  }
  if (raw.progress && typeof raw.progress === 'object') {
    const pg = {};
    let n = 0;
    for (const k of Object.keys(raw.progress)) {
      if (n >= 5000) break;
      const v = Number(raw.progress[k]);
      if (!Number.isFinite(v) || v < 0) continue;
      pg[safeId(k)] = Math.round(v * 100) / 100;
      n++;
    }
    out.progress = pg;
  }
  out.updatedAt = Number(raw.updatedAt) || Date.now();
  out.device = String(raw.device || '').slice(0, 60);
  return out;
}

/* ---------- 分享码 ---------- */
export function newShareCode() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}
