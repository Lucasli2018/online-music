#!/usr/bin/env node
/* scripts/probe-auth-cost.mjs — 实测 PBKDF2-SHA256 在不同迭代数下的耗时
 *
 * 用途：决定 wrangler.toml 里 AUTH_ITER 该设多少。
 *
 * 背景：Cloudflare Workers 免费计划单次请求 CPU 上限 10ms、付费计划 30s。
 * PBKDF2 的耗时近似线性于迭代数，所以迭代数既是安全参数也是可用性参数：
 * 设高了线上登录直接 500 / 1102（CPU time exceeded），设低了离线爆破变便宜。
 * 100000 是常见的安全下限推荐值，用付费计划时保持它。
 *
 * 注意：这里跑的是本机 Node，只能作为「数量级」参考。
 * 线上真实耗时必须在部署后用一次真实登录请求来确认（本脚本会顺带测一遍本地 Pages 运行时）。
 *
 * 用法：node scripts/probe-auth-cost.mjs [迭代数...]
 */
import { pbkdf2, genSalt } from '../functions/_lib/account.mjs';

const ITERS = process.argv.slice(2).map(Number).filter(Boolean);
const list = ITERS.length ? ITERS : [10000, 20000, 50000, 100000, 200000];

const FREE_TIER_CPU_MS = 10;    // Workers 免费计划
const PAID_TIER_CPU_MS = 30000; // Workers 付费计划

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

console.log('\n── PBKDF2-SHA256 单次派生耗时（本机）──\n');
console.log('  迭代数      中位耗时     3 次采样');

const rows = [];
for (const iter of list) {
  const salt = genSalt();
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    await pbkdf2('benchmark-password', salt, iter, 256);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const med = median(samples);
  rows.push({ iter, med });
  console.log('  ' + String(iter).padEnd(11) + (med.toFixed(1) + ' ms').padEnd(13) +
    samples.map((s) => s.toFixed(1)).join(' / '));
}

console.log('\n── 结论 ──');
const ok = rows.filter((r) => r.med <= FREE_TIER_CPU_MS);
if (ok.length) {
  console.log('  本机上不超过免费计划 10ms 预算的最大迭代数：' + Math.max(...ok.map((r) => r.iter)));
} else {
  console.log('  本机全部候选值都超过免费计划的 10ms 预算 —— 免费计划请把 AUTH_ITER 降到 10000 以下，');
  console.log('  或升到付费计划（30s 上限）后保持 100000。');
}
console.log('  线上实际耗时请部署后用一次真实登录确认；也可运行');
console.log('    node tests/probe/cloud-e2e.mjs');
console.log('  它会打印本地 Pages 运行时上「注册 / 登录」请求的真实墙钟耗时（含 PBKDF2）。\n');
