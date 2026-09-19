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

    // 自动应答原生弹窗（prompt / confirm）——无头浏览器会卡在对话框上
    var pendingDialog = null;
    function willAnswerDialog(text) { pendingDialog = text; }
    ws.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.method !== 'Page.javascriptDialogOpening') return;
      var reply = { accept: true };
      if (pendingDialog !== null) { reply.promptText = String(pendingDialog); pendingDialog = null; }
      send('Page.handleJavaScriptDialog', reply).catch(function () {});
    });

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

    /* ---------- 5D 音效（十段 EQ / 交叉淡入淡出 / 响度均衡 / AB 循环） ---------- */
    check('顶栏存在「🎛 音效」按钮', await evalJS('!!document.getElementById("btn-eq")'));
    await clickSel('#btn-eq');
    check('音效弹窗打开', await waitFor('!document.getElementById("fx-modal").classList.contains("hidden")'));

    var bandCount = await evalJS('document.querySelectorAll("#eq-band .eq-cell").length');
    check('均衡器渲染十段滑块', bandCount === 10, '实际 ' + bandCount);
    var presetCount = await evalJS('document.querySelectorAll("#eq-presets .eq-preset").length');
    check('预设按钮齐全（≥6 个）', presetCount >= 6, '实际 ' + presetCount);
    check('默认预设标记为「平坦」',
      (await evalJS('document.getElementById("eq-current").textContent')) === '平坦');

    // 点「低音增强」预设 → 滑块值、播放引擎 EQ、标记三处同步
    await clickSel('#eq-presets .eq-preset[data-preset="bass"]');
    await sleep(120);
    var bassEQ = await evalJS('JSON.stringify(window.CM.Player.getEQ())');
    var presets = await evalJS('JSON.stringify(window.CM.Player.EQ_PRESETS.bass)');
    check('点击预设后引擎 EQ 等于该预设', bassEQ === presets, bassEQ);
    check('预设按钮高亮切到「低音增强」',
      await evalJS('document.querySelector(\'#eq-presets .eq-preset[data-preset="bass"]\').classList.contains("active")'));
    check('十段滑块视觉值随之更新',
      (await evalJS('document.querySelector("#eq-band .eq-cell .eq-gain").textContent')) !== '0');

    // 真实键盘交互：聚焦首段滑块后按方向键，验证 input 事件真的绑上了
    await clickSel('#eq-band .eq-cell:first-child input');
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' });
    await sleep(120);
    var eq0 = await evalJS('window.CM.Player.getEQ()[0]');
    var input0 = await evalJS('parseInt(document.querySelector("#eq-band .eq-cell:first-child input").value,10)');
    check('方向键调整滑块后引擎 EQ 同步', eq0 === input0 + 0 && input0 > 0, 'input=' + input0 + ' eq=' + eq0);

    // 自定义值应取消预设高亮
    check('偏离预设后标记为「自定义」',
      (await evalJS('document.getElementById("eq-current").textContent')) === '自定义');

    // 交叉淡入淡出：聚焦后按方向键（步长 0.5）
    await clickSel('#fx-crossfade');
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' });
    await sleep(120);
    var cf = await evalJS('window.CM.Player.getCrossfade()');
    check('交叉淡入淡出可调且写入引擎', cf > 0 && cf <= 8, 'crossfade=' + cf);
    check('交叉时长标签不再显示「关闭」',
      (await evalJS('document.getElementById("fx-crossfade-val").textContent')) !== '关闭');

    // 响度均衡开关
    await clickSel('#fx-loudness');
    await sleep(120);
    check('勾选后响度均衡开启', await evalJS('window.CM.Player.getLoudness()') === true);

    // 变速不变调：先在音效弹窗改，再关掉弹窗去倍速弹窗改，验证双向同步
    await clickSel('#fx-keep-pitch');
    await sleep(120);
    check('音效弹窗关闭变速不变调后引擎同步', await evalJS('window.CM.Player.getKeepPitch()') === false);
    check('倍速弹窗的同一开关同步为未勾选',
      await evalJS('document.getElementById("rate-keep-pitch").checked') === false);

    // 恢复默认：EQ 归零、交叉关闭、变速不变调回到开启
    await clickSel('#fx-reset');
    await sleep(150);
    check('恢复默认后 EQ 归零',
      (await evalJS('JSON.stringify(window.CM.Player.getEQ())')) === '[0,0,0,0,0,0,0,0,0,0]',
      await evalJS('JSON.stringify(window.CM.Player.getEQ())'));
    check('恢复默认后交叉淡入淡出关闭', await evalJS('window.CM.Player.getCrossfade()') === 0);
    check('恢复默认后变速不变调回到开启', await evalJS('window.CM.Player.getKeepPitch()') === true);

    await clickSel('#fx-close');
    check('音效弹窗可关闭', await waitFor('document.getElementById("fx-modal").classList.contains("hidden")'));

    // 倍速弹窗里的同一开关（弹窗之间必须双向同步，不能各说各话）
    await clickSel('#btn-rate');
    check('倍速弹窗打开', await waitFor('!document.getElementById("rate-modal").classList.contains("hidden")'));
    await clickSel('#rate-keep-pitch');
    await sleep(120);
    check('倍速弹窗关闭变速不变调后引擎同步', await evalJS('window.CM.Player.getKeepPitch()') === false);
    check('音效弹窗的同一开关同步为未勾选',
      await evalJS('document.getElementById("fx-keep-pitch").checked') === false);
    await clickSel('#rate-close');
    await waitFor('document.getElementById("rate-modal").classList.contains("hidden")');
    // 复位，避免影响后续断言
    await evalJS('window.CM.Player.setKeepPitch(true)');

    // AB 段循环：真实点击 A / B / 清除
    check('AB 控件初始为未设置状态',
      (await evalJS('document.getElementById("ab-label").textContent')) === 'AB 未设置');
    await clickSel('#btn-ab-a');
    await sleep(120);
    check('设 A 点后记录起点并高亮', await evalJS('window.CM.Player.getAb().a') !== null &&
      await evalJS('document.getElementById("btn-ab-a").classList.contains("active")'));
    check('设 A 点后标签给出下一步提示',
      /待设 B/.test(await evalJS('document.getElementById("ab-label").textContent')),
      await evalJS('document.getElementById("ab-label").textContent'));

    var abDur = await evalJS('window.CM.Player.getActiveDuration()');
    if (abDur > 1) {
      // 先把播放位置挪到 10% 与 30%，得到一段明确的循环区间（避免曲目恰好已播完导致 A=B）
      await evalJS('window.CM.Player.seekRatio(0.1)');
      await sleep(150);
      await clickSel('#btn-ab-a');
      var aAt = await evalJS('window.CM.Player.getAb().a');
      await evalJS('window.CM.Player.seekRatio(0.3)');
      await sleep(150);
      await clickSel('#btn-ab-b');
      await sleep(150);
      check('设 B 点后进入 AB 循环', await evalJS('window.CM.Player.getAb().on') === true,
        'A=' + aAt + ' B=' + (await evalJS('window.CM.Player.getAb().b')));
      check('AB 标签显示区间与循环状态',
        /循环中/.test(await evalJS('document.getElementById("ab-label").textContent')),
        await evalJS('document.getElementById("ab-label").textContent'));
      check('进度条下方出现 AB 区间高亮',
        !(await evalJS('document.getElementById("ab-band").classList.contains("hidden")')));
      await clickSel('#btn-ab-clear');
      await sleep(120);
      check('清除后 AB 循环关闭', await evalJS('window.CM.Player.getAb().on') === false);
    } else {
      // 音频未真正加载（离线环境）时，B 点应被拒绝 —— 同样验证了校验链路
      await clickSel('#btn-ab-b');
      await sleep(150);
      check('（离线降级）B 点未晚于 A 点时被拒绝', await evalJS('window.CM.Player.getAb().on') === false,
        'duration=' + abDur);
      check('（离线降级）拒绝原因以文案给出',
        /0.3 秒/.test(await evalJS('document.getElementById("toast").textContent')),
        await evalJS('document.getElementById("toast").textContent'));
      await clickSel('#btn-ab-clear');
      await sleep(120);
      check('清除后 AB 状态复位', await evalJS('window.CM.Player.getAb().a') === null);
    }

    /* ---------- 5E 曲库管理（排序 / 批量多选 / 去重 / 歌单重命名） ---------- */
    check('左栏工具条渲染多选 / 排序 / 去重三项',
      await evalJS('!!document.getElementById("btn-multi") && !!document.getElementById("sort-select") && !!document.getElementById("btn-dedupe")'));
    var sortOpts = await evalJS('document.getElementById("sort-select").options.length');
    check('排序下拉包含七种模式', sortOpts === 7, '实际 ' + sortOpts);

    // 先切回「全部」歌单：前面的虚拟歌单只显示听过的曲目，排序与批量都需要完整列表
    await clickSel('#list-tabs .list-tab');
    var allCount = await waitFor('document.querySelectorAll("#playlist li.track").length >= 5');
    check('切回「全部」歌单后曲目完整', allCount,
      '曲目数=' + (await evalJS('document.querySelectorAll("#playlist li.track").length')));

    // 排序：切到「歌名」后左栏顺序应与按标题排序一致
    var titlesBefore = await evalJS('JSON.stringify(Array.from(document.querySelectorAll("#playlist .track-title")).map(function(e){return e.textContent;}))');
    await evalJS('(function(){var s=document.getElementById("sort-select");s.value="title";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await sleep(200);
    check('切到「歌名」排序后顺序符合标题升序',
      await evalJS('(function(){var ts=Array.from(document.querySelectorAll("#playlist .track-title")).map(function(e){return e.textContent;});' +
        'var exp=ts.slice().sort(function(a,b){return a.localeCompare(b,"zh-Hans-CN");});return JSON.stringify(ts)===JSON.stringify(exp);})()'),
      titlesBefore);
    // 排序偏好应落盘
    check('排序偏好写入 localStorage', (await evalJS('localStorage.getItem("cm-sort")')) === 'title');
    await evalJS('(function(){var s=document.getElementById("sort-select");s.value="default";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await sleep(150);

    // 批量多选
    await clickSel('#btn-multi');
    await sleep(150);
    check('进入多选态后批量工具条出现',
      !(await evalJS('document.getElementById("batch-bar").classList.contains("hidden")')) &&
      (await evalJS('document.querySelector(".lib-tools").classList.contains("hidden")')));
    var pickCount = await evalJS('document.querySelectorAll("#playlist .track-pick").length');
    var rowCount = await evalJS('document.querySelectorAll("#playlist li.track").length');
    check('每行出现勾选框', pickCount === rowCount && pickCount > 0, pickCount + '/' + rowCount);

    await clickSel('#playlist li.track:nth-child(1)');
    await clickSel('#playlist li.track:nth-child(2)');
    await sleep(150);
    check('勾选两首后计数正确',
      (await evalJS('document.getElementById("batch-count").textContent')) === '已选 2 首',
      await evalJS('document.getElementById("batch-count").textContent'));
    check('选中行有视觉标记',
      (await evalJS('document.querySelectorAll("#playlist li.track.selected").length')) === 2 &&
      (await evalJS('document.querySelectorAll("#playlist .track-pick.on").length')) === 2);
    check('多选态下不显示单曲操作按钮',
      (await evalJS('document.querySelectorAll("#playlist li.track.multi .track-del").length')) === 0);

    var qBefore = await evalJS('window.CM.Player.getQueue().length');
    await clickSel('#batch-queue');
    await sleep(200);
    var qAfter = await evalJS('window.CM.Player.getQueue().length');
    check('批量加入队列后队列长度 +2', qAfter === qBefore + 2, qBefore + ' → ' + qAfter);
    check('批量操作后自动退出多选态',
      await evalJS('document.getElementById("batch-bar").classList.contains("hidden")'));

    // 取消按钮
    await clickSel('#btn-multi');
    await sleep(120);
    await clickSel('#playlist li.track:nth-child(1)');
    await sleep(120);
    await clickSel('#batch-cancel');
    await sleep(150);
    check('点「取消」退出多选并清空勾选',
      await evalJS('document.getElementById("batch-bar").classList.contains("hidden")') === true &&
      await evalJS('document.getElementById("batch-count").textContent') === '已选 0 首');

    // 去重：先注入两条同标题同歌手的曲目，再触发重渲染
    await evalJS('(function(){var L=window.CM.Library;' +
      'L.addTrack({id:"dup-a",title:"重复曲",artist:"测试",source:"online",url:"https://x/a.mp3",duration:100,addedAt:1});' +
      'L.addTrack({id:"dup-b",title:"重复曲",artist:"测试",source:"online",url:"https://x/b.mp3",addedAt:2});' +
      '})()');
    await clickSel('#list-tabs .list-tab');   // 点「全部」tab 触发左栏重渲染
    await sleep(250);
    await clickSel('#btn-dedupe');
    check('去重弹窗打开', await waitFor('!document.getElementById("dedupe-modal").classList.contains("hidden")'));
    var groups = await evalJS('document.querySelectorAll("#dedupe-list .dedupe-group").length');
    check('检测出 1 组重复', groups === 1, '实际 ' + groups);
    check('默认保留信息更完整的一条（有时长的）',
      await evalJS('document.querySelector("#dedupe-list .dedupe-row.keep .dedupe-info").textContent.indexOf("1:40") >= 0'),
      await evalJS('document.querySelector("#dedupe-list .dedupe-row.keep .dedupe-info").textContent'));
    var totalBefore = await evalJS('document.querySelectorAll("#playlist li.track").length');
    await clickSel('#dedupe-apply');
    await sleep(350);
    var totalAfter = await evalJS('document.querySelectorAll("#playlist li.track").length');
    check('删除重复后曲库只剩一条', totalAfter === totalBefore - 1, totalBefore + ' → ' + totalAfter);
    check('删除后重新扫描显示无重复',
      /没有发现重复歌曲/.test(await evalJS('document.getElementById("dedupe-summary").textContent')));
    await clickSel('#dedupe-close');
    check('去重弹窗可关闭', await waitFor('document.getElementById("dedupe-modal").classList.contains("hidden")'));

    // 歌单重命名（激活的歌单标签上的 ✎ → 内联输入 → 回车确认）
    willAnswerDialog('探针歌单');
    await clickSel('#btn-new-list');
    var newTab = await waitFor('Array.from(document.querySelectorAll("#list-tabs .list-tab")).some(function(t){return t.textContent.indexOf("探针歌单")>=0;})');
    check('新建歌单后标签出现', newTab);
    check('仅激活的歌单标签带重命名入口',
      await evalJS('document.querySelectorAll("#list-tabs .list-tab.active .tab-edit").length') === 1 &&
      await evalJS('document.querySelectorAll("#list-tabs .list-tab .tab-edit").length') === 1);
    // 标签溢出检查：活动标签必须落在标签栏可视区内，否则落在滚动区外点不到
    check('活动歌单标签在标签栏可视区内',
      await evalJS('(function(){var box=document.querySelector(".list-tabs").getBoundingClientRect();' +
        'var t=document.querySelector("#list-tabs .list-tab.active").getBoundingClientRect();' +
        'return t.left >= box.left - 0.5 && t.right <= box.right + 0.5;})()'));
    await clickSel('#list-tabs .list-tab.active .tab-edit');
    var renameOpen = await waitFor('!!document.querySelector("#list-tabs .tab-rename")');
    check('点 ✎ 进入内联重命名', renameOpen);
    if (renameOpen) {
      await send('Input.insertText', { text: '重命名后' });
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
      await sleep(250);
      check('回车确认后标签更名成功',
        await evalJS('Array.from(document.querySelectorAll("#list-tabs .list-tab")).some(function(t){return t.textContent.indexOf("重命名后")>=0;})'),
        await evalJS('Array.from(document.querySelectorAll("#list-tabs .list-tab")).map(function(t){return t.textContent;}).join("|")'));
      check('重命名写回数据层',
        await evalJS('Object.keys(window.CM.Library.getLists()).some(function(k){return window.CM.Library.getList(k).name==="重命名后";})'));
      // 清理：删除该歌单
      var del = await evalJS('(function(){var t=Array.from(document.querySelectorAll("#list-tabs .list-tab")).filter(function(x){return x.textContent.indexOf("重命名后")>=0;})[0];' +
        'if(!t)return null;var d=t.querySelector(".tab-del");var r=d.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      if (del) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: del.x, y: del.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: del.x, y: del.y, button: 'left', clickCount: 1 });
        await sleep(250);
        check('删除测试歌单后标签消失',
          !(await evalJS('Array.from(document.querySelectorAll("#list-tabs .list-tab")).some(function(t){return t.textContent.indexOf("重命名后")>=0;})')));
      }
    }

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
