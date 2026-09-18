/* player.js — 播放引擎
 * 关键设计：
 *  - 本地上传的歌（同源 blob）走 Web Audio 链，可视化画真实频谱；
 *  - 远程 / 示例曲（可能跨域）用独立 audio 元素直接播放，可视化降级为装饰动画，
 *    避免跨域导致被静音。
 *  - MediaElementSource 每个 audio 元素只能创建一次，故两个元素各自建一次。
 */
(function (global) {
  'use strict';

  var audioLocal = new Audio();   // 接入 Web Audio（本地）
  var audioRemote = new Audio();  // 不接入（远程）
  var active = null;
  var audioCtx = null, analyser = null, srcLocal = null;

  var playlist = [];
  var index = -1;
  var repeat = 'off';   // off | one | all
  var shuffle = false;

  var urlCache = {};    // 本地歌 objectURL 缓存
  var handlers = {};

  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }
  function emit(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    (handlers[name] || []).forEach(function (fn) { fn.apply(null, args); });
  }

  function ensureAudioGraph() {
    if (audioCtx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(audioCtx.destination);
    srcLocal = audioCtx.createMediaElementSource(audioLocal);
    srcLocal.connect(analyser);
  }

  function getUrl(track) {
    if (track.source === 'local') {
      if (!urlCache[track.id]) urlCache[track.id] = global.URL.createObjectURL(track.file);
      return urlCache[track.id];
    }
    return track.url;
  }
  function revokeUrl(id) { if (urlCache[id]) { global.URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } }

  function bind(el) {
    el.addEventListener('timeupdate', function () {
      emit('time', el.currentTime, el.duration || 0);
    });
    el.addEventListener('loadedmetadata', function () {
      emit('meta', el.duration || 0);
    });
    el.addEventListener('play', function () { emit('state', true); });
    el.addEventListener('pause', function () { emit('state', false); });
    el.addEventListener('ended', function () { handleEnded(); });
    el.addEventListener('error', function () {
      emit('error', active ? active.title : '');
    });
  }

  function handleEnded() {
    if (repeat === 'one') { active.currentTime = 0; active.play(); return; }
    var ni = nextIndex(false);
    if (ni === -1) { emit('playlistEnd'); return; }
    loadIndex(ni, true);
  }

  function nextIndex(manual) {
    if (!playlist.length) return -1;
    if (repeat === 'one' && !manual) return index; // 单曲循环由 ended 处理
    if (shuffle) return Math.floor(Math.random() * playlist.length);
    var ni = index + 1;
    if (ni >= playlist.length) {
      if (repeat === 'all' || manual) return 0;
      return -1; // 列表结束
    }
    return ni;
  }
  function prevIndex() {
    if (!playlist.length) return -1;
    if (shuffle) return Math.floor(Math.random() * playlist.length);
    var pi = index - 1;
    if (pi < 0) pi = playlist.length - 1;
    return pi;
  }

  function loadIndex(i, autoplay) {
    if (i < 0 || i >= playlist.length) return;
    if (active) active.pause();
    index = i;
    var track = playlist[i];
    var isLocal = track.source === 'local';
    active = isLocal ? audioLocal : audioRemote;
    (isLocal ? audioRemote : audioLocal).pause();
    active.src = getUrl(track);
    active.load();
    emit('track', track, i);
    emit('cover', track.cover || null);
    if (CM && CM.Visualizer) CM.Visualizer.setAnalyser(isLocal && analyser ? analyser : null);
    if (autoplay) play();
  }

  function play() {
    if (!active) {
      if (playlist.length) { loadIndex(0, true); return; }
      return;
    }
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    var p = active.play();
    if (p && p.catch) p.catch(function (e) { emit('error', active && active.src, e); });
    if (CM && CM.Visualizer) CM.Visualizer.start();
  }
  function pause() { if (active) active.pause(); if (CM && CM.Visualizer) CM.Visualizer.stop(); }
  function toggle() { if (!active) { play(); return; } if (active.paused) play(); else pause(); }

  function seekRatio(r) { if (active && isFinite(active.duration)) active.currentTime = r * active.duration; }
  function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    audioLocal.volume = v; audioRemote.volume = v;
  }

  function init() {
    bind(audioLocal); bind(audioRemote);
    audioLocal.volume = 0.8; audioRemote.volume = 0.8;
  }

  global.CM = global.CM || {};
  global.CM.Player = {
    init: init,
    on: on,
    setPlaylist: function (list) { playlist = list || []; },
    getPlaylist: function () { return playlist; },
    loadIndex: loadIndex,
    play: play, pause: pause, toggle: toggle,
    next: function () { var ni = nextIndex(true); if (ni >= 0) loadIndex(ni, true); },
    prev: function () { var pi = prevIndex(); if (pi >= 0) loadIndex(pi, true); },
    seekRatio: seekRatio,
    setVolume: setVolume,
    setRepeat: function (m) { repeat = m; },
    getRepeat: function () { return repeat; },
    setShuffle: function (s) { shuffle = s; },
    getShuffle: function () { return shuffle; },
    getIndex: function () { return index; },
    setIndex: function (i) { index = i; },
    getTrack: function () { return playlist[index]; },
    revokeUrl: revokeUrl
  };
})(window);
