/* tests/fade.test.js — 播放淡入淡出的音量安全边界
 *
 * 回归背景：fadeTo 原先只做 Math.min(1, p)，没有下界。
 * 当 requestAnimationFrame 的时间戳略早于调用时刻（同一帧内注册回调时会发生），
 * p 会是负数 → 算出负音量 → 给 HTMLMediaElement.volume 赋值抛 IndexSizeError，
 * 淡入循环被中断、音量停在 0，用户端表现为「点了播放但没有声音」。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function setup() {
  var frames = [];
  var instances = [];
  var clock = { t: 0 };
  function FakeAudio() {
    var a = helpers.createAudioStub();
    instances.push(a);
    return a;
  }
  var cm = helpers.loadCM(['player.js'], {
    Audio: FakeAudio,
    onRaf: function (cb) { frames.push(cb); },
    performance: { now: function () { return clock.t; } }   // 受控时钟，便于精确断言淡入进度
  });
  cm.Player.init();
  return { P: cm.Player, audio: instances, frames: frames, clock: clock };
}

/* 执行当前排队的帧回调；回调内重新注册的帧留到下一次调用。
 * time 同时用于推进受控时钟，保证后续 fadeTo 取到的起点时间一致。 */
function nextFrame(s, time) {
  if (isFinite(time)) s.clock.t = time;
  var cbs = s.frames.splice(0, s.frames.length);
  cbs.forEach(function (cb) { cb(time); });
  return cbs.length;
}

function inRange(v) { return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1; }

function startPlaying(s) {
  s.P.setPlaylist([{ id: 'a', title: 'A', url: 'https://x/a.mp3' }]);
  s.P.loadIndex(0, true);          // autoplay → play() → fadeTo(audioRemote, 0.8, 200)
  return s.audio[1];               // 远程曲使用第二个音频元素
}

test('淡入已排入动画帧，且起始音量为 0', function () {
  var s = setup();
  var el = startPlaying(s);
  assert.strictEqual(el.volume, 0);
  assert.ok(s.frames.length > 0, '淡入应注册 requestAnimationFrame 回调');
});

test('时间戳早于起点（负 p）不会写出非法音量', function () {
  var s = setup();
  var el = startPlaying(s);
  nextFrame(s, -1000000);          // 极端：远早于起点
  assert.ok(inRange(el.volume), '音量越界：' + el.volume);
  assert.strictEqual(el.volume, 0, '负进度应钳制回 0，而不是变成负数');
});

test('时间戳比起点早几毫秒（真实触发场景）同样安全', function () {
  var s = setup();
  var el = startPlaying(s);
  nextFrame(s, -1.44);             // 实测中越界时的量级
  assert.ok(inRange(el.volume), '音量越界：' + el.volume);
});

test('正常推进：半程音量落在起点与目标之间', function () {
  var s = setup();
  var el = startPlaying(s);
  nextFrame(s, 100);               // 200ms 淡入的一半
  assert.ok(el.volume > 0 && el.volume < 0.8, '半程音量=' + el.volume);
});

test('超过时长后到达目标音量并停止排队', function () {
  var s = setup();
  var el = startPlaying(s);
  nextFrame(s, 500);
  assert.strictEqual(el.volume, 0.8);
  assert.strictEqual(s.frames.length, 0, '到达目标后不应继续注册动画帧');
});

test('异常时间戳（NaN）落到目标音量且不越界', function () {
  var s = setup();
  var el = startPlaying(s);
  nextFrame(s, NaN);
  assert.ok(inRange(el.volume), '音量越界：' + el.volume);
  assert.strictEqual(el.volume, 0.8);
});

test('淡出：切歌时旧曲音量递减且全程合法', function () {
  var s = setup();
  var el = startPlaying(s);        // 远程曲 → audioRemote
  nextFrame(s, 500);               // 先把当前曲音量拉到 0.8
  assert.strictEqual(el.volume, 0.8);

  // 第二首用本地曲（走 audioLocal），让旧曲淡出与新曲淡入落在不同音频元素上
  s.P.setPlaylist([
    { id: 'a', title: 'A', url: 'https://x/a.mp3' },
    { id: 'b', title: 'B', source: 'local', file: {} }
  ]);
  s.P.loadIndex(1, true);
  var last = el.volume;
  for (var i = 0; i < 6; i++) {
    nextFrame(s, 500 + (i + 1) * 20);
    assert.ok(inRange(el.volume), '第 ' + i + ' 帧音量越界：' + el.volume);
    last = el.volume;
  }
  assert.ok(last < 0.8, '切歌后旧曲音量应下降，实际 ' + last);
});
