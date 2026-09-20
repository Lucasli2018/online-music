// D1 远程初始化脚本：把 migrations/*.sql 逐条应用到线上 online-music-db
//
// 为什么不用 `wrangler d1 migrations apply --remote`：
//   那个命令需要 wrangler 先完成 OAuth 登录（交互式浏览器授权）。本脚本走 REST API，
//   只要有一个具备「Account → D1 → Edit」权限的令牌就能无人值守执行，便于 CI / 宿主环境。
//   两条路等价（都跑同一批 migration SQL），哪个方便用哪个。
//
// 用法：
//   设好 CLOUDFLARE_API_TOKEN（需 D1 Edit 权限）后：
//     node scripts/init-d1.mjs              # 库必须已存在
//     node scripts/init-d1.mjs --create     # 不存在则自动创建
//   也可以用 TOKEN_FILE=/path/to/token 指定令牌文件（优先于环境变量）——
//   宿主环境可能预置了一个权限不足的 CLOUDFLARE_API_TOKEN（例如只有 Pages:Edit），
//   这时用 TOKEN_FILE 显式覆盖更稳妥。
//
// 幂等：migrations 里全是 CREATE ... IF NOT EXISTS，可重复执行。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ACCT = "332b848d9f5d9ec2808bdb855763eb8e";
const DB_NAME = "online-music-db";
const BUCKET_NAME = "music-audio";
const CREATE = process.argv.includes("--create");

const token = (process.env.TOKEN_FILE ? readFileSync(process.env.TOKEN_FILE, "utf8").trim() : "")
  || process.env.CLOUDFLARE_API_TOKEN || "";
if (!token) {
  console.error("缺少 CLOUDFLARE_API_TOKEN 或 TOKEN_FILE");
  process.exit(1);
}
console.error(`token: len=${token.length} prefix=${token.slice(0, 6)}${token === token.trim() ? "" : " (含首尾空白!)"}`);

// 本机到 CF 的链路会间歇性抖动（连接超时 / 偶发 10000 auth error），全部纳入重试
const api = async (path, opts = {}, retries = 8) => {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}${path}`, {
        ...opts,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
      });
      const j = await r.json();
      if (j.success) return j.result;
      lastErr = new Error(JSON.stringify(j.errors));
      // 10000 = 认证/权限类瞬时错误 → 重试；其余（语法错、约束冲突）直接抛
      if (j.errors?.[0]?.code !== 10000) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (e instanceof TypeError === false && !String(e.message).includes("10000")) throw e;
    }
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
    process.stderr.write(`  retry ${i + 1}/${retries}\n`);
  }
  throw lastErr;
};

/* ---------- 1) 找 / 建 D1 数据库 ---------- */
const dbs = await api("/d1/database");
let db = dbs.find(d => d.name === DB_NAME);
if (!db) {
  if (!CREATE) {
    console.error(`未找到 D1 数据库 ${DB_NAME}，加 --create 可自动创建`);
    process.exit(1);
  }
  db = await api("/d1/database", { method: "POST", body: JSON.stringify({ name: DB_NAME }) });
  console.log(`已创建 D1 数据库 ${DB_NAME} (${db.uuid})`);
} else {
  console.log(`D1 数据库 ${DB_NAME} (${db.uuid})`);
}

const query = sql =>
  api(`/d1/database/${db.uuid}/query`, { method: "POST", body: JSON.stringify({ sql }) });

/* ---------- 2) 检查 R2 桶（只提示不创建：桶里可能有真实音频） ---------- */
try {
  const buckets = (await api("/r2/buckets")).buckets || [];
  const has = buckets.some(b => b.name === BUCKET_NAME);
  console.log(`R2 桶 ${BUCKET_NAME}：${has ? "已存在" : "**不存在，需先在 R2 里创建**"}`);
} catch (e) {
  console.log(`R2 桶检查跳过（当前令牌可能没有 R2 读权限）：${String(e.message).slice(0, 80)}`);
}

/* ---------- 3) 读 migrations/*.sql → 去注释 → 按分号拆语句 → 逐条执行 ---------- */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migDir = join(root, "migrations");
const files = readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
if (!files.length) {
  console.error(`migrations 目录里没有 .sql：${migDir}`);
  process.exit(1);
}

let ok = 0, skip = 0, fail = 0;
for (const f of files) {
  const raw = readFileSync(join(migDir, f), "utf8");
  const cleaned = raw.split("\n").filter(l => !l.trimStart().startsWith("--")).join("\n");
  const stmts = cleaned.split(";").map(s => s.trim()).filter(Boolean);
  console.log(`\n${f}：${stmts.length} 条语句`);

  for (const s of stmts) {
    const label = s.slice(0, 72).replace(/\s+/g, " ");
    try {
      await query(s);
      ok++;
      console.log("  OK   " + label);
    } catch (e) {
      if (/already exists|duplicate column/i.test(e.message)) {
        skip++;
        console.log("  SKIP " + label + "  （已存在）");
      } else {
        fail++;
        console.error("  FAIL " + label + "\n       " + e.message);
      }
    }
  }
}
console.log(`\n语句执行：ok=${ok} skip=${skip} fail=${fail}`);
if (fail) process.exit(1);

/* ---------- 4) 验证表结构 ---------- */
const tables = await query(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
);
const names = (tables[0].results || []).map(r => r.name);
console.log("\n表：" + names.join(", "));

const counts = await query(
  "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions) AS sessions, " +
  "(SELECT COUNT(*) FROM login_attempts) AS attempts"
);
console.log("行数：" + JSON.stringify(counts[0].results[0]));

const need = ["login_attempts", "sessions", "users"];
const missing = need.filter(n => !names.includes(n));
if (missing.length) {
  console.error(`缺少表：${missing.join(", ")}`);
  process.exit(1);
}

const indexes = await query(
  "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
);
console.log("索引：" + (indexes[0].results || []).map(r => r.name).join(", "));

console.log("\n初始化完成 ✅");
console.log("下一步（部署由你手动执行）：在 Pages 项目里绑定 DB → " + DB_NAME);
