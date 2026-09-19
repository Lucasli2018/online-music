/* tests/probe/ui-probe.js — 真浏览器交互探针（无头 Chrome + CDP）
 *
 * 为什么需要它：本项目两次踩过「静态检查全绿但功能实际失效」的坑
 *  ① Service Worker cache-first 让用户端卡旧版 JS（新按钮看得见、点了没反应）
 *  ② 重写事件绑定后 dump-dom 全绿，但拖拽实际失效
 * 因此凡是交互/绑定类改动，都要用真实鼠标事件在真浏览器里跑一遍。
 *
 * 用法：node tests/probe/ui-probe.js
 * 依赖：本机 Chrome（可用 CHROME_PATH 指定路径）；不联网也能跑（示例曲加载失败不影响断言）
 */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var http = require('http');
var os = require('os');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var PORT = 8137;
var DEBUG_PORT = 9333;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json'
};

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function findChrome() {
  var candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  throw new Error('未找到 Chrome，请用 CHROME_PATH 环境变量指定可执行文件路径');
}

function startServer() {
  var server = http.createServer(function (req, res) {
    var p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    var file = path.join(ROOT, p);
    if (file.indexOf(ROOT) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(function (resolve) { server.listen(PORT, '127.0.0.1', function () { resolve(server); }); });
}

function httpJSON(port, pathname) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: port, path: pathname }, function (res) {
      var body = '';
      res.on('data', function (d) { body += d; });
      res.on('end', function () { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function waitForTarget() {
  var tries = 0;
  return new Promise(function (resolve, reject) {
    (function poll() {
      if (tries++ > 80) return reject(new Error('等待 Chrome 调试端口超时'));
      httpJSON(DEBUG_PORT, '/json/list').then(function (list) {
        var page = list.filter(function (t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0];
        if (page) return resolve(page.webSocketDebuggerUrl);
        setTimeout(poll, 250);
      }).catch(function () { setTimeout(poll, 250); });
    })();
  });
}

function makeSend(ws) {
  var id = 0, pending = {};
  ws.addEventListener('message', function (ev) {
    var msg = JSON.parse(ev.data);
    if (msg.id && pending[msg.id]) {
      var cb = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) cb.reject(new Error(msg.error.message));
      else cb.resolve(msg.result);
    }
  });
  return function send(method, params) {
    return new Promise(function (resolve, reject) {
      var mid = ++id;
      pending[mid] = { resolve: resolve, reject: reject };
      ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
    });
  };
}

var results = [];
function check(name, ok, extra) {
  results.push({ name: name, ok: !!ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra === undefined ? '' : '   → ' + extra));
}

(async function main() {
  var chromePath, server, chrome, ws, userDir;
  try {
    chromePath = findChrome();
    server = await startServer();
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coral-probe-'));
    chrome = cp.spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-port=' + DEBUG_PORT,
      '--user-data-dir=' + userDir,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--mute-audio', '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,900',
      'about:blank'
    ], { stdio: 'ignore' });

    var wsUrl = await waitForTarget();
    ws = new WebSocket(wsUrl);
    await new Promise(function (resolve, reject) {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', function () { reject(new Error('CDP WebSocket 连接失败')); });
    });
    var send = makeSend(ws);
    await send('Page.enable');
    await send('Runtime.enable');

    function evalJS(expression) {
      return send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true })
        .then(function (r) {
          if (r.exceptionDetails) {
            var d = r.exceptionDetails.exception;
            throw new Error('页面执行异常：' + ((d && d.description) || r.exceptionDetails.text));
          }
          return r.result.value;
        });
    }
    function waitFor(expression, timeoutMs) {
      var deadline = Date.now() + (timeoutMs || 8000);
      return (function poll() {
        return evalJS(expression).then(function (v) {
          if (v) return true;
          if (Date.now() > deadline) return false;
          return sleep(150).then(poll);
        });
      })();
    }
    // 真实鼠标点击（非 element.click()），确保走完整事件派发链路
    async function clickSel(sel) {
      var box = await evalJS('(function(){var e=document.querySelector(' + JSON.stringify(sel) +
        ');if(!e)return null;var r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      if (!box) throw new Error('点击目标不存在：' + sel);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }

    console.log('\n── 珊瑚音乐 交互探针 ──\n');
    // 收集页面未捕获错误（导航前注入，避免遗漏初始化阶段的报错）
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__probeErrors=[];' +
        'window.addEventListener("error",function(e){window.__probeErrors.push(String(e.message));});' +
        'window.addEventListener("unhandledrejection",function(e){window.__probeErrors.push("unhandledrejection: "+e.reason);});'
    });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    var ready = await waitFor('!!(window.CM && window.CM.Player && window.CM.Library && document.getElementById("btn-stats"))', 15000);
    if (!ready) throw new Error('页面初始化超时：CM 命名空间或统计按钮未就绪');

    // 1. 顶栏统计入口
    check('顶栏存在「📊 统计」按钮', await evalJS('!!document.getElementById("btn-stats")'));
    check('统计弹窗初始为隐藏', await evalJS('document.getElementById("stats-modal").classList.contains("hidden")'));

    // 2. 载入示例曲（真实点击）
    await clickSel('#btn-load-samples');
    var hasTracks = await waitFor('document.querySelectorAll("#playlist li.track").length >= 5');
    check('点击「🎵 示例曲」后左栏渲染出曲目', hasTracks,
      '曲目数=' + (await evalJS('document.querySelectorAll("#playlist li.track").length')));

    // 3. 虚拟歌单标签
    var tabText = await evalJS('Array.from(document.querySelectorAll("#list-tabs .list-tab")).map(function(t){return t.textContent;}).join("|")');
    check('歌单栏出现「最近」虚拟标签', tabText.indexOf('最近') >= 0, tabText);
    check('歌单栏出现「最常播」虚拟标签', tabText.indexOf('最常播') >= 0);

    // 4. 打开统计面板
    await clickSel('#btn-stats');
    var opened = await waitFor('!document.getElementById("stats-modal").classList.contains("hidden")');
    check('点击统计按钮后弹窗打开', opened);
    var cards = await evalJS('document.querySelectorAll("#stats-body .stat-card").length');
    check('统计面板渲染 4 张概览卡片', cards === 4, '实际 ' + cards);
    var emptyRank = await evalJS('document.getElementById("stats-body").textContent.indexOf("还没有播放记录") >= 0');
    check('无播放记录时给出空态提示', emptyRank);
    var bars = await evalJS('document.querySelectorAll("#stats-body .stat-bar-row").length');
    check('来源分布按音源渲染进度条', bars >= 1, '条数 ' + bars);

    // 5. 关闭弹窗
    await clickSel('#stats-close');
    var closed = await waitFor('document.getElementById("stats-modal").classList.contains("hidden")');
    check('点击 ✕ 可关闭统计弹窗', closed);

    // 6. 点击第一首播放 → 统计落库
    await clickSel('#playlist li.track');
    var played = await waitFor('window.CM.Player.getStats && Object.keys(window.CM.Player.getStats()).length > 0', 6000);
    check('点击曲目开始播放后产生播放统计', played,
      JSON.stringify(await evalJS('window.CM.Player.getStats()')));

    // 7. 统计面板反映播放数据
    await clickSel('#btn-stats');
    await waitFor('!document.getElementById("stats-modal").classList.contains("hidden")');
    var body = await evalJS('document.getElementById("stats-body").textContent');
    check('统计面板显示「累计播放」且次数 ≥ 1', /累计播放/.test(body) && !/累计播放0 次/.test(body), body.slice(0, 80));
    var rankItems = await evalJS('document.querySelectorAll("#stats-body .stat-rank-item").length');
    check('播放排行出现条目', rankItems >= 1, '条目 ' + rankItems);
    await clickSel('#stats-close');

    // 8. 虚拟歌单联动：「最近」计数 ≥ 1 且可切换
    var recentCount = await evalJS('(function(){var t=Array.from(document.querySelectorAll("#list-tabs .list-tab")).filter(function(x){return x.textContent.indexOf("最近")===0;})[0];return t?parseInt(t.querySelector(".list-tab-count").textContent,10):-1;})()');
    check('「最近」标签计数 ≥ 1', recentCount >= 1, '计数 ' + recentCount);

    var recentSel = await evalJS('(function(){var t=Array.from(document.querySelectorAll("#list-tabs .list-tab")).filter(function(x){return x.textContent.indexOf("最近")===0;})[0];if(!t)return null;var r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
    if (recentSel) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: recentSel.x, y: recentSel.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: recentSel.x, y: recentSel.y, button: 'left', clickCount: 1 });
    }
    var recentTracks = await waitFor('document.querySelectorAll("#playlist li.track").length === 1', 6000);
    check('切到「最近」后只显示听过的曲目', recentTracks,
      '曲目数=' + (await evalJS('document.querySelectorAll("#playlist li.track").length')));

    // 9. 云面板：绑定生效 + 无 Functions 环境下正确降级
    check('顶栏存在「☁️ 云端」按钮', await evalJS('!!document.getElementById("btn-cloud")'));
    await clickSel('#btn-cloud');
    check('点击后云端弹窗打开', await waitFor('!document.getElementById("cloud-modal").classList.contains("hidden")'));
    var noPass = await evalJS('document.getElementById("cloud-status").textContent');
    check('未设置口令时给出引导文案', /口令/.test(noPass), noPass);

    await evalJS('(function(){document.getElementById("cloud-pass").value="short";})()');
    await clickSel('#cloud-pass-save');
    await sleep(200);
    var shortMsg = await evalJS('document.getElementById("cloud-status").textContent');
    check('口令过短时拒绝保存并提示', /10 位/.test(shortMsg), shortMsg);

    await evalJS('(function(){document.getElementById("cloud-pass").value="probe-pass-2026";})()');
    await clickSel('#cloud-pass-save');
    var degraded = await waitFor(
      '(function(){var t=document.getElementById("cloud-status").textContent;return t.indexOf("不可用")>=0||t.indexOf("失败")>=0;})()', 6000);
    var degradeMsg = await evalJS('document.getElementById("cloud-status").textContent');
    check('本地无 Functions 时给出降级提示（不静默失败）', degraded, degradeMsg);
    check('降级提示说明了原因', /api|Pages/.test(degradeMsg), degradeMsg);

    await clickSel('#cloud-close');
    check('云端弹窗可关闭', await waitFor('document.getElementById("cloud-modal").classList.contains("hidden")'));

    // 10. 无控制台错误
    var errs = await evalJS('JSON.stringify(window.__probeErrors || [])');
    check('页面运行期间无未捕获错误', errs === '[]', errs);
  } catch (e) {
    check('探针执行完成', false, e && e.message);
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { if (chrome) chrome.kill(); } catch (e) {}
    try { if (server) server.close(); } catch (e) {}
    try { if (userDir) fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {}
  }

  var failed = results.filter(function (r) { return !r.ok; });
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 项通过');
  if (failed.length) {
    console.log('失败项：' + failed.map(function (f) { return f.name; }).join('、'));
    process.exit(1);
  }
  console.log('交互探针全部通过 ✓');
})();
