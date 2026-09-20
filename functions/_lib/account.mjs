/* account.mjs — 账号密码体系的纯逻辑（Pages Functions 专用，零依赖）
 *
 * 与旧「口令即密钥」的差别：
 *   旧：口令 → SHA-256 → slug，服务端不存任何东西，也就无法验证口令。
 *   新：真实账号表，服务端保存 PBKDF2 派生值，能验证口令；空间 slug 随机生成、与口令无关。
 *
 * 密码哈希为什么是 PBKDF2-SHA256：
 *   旧模型不存在「比对」因此拉伸无意义；新模型有比对，离线爆破就是真实威胁，
 *   必须用慢哈希 + 每账号随机盐。迭代数落在 DB 的 pass_iter 列，
 *   日后提高 ITER 常量时，老账号仍按其原迭代数校验，并在校验成功后自动渐进升级。
 *
 * 迭代数与 Workers CPU 预算（重要）：
 *   Cloudflare Workers 免费计划单次请求 CPU 上限 10ms，付费为 30s。
 *   PBKDF2 的耗时近似线性于迭代数，故迭代数通过环境变量 AUTH_ITER 可调：
 *     - 付费计划（或 PAGES 上未触发 CPU 限制）：设 100000（默认，推荐）
 *     - 免费计划若登录返回 500/1102（CPU 超限）：降到 20000 或 10000
 *   本项目脚本 scripts/probe-auth-cost.mjs 可在本地实测你机器上的单次耗时。
 */

export const DEFAULT_ITER = 100000;
export const MIN_ITER = 1000;

export const MIN_USER = 3;
export const MAX_USER = 24;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export const SESSION_DAYS = 30;          // 会话有效期
export const SESSION_RENEW_DAYS = 7;     // 剩余不足 7 天时自动续期（滑动过期）
export const RATE_WINDOW_MIN = 15;       // 限流窗口（分钟）
export const RATE_MAX_FAIL = 8;          // 窗口内允许的失败次数

const HEX = '0123456789abcdef';
const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;

export function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

export function fromHex(hex) {
  const s = String(hex || '');
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

/* ---------- 随机 ---------- */
export function genToken(bytes) {
  const buf = new Uint8Array(bytes || 32);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function genSalt() { return genToken(16); }

// 新账号的空间标识：20 位 hex，格式与旧口令派生值一致（保持 R2 目录/key 规则不变）
export function newSlug() { return genToken(10); }

/* ---------- 密码哈希 ---------- */
export function iterFromEnv(env) {
  const raw = env && env.AUTH_ITER;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= MIN_ITER) return n;
  return DEFAULT_ITER;
}

export function pbkdf2(password, saltHex, iter, bits) {
  const subtle = crypto && crypto.subtle;
  if (!subtle) return Promise.reject(new Error('需要 Web Crypto（HTTPS / Workers 环境）'));
  const enc = new TextEncoder();
  return subtle.importKey('raw', enc.encode(String(password)), { name: 'PBKDF2' }, false, ['deriveBits'])
    .then(function (key) {
      return subtle.deriveBits({
        name: 'PBKDF2',
        salt: fromHex(saltHex),
        iterations: iter,
        hash: 'SHA-256'
      }, key, bits || 256);
    })
    .then(toHex);
}

export function hashPassword(password, saltHex, iter) {
  return pbkdf2(password, saltHex, iter, 256);
}

// 恒定时间比较，避免用响应时间侧信道逐字节猜哈希
export function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function verifyPassword(password, saltHex, iter, expectedHash) {
  return hashPassword(password, saltHex, iter).then(function (actual) {
    return safeEqual(actual, expectedHash);
  });
}

/* ---------- 输入校验 ---------- */
export function normalizeUsername(u) {
  return String(u == null ? '' : u).trim().toLowerCase();
}

export function usernameProblem(u) {
  const name = normalizeUsername(u);
  if (!name) return '请填写用户名';
  if (!USERNAME_RE.test(name)) {
    return '用户名需 ' + MIN_USER + '-' + MAX_USER + ' 位，仅限小写字母、数字、下划线、连字符';
  }
  return null;
}

// 密码强度：只卡长度与字符种类上限，不搞复杂的「必须含符号」规则
export function passwordProblem(p) {
  const s = String(p == null ? '' : p);
  if (!s) return '请填写密码';
  if (s.length < MIN_PASSWORD) return '密码至少 ' + MIN_PASSWORD + ' 位';
  if (s.length > MAX_PASSWORD) return '密码过长（上限 ' + MAX_PASSWORD + ' 位）';
  return null;
}

export function displayNameOf(raw, username) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return username;
  return s.slice(0, 32);
}

/* ---------- 时间（与 SQLite datetime('now','+8 hours') 同格式） ---------- */
// 注意：必须先整体 +8 小时再取 UTC 字段，不能只给 getUTCHours() 加 8。
// 后者在东八区 00:00–08:00 之间会算出 "24:xx:xx" 这种非法小时，
// 与 SQLite datetime('now','+8 hours') 的字符串比较会在跨日边界必然出错。
export function nowStr(ms) {
  const d = new Date((ms === undefined ? Date.now() : ms) + 8 * 3600000);
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
    ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}

export function expiresStr(days, fromMs) {
  return nowStr((fromMs === undefined ? Date.now() : fromMs) + days * 86400000);
}

/* ---------- 对外用户视图（绝不外泄 hash/salt） ---------- */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    spaceSlug: row.space_slug,
    createdAt: row.created_at || '',
    lastLoginAt: row.last_login_at || ''
  };
}
