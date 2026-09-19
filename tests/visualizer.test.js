/* tests/visualizer.test.js — 5F 可视化多模式
 * 用 canvas / 2D 上下文替身驱动四种模式，断言：
 *   · 有 analyser 时读真实频谱与时域数据；无 analyser 时走装饰动画且不报错
 *   · 每种模式都真的画了东西（调用了绘制 API），而不是静默跳过
 *   · 模式切换、尺寸自适应、停止时清空画布
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function fakeCanvas(w, h) {
  var calls = [];
  function rec(name) { return function () { calls.push(name); }; }
  var ctx2d = {
    canvas: null,
    clearRect: rec('clearRect'),
    setTransform: rec('setTransform'),
    save: rec('save'),
    restore: rec('restore'),
    translate: rec('translate'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arcTo: rec('arcTo'),
    arc: rec('arc'),
    closePath: rec('closePath'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    createLinearGradient: function () { calls.push('gradient'); return { addColorStop: function () {} }; }
  };
  var el = {
    width: 0,
    height: 0,
    getContext: function () { return ctx2d; },
    getBoundingClientRect: function () { return { width: w, height: h, left: 0, top: 0 }; },
    _calls: calls,
    _ctx: ctx2d
  };
  return el;
}

function fakeAnalyser() {
  var reads = { freq: 0, wave: 0 };
  return {
    fftSize: 256,
    frequencyBinCount: 128,
    getByteFrequencyData: function (arr) {
      reads.freq++;
      for (var i = 0; i < arr.length; i++) arr[i] = (i * 7) % 256;
    },
    getByteTimeDomainData: function (arr) {
      reads.wave++;
      for (var i = 0; i < arr.length; i++) arr[i] = 128 + Math.round(90 * Math.sin(i / 6));
    },
    _reads: reads
  };
}

function setup(w, h) {
  var canvas = fakeCanvas(w === undefined ? 260 : w, h === undefined ? 260 : h);
  var ctx = helpers.createAppContext({ Audio: helpers.createAudioStub });
  ctx.document = { documentElement: {}, querySelector: function () { return null; } };
  ctx.getComputedStyle = function () {
    return { getPropertyValue: function (name) { return name === '--accent' ? '#ff7a45' : '#ffb38a'; } };
  };
  var CM = helpers.loadModules(['visualizer.js'], ctx);
  CM.Visualizer.init(canvas);
  return { V: CM.Visualizer, canvas: canvas, calls: canvas._calls };
}

/* ---------- 模式注册表 ---------- */

test('模式：四种模式齐全，标签与图标一一对应', function () {
  var s = setup();
  assert.deepStrictEqual(helpers.plain(s.V.MODE_ORDER), ['bars', 'wave', 'ring', 'minimal']);
  s.V.MODE_ORDER.forEach(function (m) {
    assert.ok(s.V.MODE_LABELS[m], '缺少标签：' + m);
    assert.ok(s.V.MODE_ICONS[m], '缺少图标：' + m);
  });
});

test('模式：默认频谱条，可切换且忽略非法值', function () {
  var s = setup();
  assert.strictEqual(s.V.getMode(), 'bars');
  assert.strictEqual(s.V.setMode('ring'), 'ring');
  assert.strictEqual(s.V.getMode(), 'ring');
  assert.strictEqual(s.V.setMode('不存在'), 'ring', '非法模式应保持原状');
  assert.strictEqual(s.V.getMode(), 'ring');
});

test('模式：nextMode 按顺序循环', function () {
  var s = setup();
  assert.strictEqual(s.V.nextMode(), 'wave');
  assert.strictEqual(s.V.nextMode(), 'ring');
  assert.strictEqual(s.V.nextMode(), 'minimal');
  assert.strictEqual(s.V.nextMode(), 'bars');
});

/* ---------- 渲染 ---------- */

test('渲染：四种模式都真的绘制（不是静默跳过）', function () {
  var s = setup();
  s.V.MODE_ORDER.forEach(function (m) {
    s.V.setMode(m);
    var before = s.calls.length;
    s.V.render();
    var added = s.calls.slice(before);
    assert.ok(added.indexOf('clearRect') >= 0, m + ' 未清空画布');
    assert.ok(added.indexOf('beginPath') >= 0, m + ' 未绘制路径');
    assert.ok(added.indexOf('fill') >= 0 || added.indexOf('stroke') >= 0, m + ' 未填充或描边');
  });
});

test('渲染：无 analyser 时走装饰动画且不报错', function () {
  var s = setup();
  s.V.setAnalyser(null);
  s.V.MODE_ORDER.forEach(function (m) {
    s.V.setMode(m);
    assert.doesNotThrow(function () { s.V.render(); }, m + ' 在装饰模式下抛错');
  });
});

test('渲染：接入 analyser 后读取真实频谱与时域数据', function () {
  var s = setup();
  var an = fakeAnalyser();
  s.V.setAnalyser(an);
  s.V.setMode('bars');
  s.V.render();
  assert.ok(an._reads.freq >= 1, '频谱条应读取频域数据');
  // render 的参数表无条件求值，故这里比较增量而不是绝对值
  var beforeWave = an._reads.wave;
  var beforeFreq = an._reads.freq;
  s.V.setMode('wave');
  s.V.render();
  assert.ok(an._reads.wave > beforeWave, '波形应读取时域数据');
  assert.ok(an._reads.freq > beforeFreq, '每帧都要重新取频谱，避免画旧数据');
});

test('渲染：画布尺寸为 0 时安全跳过（隐藏状态下不应报错）', function () {
  var s = setup(0, 0);
  assert.doesNotThrow(function () { s.V.render(); });
  assert.ok(s.calls.indexOf('clearRect') >= 0, '仍应清空一次，避免残留旧画面');
});

test('渲染：改变尺寸后按新尺寸绘制', function () {
  var s = setup(100, 100);
  s.V.render();
  assert.strictEqual(s.canvas.width, 100 * 1, 'resize 应按 CSS 尺寸 × dpr 设置画布像素');
  s.canvas.getBoundingClientRect = function () { return { width: 300, height: 300, left: 0, top: 0 }; };
  s.V.resize();
  assert.strictEqual(s.canvas.width, 300);
});

test('停止：取消动画帧并清空画布', function () {
  var s = setup();
  s.V.start();
  s.V.stop();
  assert.ok(s.calls.indexOf('clearRect') >= 0);
  // 停止后不应再自动排队绘制（requestAnimationFrame 由沙箱默认实现吞掉，这里只验证不抛错）
  assert.doesNotThrow(function () { s.V.stop(); });
});
