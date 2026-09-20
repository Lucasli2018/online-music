/* session.mjs — 会话（Bearer token）与登录限流
 *
 * 所有写操作都走这里拿到「当前账号」，再由账号推出 R2 空间 slug；
 * 旧版那种「任意口令都能映射出一个空间」的语义已彻底移除。
 */
import {
  expiresStr, genToken, nowStr, RATE_MAX_FAIL, RATE_WINDOW_MIN, SESSION_DAYS, SESSION_RENEW_DAYS
} from './account.mjs';

/* ---------- 会话 ---------- */
export function bearerToken(request) {
  const h = String(request.headers.get('Authorization') || '');
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/i.exec(h.trim());
  return m ? m[1] : '';
}

export function createSession(env, userId, request, extraDays) {
  const token = genToken(32);
  const agent = String(request.headers.get('User-Agent') || '').slice(0, 120);
  return env.DB.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, agent) VALUES (?, ?, ?, ?, ?)'
  ).bind(token, userId, nowStr(), expiresStr(extraDays || SESSION_DAYS), agent).run()
    .then(function () { return token; });
}

export function purgeExpiredSessions(env) {
  return env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowStr()).run()
    .catch(function () { return null; });
}

export function destroySession(env, token) {
  if (!token) return Promise.resolve(false);
  return env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
    .then(function () { return true; })
    .catch(function () { return false; });
}

/**
 * 从请求里解出当前账号。
 * 返回 { user } 或 { error, status }，调用方只需 `if (r.error) return json({error: r.error}, r.status)`。
 */
export function requireUser(request, env) {
  if (!env || !env.DB) return Promise.resolve({ error: '未绑定 D1（DB）', status: 503 });
  const token = bearerToken(request);
  if (!token) return Promise.resolve({ error: '未登录', status: 401 });

  return env.DB.prepare(
    'SELECT u.*, s.expires_at AS sess_expires FROM sessions s ' +
    'JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first().then(function (row) {
    if (!row) return { error: '登录已失效，请重新登录', status: 401 };
    if (row.status !== 'active') return { error: '账号已被停用', status: 403 };
    const now = nowStr();
    if (String(row.sess_expires) < now) {
      return destroySession(env, token).then(function () {
        return { error: '登录已过期，请重新登录', status: 401 };
      });
    }
    // 滑动续期：剩余不足 SESSION_RENEW_DAYS 天就往后推，活跃用户不会被中途踢下线
    let renew = Promise.resolve();
    if (String(row.sess_expires) < expiresStr(SESSION_RENEW_DAYS)) {
      renew = env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
        .bind(expiresStr(SESSION_DAYS), token).run().catch(function () { return null; });
    }
    return renew.then(function () { return { user: row, token: token }; });
  }).catch(function (e) {
    return { error: '账号库不可用：' + String((e && e.message) || e), status: 503 };
  });
}

/* ---------- 组合判断：既要求登录，又要求 R2 绑定 ---------- */
/**
 * 云端接口的统一前置：返回 { user, slug, token } 或 { error, status }。
 * 端点里写 `const a = await requireCloud(request, env); if (a.error) return json({error: a.error}, a.status);`
 */
export function requireCloud(request, env) {
  return requireUser(request, env).then(function (auth) {
    if (auth.error) return { error: auth.error, status: auth.status };
    if (!env || !env.MUSIC_BUCKET) return { error: '未绑定 R2（MUSIC_BUCKET）', status: 503 };
    return { user: auth.user, slug: auth.user.space_slug, token: auth.token };
  });
}

/* ---------- 登录限流 ---------- */
function windowStart() {
  return nowStr(Date.now() - RATE_WINDOW_MIN * 60000);
}

export function recentFailCount(env, username) {
  return env.DB.prepare(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ok = 0 AND created_at >= ?'
  ).bind(username, windowStart()).first().then(function (row) {
    return (row && row.n) || 0;
  }).catch(function () { return 0; });
}

export function recordAttempt(env, username, ip, ok) {
  return env.DB.prepare(
    'INSERT INTO login_attempts (username, ip, ok, created_at) VALUES (?, ?, ?, ?)'
  ).bind(username, String(ip || '').slice(0, 60), ok ? 1 : 0, nowStr()).run()
    .catch(function () { return null; });
}

export function clearAttempts(env, username) {
  return env.DB.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run()
    .catch(function () { return null; });
}

export function isRateLimited(env, username) {
  return recentFailCount(env, username).then(function (n) { return n >= RATE_MAX_FAIL; });
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    '';
}
