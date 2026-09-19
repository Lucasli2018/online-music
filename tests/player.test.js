/* tests/player.test.js — 播放队列索引运算 / 音量边界 / 播放偏好
 * player.js 顶层会 new Audio()，这里用可追踪的替身接管；
 * 测试只覆盖纯索引与偏好逻辑，不触发真实播放。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function setup() {
  var instances = [];
  function FakeAudio() {
    var a = helpers.createAudioStub();
    instances.push(a);
    return a;
  }
  var cm = helpers.loadCM(['player.js'], { Audio: FakeAudio });
  return { P: cm.Player, instances: instances };
}

function tracks(ids) {
  return ids.map(function (id) { return { id: id, title: id, url: 'https://x/' + id + '.mp3' }; });
}

test('初始状态：无当前曲目、空队列、默认播放偏好', function () {
  var P = setup().P;
  assert.strictEqual(P.getIndex(), -1);
  assert.deepStrictEqual(helpers.plain(P.getQueue()), []);
  assert.strictEqual(P.getRepeat(), 'off');
  assert.strictEqual(P.getShuffle(), false);
  assert.strictEqual(P.getRate(), 1);
  assert.strictEqual(P.getTrack(), undefined);
});

test('setPlaylist: 整表替换', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b']));
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['a', 'b']);
  assert.deepStrictEqual(helpers.plain(P.getPlaylist().map(function (t) { return t.id; })), ['a', 'b']);
});

test('queuePush: 追加到队尾且保持顺序', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a']));
  P.queuePush({ id: 'b' });
  P.queuePush({ id: 'c' });
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['a', 'b', 'c']);
});

test('queueInsertNext: 队列为空时插入队首并成为当前曲目', function () {
  var P = setup().P;
  P.queueInsertNext({ id: 'a', title: 'a', url: 'https://x/a.mp3' });
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['a']);
  assert.strictEqual(P.getIndex(), 0);
  assert.strictEqual(P.getTrack().id, 'a');
});

test('queueInsertNext: 有当前曲目时插到其后（插队到下一首）', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b']));
  P.setIndex(0);
  P.queueInsertNext({ id: 'x' });
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['a', 'x', 'b']);
  assert.strictEqual(P.getIndex(), 0);
  assert.strictEqual(P.getTrack().id, 'a');
});

test('queueInsertNext: 空入参被忽略', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a']));
  P.queueInsertNext(null);
  assert.strictEqual(P.getQueue().length, 1);
});

test('queueRemove: 删除当前曲目之前的项，索引前移', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b', 'c']));
  P.setIndex(2);
  P.queueRemove(0);
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['b', 'c']);
  assert.strictEqual(P.getIndex(), 1);
  assert.strictEqual(P.getTrack().id, 'c');
});

test('queueRemove: 删除当前曲目本身，索引停在原位指向后继', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b', 'c']));
  P.setIndex(1);
  P.queueRemove(1);
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['a', 'c']);
  assert.strictEqual(P.getIndex(), 1);
  assert.strictEqual(P.getTrack().id, 'c');
});

test('queueRemove: 删除当前曲目之后的项，索引不变', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b', 'c']));
  P.setIndex(0);
  P.queueRemove(2);
  assert.strictEqual(P.getIndex(), 0);
  assert.strictEqual(P.getTrack().id, 'a');
});

test('queueRemove: 移除唯一曲目后队列清空且索引归 -1', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a']));
  P.setIndex(0);
  P.queueRemove(0);
  assert.deepStrictEqual(helpers.plain(P.getQueue()), []);
  assert.strictEqual(P.getIndex(), -1);
});

test('queueRemove: 越界索引被忽略', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a']));
  P.setIndex(0);
  P.queueRemove(5);
  P.queueRemove(-1);
  assert.strictEqual(P.getQueue().length, 1);
  assert.strictEqual(P.getIndex(), 0);
});

test('queueMove: 向后拖动时索引跟随同一首歌', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b', 'c', 'd']));
  P.setIndex(1);
  P.queueMove(0, 2);
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['b', 'c', 'a', 'd']);
  assert.strictEqual(P.getIndex(), 2);
  assert.strictEqual(P.getTrack().id, 'a');
});

test('queueMove: 向前拖动时索引跟随同一首歌', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b', 'c', 'd']));
  P.setIndex(3);
  P.queueMove(3, 0);
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['d', 'a', 'b', 'c']);
  assert.strictEqual(P.getIndex(), 0);
  assert.strictEqual(P.getTrack().id, 'd');
});

test('queueMove: 被移走的曲目本身索引同步迁移', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b', 'c']));
  P.setIndex(0);
  P.queueMove(0, 2);
  assert.strictEqual(P.getIndex(), 2);
  assert.strictEqual(P.getTrack().id, 'a');
});

test('queueMove: 原地移动与越界参数均被忽略', function () {
  var P = setup().P;
  P.setPlaylist(tracks(['a', 'b']));
  P.setIndex(0);
  P.queueMove(0, 0);
  P.queueMove(-1, 1);
  P.queueMove(0, 9);
  assert.deepStrictEqual(helpers.plain(P.getQueue().map(function (t) { return t.id; })), ['a', 'b']);
  assert.strictEqual(P.getIndex(), 0);
});

test('setVolume: 钳制在 0–1 并同步到两个音频元素', function () {
  var s = setup();
  s.P.setVolume(1.5);
  assert.strictEqual(s.instances[0].volume, 1);
  assert.strictEqual(s.instances[1].volume, 1);
  s.P.setVolume(-0.5);
  assert.strictEqual(s.instances[0].volume, 0);
  s.P.setVolume(0.35);
  assert.strictEqual(s.instances[0].volume, 0.35);
  assert.strictEqual(s.instances[1].volume, 0.35);
});

test('播放偏好：循环模式 / 随机 / 倍速', function () {
  var P = setup().P;
  P.setRepeat('all');
  assert.strictEqual(P.getRepeat(), 'all');
  P.setShuffle(true);
  assert.strictEqual(P.getShuffle(), true);
  P.setRate(1.5);
  assert.strictEqual(P.getRate(), 1.5);
});

test('setRate: 有当前曲目时同步到音频元素（含默认速率）', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  // 远程曲（无 source: 'local'）走 audioRemote，即第二个音频元素
  assert.strictEqual(s.instances[1].src, 'https://x/a.mp3');
  s.P.setRate(2);
  assert.strictEqual(s.instances[1].playbackRate, 2);
  assert.strictEqual(s.instances[1].defaultPlaybackRate, 2);
});

test('loadIndex: 本地曲走 Web Audio 链的音频元素', function () {
  var s = setup();
  s.P.setPlaylist([{ id: 'loc', title: 'loc', source: 'local', file: {} }]);
  s.P.loadIndex(0, false);
  assert.strictEqual(s.instances[0].src.indexOf('blob:test/'), 0);
});

test('loadIndex: 越界索引安全忽略', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(5, false);
  s.P.loadIndex(-1, false);
  assert.strictEqual(s.P.getIndex(), -1);
});

test('clearProgress 与 getActiveDuration 安全调用', function () {
  var P = setup().P;
  P.clearProgress('不存在');
  P.clearProgress(null);
  assert.strictEqual(P.getActiveDuration(), 0);
  assert.strictEqual(P.getCurrentTime(), 0);
});
