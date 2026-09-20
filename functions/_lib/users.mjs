/* users.mjs — 账号表的数据库访问层（与 account.mjs 的纯逻辑分开，便于各自单测）
 *
 * D1 用的是 SQLite。所有时间列都是 "YYYY-MM-DD HH:MM:SS"（东八区）文本，可直接字符串比较。
 * 并发注册同名用户由 idx_users_username 唯一索引兜底，这里只负责把约束错误翻译成友好文案。
 */
import {
  DEFAULT_ITER, iterFromEnv, genSalt, hashPassword, nowStr, newSlug, normalizeUsername
} from './account.mjs';

function dbMissing(env) {
  return !env || !env.DB;
}

export function findByName(env, username) {
  if (dbMissing(env)) return Promise.resolve(null);
  return env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(normalizeUsername(username)).first()
    .catch(function () { return null; });
}

export function findBySlug(env, slug) {
  if (dbMissing(env)) return Promise.resolve(null);
  return env.DB.prepare('SELECT * FROM users WHERE space_slug = ?').bind(String(slug || '')).first()
    .catch(function () { return null; });
}

/* 注册：派生哈希 → 随机空间 slug → 落库。返回 { user } 或 { error, status } */
export function createUser(env, opts) {
  if (dbMissing(env)) return Promise.resolve({ error: '未绑定 D1（DB）', status: 503 });
  const username = normalizeUsername(opts.username);
  const displayName = String(opts.displayName || '').trim().slice(0, 32) || username;
  const iter = iterFromEnv(env);
  const salt = genSalt();
  const slug = newSlug();

  return hashPassword(opts.password, salt, iter).then(function (hash) {
    return env.DB.prepare(
      'INSERT INTO users (username, display_name, pass_hash, pass_salt, pass_iter, space_slug, created_at) ' +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(username, displayName, hash, salt, iter, slug, nowStr()).run().then(function (r) {
      const id = (r.meta && r.meta.last_row_id) || 0;
      return {
        id: id,
        username: username,
        display_name: displayName,
        space_slug: slug,
        pass_hash: hash,
        pass_salt: salt,
        pass_iter: iter,
        status: 'active',
        created_at: nowStr()
      };
    }, function (e) {
      const msg = String((e && e.message) || e);
      if (/UNIQUE|constraint/i.test(msg)) {
        return { error: '该用户名已被注册', status: 409 };
      }
      return { error: '注册失败：' + msg, status: 500 };
    });
  });
}

/* 校验成功后：更新登录时间、（必要时）把哈希升到当前迭代数。
 * plainPassword 只在本次调用内用于「用新迭代数重算哈希」，不落库、不返回。 */
export function noteLogin(env, user, plainPassword) {
  if (dbMissing(env) || !user) return Promise.resolve(user);
  const cur = Number(user.pass_iter) || DEFAULT_ITER;
  const target = iterFromEnv(env);
  const now = nowStr();

  // 渐进升级：迭代数提高后，老账号在下次登录成功时自动迁移到新强度
  if (target > cur && plainPassword) {
    return hashPassword(plainPassword, user.pass_salt, target).then(function (hash) {
      return env.DB.prepare(
        'UPDATE users SET pass_hash = ?, pass_iter = ?, last_login_at = ? WHERE id = ?'
      ).bind(hash, target, now, user.id).run().then(function () {
        user.pass_hash = hash;
        user.pass_iter = target;
        user.last_login_at = now;
      }, function () { return null; });
    });
  }
  return env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
    .bind(now, user.id).run().then(function () {
      user.last_login_at = now;
    }, function () { return null; });
}

export function markMigrated(env, userId, fromSlug) {
  if (dbMissing(env)) return Promise.resolve(false);
  return env.DB.prepare('UPDATE users SET migrated_from = ? WHERE id = ?')
    .bind(String(fromSlug || '').slice(0, 40), userId).run()
    .then(function () { return true; }, function () { return false; });
}

