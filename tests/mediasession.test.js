/* tests/mediasession.test.js — 系统媒体控制（Media Session API）
 * 校验锁屏 / 通知栏 / 耳机线控所需的元数据与动作回调是否正确接线。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function setup(opts) {
  opts = opts || {};
  var instances = [];
  function FakeAudio() {
    var a = helpers.createAudioStub();
    instances.push(a);
    return a;
  }
  var ms = helpers.createMediaSessionStub();
  var loadOpts = { Audio: FakeAudio };
  if (opts.noSupport !== true) {
    loadOpts.navigator = { mediaSession: ms };
    loadOpts.MediaMetadata = helpers.createMediaMetadataStub();
  }
  var cm = helpers.loadCM(['player.js'], loadOpts);
  var P = cm.Player;
  // instances[0] = audioLocal，instances[1] = audioRemote（远程曲使用）
  instances[1].duration = 240;
  P.init();
  return { P: P, ms: ms, audio: instances[1] };
}

function tracks(ids) {
  return ids.map(function (id) { return { id: id, title: '曲目 ' + id, artist: '歌手 ' + id, album: '专辑', url: 'https://x/' + id + '.mp3' }; });
}

test('init: 注册全部媒体动作回调', function () {
  var s = setup();
  var actions = Object.keys(s.ms._handlers).sort();
  assert.deepStrictEqual(helpers.plain(actions), [
    'nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto', 'stop'
  ]);
});

test('loadIndex: 写入系统媒体元数据（歌名 / 歌手 / 专辑）', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  assert.ok(s.ms.metadata);
  assert.strictEqual(s.ms.metadata.title, '曲目 a');
  assert.strictEqual(s.ms.metadata.artist, '歌手 a');
  assert.strictEqual(s.ms.metadata.album, '专辑');
  assert.deepStrictEqual(helpers.plain(s.ms.metadata.artwork), []);
});

test('loadIndex: 有封面时作为 artwork 传入', function () {
  var s = setup();
  s.P.setPlaylist([{ id: 'a', title: 'A', artist: 'B', cover: 'https://c/a.jpg', url: 'https://x/a.mp3' }]);
  s.P.loadIndex(0, false);
  assert.strictEqual(s.ms.metadata.artwork.length, 1);
  assert.strictEqual(s.ms.metadata.artwork[0].src, 'https://c/a.jpg');
});

test('loadIndex: 缺失字段回退为默认文案', function () {
  var s = setup();
  s.P.setPlaylist([{ id: 'a', url: 'https://x/a.mp3' }]);
  s.P.loadIndex(0, false);
  assert.strictEqual(s.ms.metadata.title, '未知标题');
  assert.strictEqual(s.ms.metadata.artist, '未知艺术家');
  assert.strictEqual(s.ms.metadata.album, '珊瑚音乐');
});

test('loadIndex: 同步系统进度条（时长 / 速率 / 位置）', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  assert.ok(s.ms.positionState);
  assert.strictEqual(s.ms.positionState.duration, 240);
  assert.strictEqual(s.ms.positionState.position, 0);
  assert.strictEqual(s.ms.positionState.playbackRate, 1);
});

test('播放 / 暂停时同步系统播放状态', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.P.play();
  assert.strictEqual(s.ms.playbackState, 'playing');
  s.P.pause();
  assert.strictEqual(s.ms.playbackState, 'paused');
});

test('媒体键：下一首 / 上一首切换曲目', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a', 'b', 'c']));
  s.P.loadIndex(0, false);
  s.ms._invoke('nexttrack');
  assert.strictEqual(s.P.getIndex(), 1);
  assert.strictEqual(s.ms.metadata.title, '曲目 b');
  s.ms._invoke('previoustrack');
  assert.strictEqual(s.P.getIndex(), 0);
  assert.strictEqual(s.ms.metadata.title, '曲目 a');
});

test('媒体键：播放 / 暂停', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.P.pause();
  assert.strictEqual(s.ms.playbackState, 'paused');
  s.ms._invoke('play');
  assert.strictEqual(s.ms.playbackState, 'playing');
  s.ms._invoke('pause');
  assert.strictEqual(s.ms.playbackState, 'paused');
});

test('媒体键：停止会暂停并把系统状态置为 none', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, true);
  s.ms._invoke('stop');
  assert.strictEqual(s.ms.playbackState, 'none');
  assert.strictEqual(s.audio.paused, true);
});

test('媒体键：seekto 定位到指定秒数', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.ms._invoke('seekto', { seekTime: 60 });
  assert.strictEqual(s.audio.currentTime, 60);
  assert.strictEqual(s.ms.positionState.position, 60);
});

test('媒体键：seekto 越界时被钳制在时长内', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.ms._invoke('seekto', { seekTime: 9999 });
  assert.strictEqual(s.audio.currentTime, 240);
});

test('媒体键：快进 / 快退按给定步长移动，缺省 10 秒', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.ms._invoke('seekforward', { seekOffset: 30 });
  assert.strictEqual(s.audio.currentTime, 30);
  s.ms._invoke('seekbackward', { seekOffset: 30 });
  assert.strictEqual(s.audio.currentTime, 0);
  s.ms._invoke('seekforward', {});
  assert.strictEqual(s.audio.currentTime, 10);
});

test('媒体键：seekbackward 不会越过 0 秒', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.ms._invoke('seekbackward', { seekOffset: 100 });
  assert.strictEqual(s.audio.currentTime, 0);
});

test('切换倍速会同步系统进度条速率', function () {
  var s = setup();
  s.P.setPlaylist(tracks(['a']));
  s.P.loadIndex(0, false);
  s.P.setRate(1.5);
  assert.strictEqual(s.ms.positionState.playbackRate, 1.5);
});

test('环境不支持 Media Session 时静默降级，不影响播放', function () {
  var s = setup({ noSupport: true });
  s.P.setPlaylist(tracks(['a']));
  assert.doesNotThrow(function () {
    s.P.loadIndex(0, true);
    s.P.play();
    s.P.pause();
    s.P.next();
    s.P.seekTo(10);
    s.P.setRate(2);
  });
  assert.strictEqual(s.P.getIndex(), 0);
});
