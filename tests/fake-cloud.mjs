/* tests/fake-cloud.mjs — 后端测试基座：R2 / D1 内存替身
 *
 * 为什么要自己写替身：项目零依赖（不引入 miniflare / wrangler 测试栈），
 * 但 Pages Functions 的 handler 只依赖「有 get/put/list/head/delete 的 bucket」
 * 和「有 prepare().bind().first()/run() 的 db」这两个鸭子类型的表面，
 * 所以内存替身足以把端点测到接近端到端的程度。
 *
 * D1 替身按 SQL 语句模式分派。SQL 集合是本项目自己写的、封闭的，
 * 因此模式匹配足够可靠；新增 SQL 时必须同步在这里补一条，否则会显式报错（而不是静默返回错数据）。
 */

/* 把 R2 可能收到的各种入参统一成 Buffer：
 * Buffer / string / ArrayBuffer / TypedArray 都会有 —— 端点里上传走 file.arrayBuffer()，
 * 接管旧空间时走 bucket.get().body（Buffer）。漏掉 ArrayBuffer 分支会把内容变成
 * "[object ArrayBuffer]" 这种幽灵字符串，且断言只在字符串比对时才暴露。 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value));
}

/* ===================== R2 ===================== */
export function fakeBucket() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value, opts) {
      const buf = toBuffer(value);
      store.set(key, {
        buf,
        httpMetadata: (opts && opts.httpMetadata) || {},
        customMetadata: (opts && opts.customMetadata) || {},
        uploaded: new Date('2026-09-19T09:00:00Z')
      });
      return { key };
    },
    async get(key, opts) {
      const o = store.get(key);
      if (!o) return null;
      let body = o.buf, range = null;
      if (opts && opts.range) {
        const offset = opts.range.offset;
        const length = opts.range.length;
        body = o.buf.subarray(offset, offset + length);
        range = { offset, length };
      }
      return {
        key, size: o.buf.length, range,
        httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, uploaded: o.uploaded,
        body,
        text: async () => o.buf.toString('utf8'),
        arrayBuffer: async () => body
      };
    },
    async head(key) {
      const o = store.get(key);
      return o ? { key, size: o.buf.length, httpMetadata: o.httpMetadata } : null;
    },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const prefix = opts.prefix || '';
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, o]) => ({
          key: k, size: o.buf.length, uploaded: o.uploaded,
          httpMetadata: o.httpMetadata, customMetadata: o.customMetadata
        }));
      const limit = opts.limit || 1000;
      const offset = opts.cursor ? parseInt(opts.cursor, 10) || 0 : 0;
      const objects = all.slice(offset, offset + limit);
      const next = offset + objects.length;
      const truncated = next < all.length;
      // include 参数在替身里默认全给（真实 R2 必须显式 include 才返回元数据，
      // 这条差异不影响断言，元数据永远比线上更全，不会掩盖「忘了 include」的 bug）
      return { objects, truncated, cursor: truncated ? String(next) : undefined };
    }
  };
}

