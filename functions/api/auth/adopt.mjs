/* /api/auth/adopt —— 接管旧「口令空间」的数据
 *   POST { oldPass, batch? } → { ok, copied, skipped, remaining, state, done }
 *
 * 背景：v1 的云端空间标识是 SHA-256(SALT|口令) 的前 20 位，无法反推账号归属。
 * 老用户注册账号后，从这里输入当年的同步口令，就能把那一坨 R2 数据搬到新账号名下。
 *
 * 三个刻意的设计选择：
 *  1) 只复制、不删除源空间。否则任何人拿一个乱猜的口令（只要 ≥10 位）就能把别人的
 *     空间清空 —— 校验不了归属的接口不该有破坏性副作用。残留数据只是占点 R2 空间。
 *  2) 幂等：目标侧已存在的 key 直接跳过，中断后重复调用不会产生重复文件。
 *  3) 分批：音频可能有几十上百 MB，单次请求复制太多会撞 Worker 的 CPU / 时长上限，
 *     所以按 batch 搬运，前端循环调用直到 done。
 */
import { MIN_PASS, audioKey, audioPrefix, json, safeId, slugOf, stateKey } from '../../_lib/core.mjs';
import { requireUser } from '../../_lib/session.mjs';
import { markMigrated } from '../../_lib/users.mjs';

const MAX_BATCH = 40;
const SCAN_LIMIT = 1000;    // 单空间最多扫描 1000 个对象（远超普通个人曲库）

// "audio/<slug>/<id>.<ext>" → { id, ext }
function splitKey(key, prefix) {
  const rest = String(key).slice(prefix.length);
  const m = /^(.*)\.([A-Za-z0-9]+)$/.exec(rest);
  return m ? { id: m[1], ext: m[2] } : { id: rest, ext: '' };
}

async function listAll(bucket, prefix, withMeta) {
  const out = [];
  let cursor = null;
  do {
    const page = await bucket.list({
      prefix: prefix,
      limit: SCAN_LIMIT,
      cursor: cursor || undefined,
      include: withMeta ? ['httpMetadata', 'customMetadata'] : undefined
    });
    (page.objects || []).forEach(function (o) { out.push(o); });
    cursor = page.truncated ? page.cursor : null;
  } while (cursor && out.length < SCAN_LIMIT);
  return out;
}

export async function onRequestPost({ request, env }) {
  const auth = await requireUser(request, env);
  if (auth.error) return json({ error: auth.error }, auth.status);
  if (!env || !env.MUSIC_BUCKET) return json({ error: '未绑定 R2（MUSIC_BUCKET）' }, 503);

  let body;
  try { body = await request.json(); }
  catch (e) { return json({ error: 'JSON 解析失败' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不合法' }, 400);

  const oldPass = String(body.oldPass == null ? '' : body.oldPass);
  if (oldPass.length < MIN_PASS) return json({ error: '旧口令至少 ' + MIN_PASS + ' 位' }, 400);
  if (oldPass.length > 128) return json({ error: '旧口令过长' }, 400);

  const oldSlug = await slugOf(oldPass);
  const newSlug = auth.user.space_slug;
  if (oldSlug === newSlug) return json({ error: '这就是当前账号的空间，无需接管' }, 400);

  const batch = Math.max(1, Math.min(MAX_BATCH, parseInt(body.batch, 10) || 20));
  const bucket = env.MUSIC_BUCKET;

  // 目标侧已有对象（用于跳过已搬运的，保证幂等）
  const existing = new Set();
  (await listAll(bucket, audioPrefix(newSlug), false)).forEach(function (o) { existing.add(o.key); });

  const srcObjects = await listAll(bucket, audioPrefix(oldSlug), true);
  if (!srcObjects.length) {
    return json({ ok: true, copied: 0, skipped: 0, total: 0, remaining: 0, state: 'none', done: true, message: '该口令下没有云端曲目' });
  }

  const copied = [];
  let skipped = 0;
  for (let i = 0; i < srcObjects.length && copied.length < batch; i++) {
    const o = srcObjects[i];
    const parts = splitKey(o.key, audioPrefix(oldSlug));
    const id = safeId(parts.id);
    if (!id) { skipped++; continue; }
    const target = audioKey(newSlug, id, parts.ext);
    if (existing.has(target)) { skipped++; continue; }

    const obj = await bucket.get(o.key);
    if (!obj) { skipped++; continue; }
    await bucket.put(target, obj.body, {
      httpMetadata: (obj.httpMetadata && obj.httpMetadata.contentType)
        ? { contentType: obj.httpMetadata.contentType }
        : { contentType: 'application/octet-stream' },
      customMetadata: {
        title: String((obj.customMetadata && obj.customMetadata.title) || '').slice(0, 200),
        artist: String((obj.customMetadata && obj.customMetadata.artist) || '').slice(0, 200)
      }
    });
    copied.push(target);
  }

  // 曲库快照：只在目标侧还没有快照时搬，不覆盖新账号已有的数据
  let stateResult = 'skipped';
  const hasDst = await bucket.head(stateKey(newSlug));
  if (!hasDst) {
    const srcState = await bucket.get(stateKey(oldSlug));
    if (srcState) {
      await bucket.put(stateKey(newSlug), srcState.body, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
      });
      stateResult = 'adopted';
    } else {
      stateResult = 'none';
    }
  }

  const moved = copied.length + skipped;
  const remaining = Math.max(0, srcObjects.length - moved);
  if (remaining === 0) await markMigrated(env, auth.user.id, oldSlug);

  return json({
    ok: true,
    copied: copied.length,
    skipped: skipped,
    total: srcObjects.length,
    remaining: remaining,
    state: stateResult,
    done: remaining === 0
  });
}
