-- 0000_accounts.sql — 账号密码登录（替代原「口令即密钥」）
--
-- 应用（本地）：wrangler d1 migrations apply online-music-db --local
-- 应用（线上）：wrangler d1 migrations apply online-music-db --remote
--
-- 时间统一用 datetime('now','+8 hours') 生成 "YYYY-MM-DD HH:MM:SS"（东八区），
-- 同一格式可直接字符串比较，避免时区换算出错。

-- 1) 账号表
--    space_slug 是 R2 里的空间标识：audio/<slug>/... 、state/<slug>.json
--    由注册时随机生成（20 位 hex），不再由口令派生。
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,                 -- 小写规范化的登录名
  display_name  TEXT,
  pass_hash     TEXT NOT NULL,                 -- PBKDF2-SHA256 派生结果（hex）
  pass_salt     TEXT NOT NULL,                 -- 每账号独立随机盐（hex）
  pass_iter     INTEGER NOT NULL DEFAULT 100000,-- 该账号落库时的迭代数（便于日后平滑升级）
  space_slug    TEXT NOT NULL,                 -- R2 空间标识
  migrated_from TEXT,                          -- 由哪个旧口令空间接管而来（仅作记录）
  status        TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slug     ON users(space_slug);

-- 2) 会话表（Bearer token）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  expires_at TEXT NOT NULL,
  agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 3) 登录尝试（滑动窗口限流；持久化以保证跨 isolate 一致）
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  ip         TEXT,
  ok         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_user_time ON login_attempts(username, created_at);