/* ===================== D1 ===================== */
export function fakeD1() {
  const users = [], sessions = [], attempts = [];
  let nextUserId = 1;

  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const nowMs = () => Date.now();

  function insertUser(args) {
    const [username, display_name, pass_hash, pass_salt, pass_iter, space_slug, created_at] = args;
    if (users.some(u => u.username === username)) {
      throw new Error('UNIQUE constraint failed: users.username');
    }
    if (users.some(u => u.space_slug === space_slug)) {
      throw new Error('UNIQUE constraint failed: users.space_slug');
    }
    const row = {
      id: nextUserId++, username, display_name, pass_hash, pass_salt,
      pass_iter, space_slug, migrated_from: null, status: 'active',
      last_login_at: null, created_at
    };
    users.push(row);
    return { success: true, meta: { last_row_id: row.id, changes: 1 } };
  }

  function run(sql, args) {
    const s = norm(sql);
    if (/^INSERT INTO users/i.test(s)) return insertUser(args);
    if (/^UPDATE users SET last_login_at = \? WHERE id = \?/i.test(s)) {
      const u = users.find(x => x.id === args[1]);
      if (u) u.last_login_at = args[0];
      return { success: true, meta: { changes: u ? 1 : 0 } };
    }
    if (/^UPDATE users SET pass_hash = \?, pass_iter = \?, last_login_at = \? WHERE id = \?/i.test(s)) {
      const u = users.find(x => x.id === args[3]);
      if (u) { u.pass_hash = args[0]; u.pass_iter = args[1]; u.last_login_at = args[2]; }
      return { success: true, meta: { changes: u ? 1 : 0 } };
    }
    if (/^UPDATE users SET migrated_from = \? WHERE id = \?/i.test(s)) {
      const u = users.find(x => x.id === args[1]);
      if (u) u.migrated_from = args[0];
      return { success: true, meta: { changes: u ? 1 : 0 } };
    }
    if (/^INSERT INTO sessions/i.test(s)) {
      sessions.push({
        token: args[0], user_id: args[1], created_at: args[2],
        expires_at: args[3], agent: args[4]
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM sessions WHERE expires_at < \?/i.test(s)) {
      const before = sessions.length;
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (String(sessions[i].expires_at) < String(args[0])) sessions.splice(i, 1);
      }
      return { success: true, meta: { changes: before - sessions.length } };
    }
    if (/^DELETE FROM sessions WHERE token = \?/i.test(s)) {
      const i = sessions.findIndex(x => x.token === args[0]);
      if (i >= 0) sessions.splice(i, 1);
      return { success: true, meta: { changes: i >= 0 ? 1 : 0 } };
    }
    if (/^UPDATE sessions SET expires_at = \? WHERE token = \?/i.test(s)) {
      const s0 = sessions.find(x => x.token === args[1]);
      if (s0) s0.expires_at = args[0];
      return { success: true, meta: { changes: s0 ? 1 : 0 } };
    }
    if (/^INSERT INTO login_attempts/i.test(s)) {
      attempts.push({ username: args[0], ip: args[1], ok: args[2], created_at: args[3] });
      return { success: true, meta: { changes: 1 } };
    }
    if (/^DELETE FROM login_attempts WHERE username = \?/i.test(s)) {
      const before = attempts.length;
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i].username === args[0]) attempts.splice(i, 1);
      }
      return { success: true, meta: { changes: before - attempts.length } };
    }
    throw new Error('fakeD1 未覆盖的 SQL(run): ' + s);
  }

  function first(sql, args) {
    const s = norm(sql);
    if (/^SELECT \* FROM users WHERE username = \?/i.test(s)) {
      return users.find(u => u.username === args[0]) || null;
    }
    if (/^SELECT \* FROM users WHERE space_slug = \?/i.test(s)) {
      return users.find(u => u.space_slug === args[0]) || null;
    }
    if (/^SELECT \* FROM users WHERE id = \?/i.test(s)) {
      return users.find(u => u.id === args[0]) || null;
    }
    if (/^SELECT COUNT\(\*\) AS n FROM users/i.test(s)) {
      return { n: users.length };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM login_attempts WHERE username = \? AND ok = 0 AND created_at >= \?/i.test(s)) {
      return { n: attempts.filter(a => a.username === args[0] && !a.ok && String(a.created_at) >= String(args[1])).length };
    }
    if (/FROM sessions s JOIN users u ON u\.id = s\.user_id WHERE s\.token = \?/i.test(s)) {
      const sess = sessions.find(x => x.token === args[0]);
      if (!sess) return null;
      const u = users.find(x => x.id === sess.user_id);
      if (!u) return null;
      return Object.assign({}, u, { sess_expires: sess.expires_at });
    }
    throw new Error('fakeD1 未覆盖的 SQL(first): ' + s);
  }

  // 注意：bind() 必须把参数带进新闭包，不能靠修改共享的 stmt._args ——
  // 否则「先 prepare 再 bind」的调用会全部以空参数执行（曾踩：注册时用户名全变 undefined）。
  function makeStmt(sql, args) {
    const bound = args || [];
    return {
      bind(...a) { return makeStmt(sql, a); },
      first: () => Promise.resolve().then(() => first(sql, bound)),
      run: () => Promise.resolve().then(() => run(sql, bound)),
      all: () => Promise.resolve().then(() => ({ results: [] }))
    };
  }

  return {
    _users: users,
    _sessions: sessions,
    _attempts: attempts,
    prepare(sql) { return makeStmt(sql); }
  };
}

/* ===================== 组合环境 ===================== */
// AUTH_ITER 压到 1000：PBKDF2 的迭代数由环境变量控制（线上默认 100000），
// 测试里没必要真的烧 CPU，也顺带验证了「迭代数来自 AUTH_ITER」这条通路。
export function cloudEnv(overrides) {
  return Object.assign({ MUSIC_BUCKET: fakeBucket(), DB: fakeD1(), AUTH_ITER: '1000' }, overrides || {});
}

export function ctx(request, e, params) {
  return { request, env: e, params: params || {} };
}

export async function readJSON(res) {
  return JSON.parse(await res.text());
}

/* 直接往 D1 替身里塞一个账号（等价于「已注册」），返回 { row, token } */
export async function seedUser(db, opts) {
  const account = await import('../functions/_lib/account.mjs');
  const session = await import('../functions/_lib/session.mjs');
  opts = opts || {};
  const username = opts.username || 'lucas';
  const password = opts.password || 'supersecret';
  const iter = opts.iter || 1000;          // 测试里用低迭代数，跑得快
  const salt = account.genSalt();
  const hash = await account.hashPassword(password, salt, iter);
  const slug = opts.slug || account.newSlug();
  const r = await db.prepare(
    'INSERT INTO users (username, display_name, pass_hash, pass_salt, pass_iter, space_slug, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(username, opts.displayName || username, hash, salt, iter, slug, account.nowStr()).run();

  const id = r.meta.last_row_id;
  const token = opts.token || account.genToken(32);
  await db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at, agent) VALUES (?, ?, ?, ?, ?)'
  ).bind(token, id, account.nowStr(), account.expiresStr(30), 'test').run();

  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return { row, token, slug, password, session };
}

/* 给请求加 Bearer 令牌 */
export function authed(url, token, init) {
  init = init || {};
  init.headers = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + token });
  return new Request(url, init);
}
