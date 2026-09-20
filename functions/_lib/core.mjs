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
 * 鉴权模型（v2：账号密码）
 *   users 表 + sessions 表（见 migrations/0000_accounts.sql）。
 *   写操作一律走 _lib/session.mjs 的 requireUser()，由账号行上的 space_slug 决定 R2 空间。
 *   空间 slug 是注册时随机生成的 20 位 hex —— 与密码无关，也无法从 slug 反推账号。
 *
 *   唯一的例外是读音频：<audio src> 无法携带自定义请求头，所以 /api/audio/:id?s=<slug>
 *   用 slug 本身当读凭据。因此 slug 泄漏只等于「该空间音频能被播放」，不泄漏写权限，
 *   也不泄漏任何账号信息 —— 这是刻意接受的权衡。
 *
 *   slugOf() 现在只服务于一件历史遗留的事：把 v1「口令即密钥」空间接管到账号名下
 *   （见 api/auth/adopt.mjs）。新代码不要再用它做鉴权。
 */

export const SALT = 'coral-music-v1';         // v1 口令空间的盐，仅接管旧数据时使用
export const MIN_PASS = 10;                   // 旧口令最短长度（仅接管时校验）
export const MAX_UPLOAD = 60 * 1024 * 1024;   // 单文件 60MB（Pages Functions 请求体上限内）

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

/* ---------- v1 遗留：旧口令 → 空间 slug ---------- */
// 只给 adopt 用：把当年的「口令即密钥」空间算出来，再把里面的对象搬到账号名下。
// 不属于鉴权路径 —— 它无法证明任何归属，所以任何调用方都不得用它授权写操作。
export async function slugOf(pass) {
  const data = new TextEncoder().encode(SALT + '|' + String(pass || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest).slice(0, 20);
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
