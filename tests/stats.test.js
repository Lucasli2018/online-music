/* tests/stats.test.js — 播放统计（次数 / 最近播放时间 / 持久化）
 * 「最近」「最常播」两个虚拟歌单的数据源。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function setup(store) {
  var instances = [];
  function FakeAudio() {
    var a = helpers.createAudioStub();
    instances.push(a);
    return a;
  }
  var cm = helpers.loadCM(['player.js'], { Audio: FakeAudio, storage: store });
  cm.Player.init();
  return cm.Player;
}

function tracks(ids) {
  return ids.map(function (id) { return { id: id, title: '曲目 ' + id, url: 'https://x/' + id + '.mp3' }; });
}

test('初始状态没有任何播放统计', function () {
  var P = setup();
  assert.deepStrictEqual(helpers.plain(P.getStats()), {});
  assert.strictEqual(P.getStat('a'), null);
});

test('开始播放（autoplay）时计一次', function () {
  var P = setup();
  P.setPlaylist(tracks(['a', 'b']));
  P.loadIndex(0, true);
  assert.strictEqual(P.getStat('a').c, 1);
  assert.strictEqual(P.getStat('b'), null);
});

test('同一首歌反复播放累加次数并刷新最近播放时间', function () {
  var P = setup();
  P.setPlaylist(tracks(['a']));
  P.loadIndex(0, true);
  var first = P.getStat('a').at;
  P.loadIndex(0, true);
  P.loadIndex(0, true);
  assert.strictEqual(P.getStat('a').c, 3);
  assert.ok(P.getStat('a').at >= first);
});

test('仅预载不播放（autoplay=false）不计入统计', function () {
  var P = setup();
  P.setPlaylist(tracks(['a']));
  P.loadIndex(0, false);
  assert.deepStrictEqual(helpers.plain(P.getStats()), {});
});

test('切歌（next）与插队后的播放都会计入各自曲目', function () {
  var P = setup();
  P.setPlaylist(tracks(['a', 'b', 'c']));
  P.loadIndex(0, true);
  P.next();
  assert.strictEqual(P.getStat('a').c, 1);
  assert.strictEqual(P.getStat('b').c, 1);
  // 插队只是排队（不立即播放），播放到它时才计数
  P.queueInsertNext({ id: 'x', title: 'X', url: 'https://x/x.mp3' });
  assert.strictEqual(P.getStat('x'), null);
  P.next();
  assert.strictEqual(P.getTrack().id, 'x');
  assert.strictEqual(P.getStat('x').c, 1);
});

test('played 事件带出曲目 id / 次数 / 时间', function () {
  var P = setup();
  var seen = [];
  P.on('played', function (id, count, at) { seen.push([id, count, typeof at]); });
  P.setPlaylist(tracks(['a']));
  P.loadIndex(0, true);
  P.loadIndex(0, true);
  assert.deepStrictEqual(helpers.plain(seen), [['a', 1, 'number'], ['a', 2, 'number']]);
});

test('clearStats 清空全部统计', function () {
  var P = setup();
  P.setPlaylist(tracks(['a']));
  P.loadIndex(0, true);
  P.clearStats();
  assert.deepStrictEqual(helpers.plain(P.getStats()), {});
});

test('移除歌曲时其统计一并清理', function () {
  var P = setup();
  P.setPlaylist(tracks(['a', 'b']));
  P.loadIndex(0, true);
  P.next();
  P.clearProgress('a');
  assert.strictEqual(P.getStat('a'), null);
  assert.strictEqual(P.getStat('b').c, 1);
});

test('统计跨会话持久化', function () {
  var store = helpers.createStorage();
  var Pa = setup(store);
  Pa.setPlaylist(tracks(['a']));
  Pa.loadIndex(0, true);
  Pa.loadIndex(0, true);

  var Pb = setup(store);
  assert.strictEqual(Pb.getStat('a').c, 2);
});

test('损坏的本地统计数据不会导致崩溃', function () {
  var store = helpers.createStorage();
  store.setItem('cm-stats', '这不是 JSON');
  var P = setup(store);
  assert.deepStrictEqual(helpers.plain(P.getStats()), {});
  P.setPlaylist(tracks(['a']));
  P.loadIndex(0, true);
  assert.strictEqual(P.getStat('a').c, 1);
});
