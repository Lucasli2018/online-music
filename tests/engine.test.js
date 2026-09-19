/* tests/engine.test.js — 5D 音频引擎
 * 覆盖：十段 EQ 与预设（含 3 段时代的兼容映射）、变速不变调、AB 段循环、
 *       交叉淡入淡出（双池四通道）、响度均衡。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function setup(opts) {
  opts = opts || {};
  var instances = [];
  var frames = [];
  var clock = { t: 0 };
  function FakeAudio() {
    var a = helpers.createAudioStub();
    instances.push(a);
    return a;
  }
  var loadOpts = {
    Audio: FakeAudio,
    onRaf: function (cb) { frames.push(cb); },
    performance: { now: function () { return clock.t; } }
  };
  if (opts.audioCtx) loadOpts.AudioContext = function () { return opts.audioCtx; };
  var cm = helpers.loadCM(['player.js'], loadOpts);
  cm.Player.init();
  return { P: cm.Player, audio: instances, frames: frames, clock: clock };
}

/* 元素创建顺序固定为 A1(可分析), B1(直连), A2(可分析), B2(直连) */
var A1 = 0, B1 = 1, A2 = 2, B2 = 3;

function drainFrames(s) {
  var cbs = s.frames.splice(0, s.frames.length);
  cbs.forEach(function (cb) { cb(s.clock.t); });
  return cbs.length;
}

function remote(id) { return { id: id, title: id, url: 'https://x/' + id + '.mp3' }; }
function local(id) { return { id: id, title: id, source: 'local', file: {} }; }

/* ---------- 十段均衡器 ---------- */

test('EQ：频率表为标准十段', function () {
  var s = setup();
  assert.strictEqual(s.P.EQ_FREQS.length, 10);
  assert.deepStrictEqual(helpers.plain(s.P.EQ_FREQS), [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  assert.strictEqual(s.P.getEQ().length, 10);
});

test('EQ：预设齐全且都是十段、取值合法', function () {
  var s = setup();
  var names = Object.keys(s.P.EQ_PRESETS);
  ['flat', 'pop', 'rock', 'classical', 'vocal', 'bass'].forEach(function (n) {
    assert.ok(names.indexOf(n) >= 0, '缺少预设 ' + n);
  });
  names.forEach(function (n) {
    var g = s.P.EQ_PRESETS[n];
    assert.strictEqual(g.length, 10, n + ' 不是十段');
    g.forEach(function (v) { assert.ok(v >= -12 && v <= 12, n + ' 取值越界：' + v); });
  });
});

test('EQ：应用预设后 getEQ 与滤波器同步', function () {
  var ctx = helpers.createAudioContextStub();
  var s = setup({ audioCtx: ctx });
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, true);                 // 建立 Web Audio 链路
  assert.strictEqual(ctx._created.filters.length, 10, '应创建十个滤波器');
  assert.strictEqual(ctx._created.sources, 2, '两个可分析元素都要接入链路');

  assert.strictEqual(s.P.setEQPreset('rock'), true);
  assert.deepStrictEqual(helpers.plain(s.P.getEQ()), helpers.plain(s.P.EQ_PRESETS.rock));
  assert.strictEqual(ctx._created.filters[0].gain.value, s.P.EQ_PRESETS.rock[0]);
  assert.strictEqual(ctx._created.filters[9].gain.value, s.P.EQ_PRESETS.rock[9]);

  assert.strictEqual(s.P.setEQPreset('不存在的预设'), false);
});

test('EQ：兼容旧版三段数据（低/中/高映射到十段）', function () {
  var s = setup();
  var mapped = helpers.plain(s.P.normalizeEQ([6, -3, 9]));
  assert.strictEqual(mapped.length, 10);
  assert.deepStrictEqual(mapped.slice(0, 3), [6, 6, 6]);        // 低频 → 前三段
  assert.deepStrictEqual(mapped.slice(3, 7), [-3, -3, -3, -3]);  // 中频 → 中间四段
  assert.deepStrictEqual(mapped.slice(7), [9, 9, 9]);           // 高频 → 后三段
});

test('EQ：十段输入原样接受并钳制在 ±12', function () {
  var s = setup();
  var g = helpers.plain(s.P.normalizeEQ([99, -99, 1, 2, 3, 4, 5, 6, 7, 8]));
  assert.strictEqual(g[0], 12);
  assert.strictEqual(g[1], -12);
  assert.strictEqual(g[9], 8);
});

test('EQ：非法输入被拒绝且不改变当前设置', function () {
  var s = setup();
  s.P.setEQPreset('bass');
  var before = helpers.plain(s.P.getEQ());
  assert.strictEqual(s.P.normalizeEQ(null), null);
  assert.strictEqual(s.P.normalizeEQ('flat'), null);
  assert.strictEqual(s.P.normalizeEQ([1, 2]), null);
  assert.strictEqual(s.P.setEQ([1, 2]), false);
  assert.deepStrictEqual(helpers.plain(s.P.getEQ()), before);
});

/* ---------- 变速不变调 ---------- */

test('变速不变调：默认开启，可切换并同步到全部通道', function () {
  var s = setup();
  assert.strictEqual(s.P.getKeepPitch(), true);
  assert.strictEqual(s.P.setKeepPitch(false), false);
  assert.strictEqual(s.P.getKeepPitch(), false);
  s.audio.forEach(function (el, i) {
    assert.strictEqual(el.preservesPitch, false, '第 ' + i + ' 个元素未同步');
  });
});

test('变速不变调：偏好写入 localStorage 并可恢复', function () {
  var storage = helpers.createStorage();
  var ctx = helpers.createAppContext({ Audio: helpers.createAudioStub, storage: storage });
  var CM = helpers.loadModules(['player.js'], ctx);
  CM.Player.init();
  CM.Player.setKeepPitch(false);
  CM.Player.setCrossfade(3);

  // 用同一份 localStorage 重新加载模块，模拟刷新页面
  var ctx2 = helpers.createAppContext({ Audio: helpers.createAudioStub, storage: storage });
  var CM2 = helpers.loadModules(['player.js'], ctx2);
  CM2.Player.init();
  assert.strictEqual(CM2.Player.getKeepPitch(), false);
  assert.strictEqual(CM2.Player.getCrossfade(), 3);
});

/* ---------- AB 段循环 ---------- */

test('AB 循环：两端设定后才生效', function () {
  var s = setup();
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, false);
  assert.strictEqual(s.P.getAb().on, false);

  assert.strictEqual(s.P.setAb(10, 20), true);
  assert.deepStrictEqual(helpers.plain(s.P.getAb()), { a: 10, b: 20, on: true });
});

