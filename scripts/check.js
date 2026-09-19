#!/usr/bin/env node
/* CI / 部署前校验（双闸门）
 *  ① 语法校验：遍历 js/*.js 跑 node --check
 *  ② 逻辑测试：跑 tests/*.test.js（node:test，零第三方依赖）
 * 在 Cloudflare Pages 构建命令设为：node scripts/check.js
 * 任一环节失败即退出码 1，阻断部署。
 */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var jsDir = path.join(root, 'js');
var testsDir = path.join(root, 'tests');

var pass = true;

/* ---------- ① 语法校验 ---------- */
var files = fs.readdirSync(jsDir).filter(function (f) { return f.slice(-3) === '.js'; });
files.forEach(function (f) {
  var full = path.join(jsDir, f);
  try {
    cp.execSync('node --check "' + full + '"', { stdio: 'pipe' });
    console.log('OK   ' + f);
  } catch (e) {
    pass = false;
    console.error('FAIL ' + f);
    var msg = (e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || '';
    console.error(msg);
  }
});
console.log('语法校验：' + files.length + ' 个脚本' + (pass ? '全部通过 ✓' : '存在错误 ✗'));

/* ---------- ② 逻辑测试 ---------- */
var testFiles = [];
if (fs.existsSync(testsDir)) {
  testFiles = fs.readdirSync(testsDir)
    .filter(function (f) { return /\.test\.js$/.test(f); })
    .map(function (f) { return path.join('tests', f); });
}

if (!testFiles.length) {
  console.log('测试：未发现用例，跳过。');
} else {
  var res = cp.spawnSync(process.execPath, ['--test'].concat(testFiles), { cwd: root, encoding: 'utf8' });
  var out = (res.stdout || '') + (res.stderr || '');
  var unsupported = /bad option|unknown option|not supported/i.test(out) && out.indexOf('--test') >= 0;

  if (res.status === 0) {
    out.split(/\r?\n/).forEach(function (line) {
      if (/^# (tests|pass|fail|skipped)/.test(line)) console.log(line.replace(/^# /, ''));
    });
    console.log('测试：' + testFiles.length + ' 个用例文件全部通过 ✓');
  } else if (unsupported) {
    console.warn('测试：当前 Node 版本不支持 `node --test`，已跳过测试闸门（仅语法校验）。');
  } else {
    pass = false;
    out.split(/\r?\n/).forEach(function (line) {
      if (/^(not ok|# (tests|pass|fail|skipped))/.test(line)) console.error(line);
    });
    console.error('测试：存在失败用例，部署已阻断 ✗');
  }
}

if (!pass) {
  console.error('\n校验未通过，部署已阻断。');
  process.exit(1);
}
console.log('\n全部校验通过 ✓');
