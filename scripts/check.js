#!/usr/bin/env node
/* CI / 部署前语法校验：遍历 js/*.js 跑 node --check
 * 在 Cloudflare Pages 构建命令设为：node scripts/check.js
 * 任一文件语法错误则退出码 1，阻断部署。
 */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var path = require('path');

var dir = path.join(__dirname, '..', 'js');
var files = fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); });

var ok = true;
files.forEach(function (f) {
  var full = path.join(dir, f);
  try {
    cp.execSync('node --check "' + full + '"', { stdio: 'pipe' });
    console.log('OK   ' + f);
  } catch (e) {
    ok = false;
    console.error('FAIL ' + f);
    var msg = (e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || '';
    console.error(msg);
  }
});

if (!ok) {
  console.error('\n语法校验未通过，部署已阻断。');
  process.exit(1);
}
console.log('\n全部 ' + files.length + ' 个脚本语法校验通过 ✓');