test('AB 循环：B 早于 A 时作废，不会产生死循环', function () {
  var s = setup();
  assert.strictEqual(s.P.setAb(30, 10), false);
  assert.strictEqual(s.P.getAb().on, false);
  assert.strictEqual(s.P.getAb().b, null);
});

test('AB 循环：按当前播放位置设点，B 必须明显晚于 A', function () {
  var s = setup();
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, false);
  var el = s.audio[A1];
  el.duration = 120;

  el.currentTime = 12;
  assert.strictEqual(s.P.setAbPoint('a'), true);
  assert.strictEqual(s.P.getAb().a, 12);

  el.currentTime = 12.1;
  assert.strictEqual(s.P.setAbPoint('b'), false, 'B 与 A 太近应被拒绝');

  el.currentTime = 40;
  assert.strictEqual(s.P.setAbPoint('b'), true);
  assert.strictEqual(s.P.getAb().on, true);
});

test('AB 循环：播放越过 B 自动回跳 A，拖到 A 之前也回到 A', function () {
  var s = setup();
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, true);
  var el = s.audio[A1];
  el.duration = 120;
  s.P.setAb(10, 30);

  el.currentTime = 31;
  el._emit('timeupdate');
  assert.strictEqual(el.currentTime, 10);

  el.currentTime = 5;
  el._emit('timeupdate');
  assert.strictEqual(el.currentTime, 10);
});

test('AB 循环：清除后不再回跳', function () {
  var s = setup();
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, true);
  var el = s.audio[A1];
  el.duration = 120;
  s.P.setAb(10, 30);
  s.P.clearAb();
  assert.strictEqual(s.P.getAb().on, false);
  el.currentTime = 31;
  el._emit('timeupdate');
  assert.strictEqual(el.currentTime, 31);
});

/* ---------- 交叉淡入淡出 ---------- */

test('交叉：时长可调并钳制在 0–8 秒', function () {
  var s = setup();
  assert.strictEqual(s.P.getCrossfade(), 0);
  assert.strictEqual(s.P.setCrossfade(3), 3);
  assert.strictEqual(s.P.setCrossfade(99), 8);
  assert.strictEqual(s.P.setCrossfade(-1), 0);
  assert.strictEqual(s.P.setCrossfade('abc'), 0);
});

test('交叉：播到接近结尾时在另一通道淡入下一首', function () {
  var s = setup();
  s.P.setCrossfade(4);
  s.P.setPlaylist([remote('a'), remote('b')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  assert.strictEqual(first.src, 'https://x/a.mp3');

  s.clock.t = 1000;
  drainFrames(s);
  assert.strictEqual(first.volume, 0.8, '首曲应先完成淡入');

  first.duration = 240;
  first.currentTime = 236;          // 距结尾 4 秒 = 交叉窗口
  first._emit('timeupdate');

  assert.strictEqual(s.P.getIndex(), 1, '交叉应先切换当前曲目');
  assert.strictEqual(s.P.isCrossfading(), true);
  var second = s.audio[B2];
  assert.strictEqual(second.src, 'https://x/b.mp3', '第二首应在另一通道上淡入');
  assert.strictEqual(second.paused, false);
  assert.strictEqual(second.volume, 0, '新曲从 0 起淡入');

  // 推进动画帧：旧曲音量下降、新曲音量上升
  var oldLast = first.volume, newLast = second.volume;
  for (var i = 1; i <= 8; i++) {
    s.clock.t = 1000 + i * 250;
    drainFrames(s);
    oldLast = first.volume; newLast = second.volume;
  }
  assert.ok(oldLast < 0.8, '旧曲音量应下降，实际 ' + oldLast);
  assert.ok(newLast > 0, '新曲音量应上升，实际 ' + newLast);
});

test('交叉：交叉窗口过后旧通道被暂停', function () {
  var s = setup();
  s.P.setCrossfade(2);
  s.P.setPlaylist([remote('a'), remote('b')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  first.duration = 200;
  first.currentTime = 199;
  first._emit('timeupdate');
  assert.strictEqual(first.paused, false);

  // 定时器在交叉结束 +80ms 后暂停旧通道
  return new Promise(function (resolve) {
    setTimeout(function () {
      assert.strictEqual(first.paused, true);
      assert.strictEqual(s.P.isCrossfading(), false);
      resolve();
    }, 2200);
  });
});

test('交叉：关闭时不触发，接近结尾照常播完', function () {
  var s = setup();
  s.P.setPlaylist([remote('a'), remote('b')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  first.duration = 200;
  first.currentTime = 199.9;
  first._emit('timeupdate');
  assert.strictEqual(s.P.isCrossfading(), false);
  assert.strictEqual(s.P.getIndex(), 0);
});

test('交叉：手动切歌即时切换，不做交叉', function () {
  var s = setup();
  s.P.setCrossfade(6);
  s.P.setPlaylist([remote('a'), remote('b')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  first.duration = 240;
  first.currentTime = 120;          // 远离结尾

  s.P.next();
  assert.strictEqual(s.P.getIndex(), 1);
  assert.strictEqual(s.P.isCrossfading(), false, '手动切歌不应进入交叉');
  // 旧通道按 160ms 淡出后暂停（防爆音），并非立即停 —— 等它走完再断言
  return new Promise(function (resolve) {
    setTimeout(function () {
      assert.strictEqual(first.paused, true, '淡出结束后旧通道应暂停');
      resolve();
    }, 260);
  });
});

test('交叉：AB 循环 / 单曲循环 / 播完停止时不交叉', function () {
  var s = setup();
  s.P.setCrossfade(4);
  s.P.setPlaylist([remote('a'), remote('b')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  first.duration = 240;
  first.currentTime = 237;

  s.P.setAb(0, 100);
  first._emit('timeupdate');
  assert.strictEqual(s.P.isCrossfading(), false, 'AB 循环时不应交叉');
  s.P.clearAb();

  s.P.setRepeat('one');
  first._emit('timeupdate');
  assert.strictEqual(s.P.isCrossfading(), false, '单曲循环时不应交叉');
  s.P.setRepeat('off');

  s.P.setStopAfterCurrent(true);
  first._emit('timeupdate');
  assert.strictEqual(s.P.isCrossfading(), false, '播完停止时不应交叉');
});

test('交叉：列表最后一首（无下一首）不交叉', function () {
  var s = setup();
  s.P.setCrossfade(4);
  s.P.setPlaylist([remote('a')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  first.duration = 240;
  first.currentTime = 237;
  first._emit('timeupdate');
  assert.strictEqual(s.P.isCrossfading(), false);
});

test('交叉：同池轮换，可分析曲目在 A1/A2 之间交替', function () {
  var s = setup();
  s.P.setCrossfade(3);
  s.P.setPlaylist([local('a'), local('b')]);
  s.P.loadIndex(0, true);
  assert.strictEqual(s.audio[A1].src.indexOf('blob:'), 0);

  var first = s.audio[A1];
  first.duration = 200;
  first.currentTime = 198;
  first._emit('timeupdate');
  assert.strictEqual(s.audio[A2].src.indexOf('blob:'), 0, '第二首应落在另一可分析通道');
  assert.strictEqual(s.P.isCrossfading(), true);
});

/* ---------- 响度均衡 ---------- */

test('响度均衡：默认关闭，可开启', function () {
  var s = setup();
  assert.strictEqual(s.P.getLoudness(), false);
  assert.strictEqual(s.P.setLoudness(true), true);
  assert.strictEqual(s.P.getLoudness(), true);
});

test('响度均衡：用 RMS 估计给出补偿增益，且限制在 0.5–2 倍', function () {
  var ctx = helpers.createAudioContextStub();
  var s = setup({ audioCtx: ctx });
  s.P.setLoudness(true);
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, true);
  var el = s.audio[A1];
  el.duration = 200;
  el.currentTime = 10;
  s.clock.t = 1000;
  el._emit('timeupdate');

  var g = s.P.getLoudnessGain();
  assert.ok(g >= 0.5 && g <= 2, '增益越界：' + g);
  assert.notStrictEqual(g, 1, 'RMS 明显偏低时应给出补偿');
});

test('响度均衡：安静段落不参与估计（避免间奏处狂加增益）', function () {
  var ctx = helpers.createAudioContextStub({ silence: true });
  var s = setup({ audioCtx: ctx });
  s.P.setLoudness(true);
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, true);
  var el = s.audio[A1];
  el.duration = 200;
  el.currentTime = 10;
  s.clock.t = 1000;
  el._emit('timeupdate');
  assert.strictEqual(s.P.getLoudnessGain(), 1, '静音时不应调整增益');
});

test('响度均衡：关闭时不调整增益', function () {
  var ctx = helpers.createAudioContextStub();
  var s = setup({ audioCtx: ctx });
  s.P.setPlaylist([local('a')]);
  s.P.loadIndex(0, true);
  var el = s.audio[A1];
  el.duration = 200;
  el.currentTime = 10;
  s.clock.t = 1000;
  el._emit('timeupdate');
  assert.strictEqual(s.P.getLoudnessGain(), 1);
});

test('响度均衡：跨域音频（直连通道）不参与补偿', function () {
  var ctx = helpers.createAudioContextStub();
  var s = setup({ audioCtx: ctx });
  s.P.setLoudness(true);
  s.P.setPlaylist([remote('a')]);
  s.P.loadIndex(0, true);
  var el = s.audio[B1];
  el.duration = 200;
  el.currentTime = 10;
  s.clock.t = 1000;
  el._emit('timeupdate');
  assert.strictEqual(s.P.getLoudnessGain(), 1);
});

/* ---------- 通道选择与既有行为 ---------- */

test('通道：分析能力决定落池，且批次可以轮换', function () {
  var s = setup();
  assert.strictEqual(s.P.isAnalysable(local('a')), true);
  assert.strictEqual(s.P.isAnalysable(remote('a')), false);
  assert.strictEqual(s.P.isAnalysable({ id: 'c', url: '/api/audio/x' }), true);   // 云端同源
  assert.strictEqual(s.P.isAnalysable({ id: 'p', url: '/api/proxy?u=x' }), true); // 代理同源
  assert.strictEqual(s.P.isAnalysable(null), false);
});

test('倍速：同步到全部通道（交叉时两个通道都要用）', function () {
  var s = setup();
  s.P.setPlaylist([remote('a')]);
  s.P.loadIndex(0, false);
  s.P.setRate(1.5);
  s.audio.forEach(function (el, i) {
    assert.strictEqual(el.playbackRate, 1.5, '通道 ' + i + ' 未同步倍速');
  });
});

test('暂停会停掉全部通道（交叉中可能有两个在响）', function () {
  var s = setup();
  s.P.setCrossfade(3);
  s.P.setPlaylist([remote('a'), remote('b')]);
  s.P.loadIndex(0, true);
  var first = s.audio[B1];
  first.duration = 200;
  first.currentTime = 198;
  first._emit('timeupdate');
  assert.strictEqual(s.P.isCrossfading(), true);

  s.P.pause();
  assert.strictEqual(s.P.isCrossfading(), false);
  s.audio.forEach(function (el, i) {
    assert.strictEqual(el.paused, true, '通道 ' + i + ' 未被暂停');
  });
});

test('队列批量入队：queuePushMany 保持顺序并忽略空项', function () {
  var s = setup();
  s.P.setPlaylist([remote('a')]);
  s.P.queuePushMany([remote('b'), null, remote('c')]);
  assert.deepStrictEqual(helpers.plain(s.P.getQueue().map(function (t) { return t.id; })), ['a', 'b', 'c']);
});
