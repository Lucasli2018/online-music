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
  var rate = 1;                 // 倍速
  var targetVolume = 0.8;       // 目标音量（淡入淡出基准）
  var stopAfterCurrent = false; // 睡眠定时：本曲播完停止

  var urlCache = {};    // 本地歌 objectURL 缓存
  var progress = {};    // 每首歌播放进度（trackId -> 秒），持久化
  var handlers = {};

  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }
  function emit(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    (handlers[name] || []).forEach(function (fn) { fn.apply(null, args); });
  }

  var eqFilters = null;
  function ensureAudioGraph() {
    if (audioCtx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    srcLocal = audioCtx.createMediaElementSource(audioLocal);
    // EQ 三段：低频 shelf / 中频 peaking / 高频 shelf（仅作用于本地歌链路）
    var fLow = audioCtx.createBiquadFilter(); fLow.type = 'lowshelf'; fLow.frequency.value = 200;
    var fMid = audioCtx.createBiquadFilter(); fMid.type = 'peaking'; fMid.frequency.value = 1000; fMid.Q.value = 1;
    var fHigh = audioCtx.createBiquadFilter(); fHigh.type = 'highshelf'; fHigh.frequency.value = 3200;
    eqFilters = [fLow, fMid, fHigh];
    srcLocal.connect(fLow); fLow.connect(fMid); fMid.connect(fHigh); fHigh.connect(analyser); analyser.connect(audioCtx.destination);
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
      if (el === active && playlist[index]) saveProgress(playlist[index], el.currentTime);
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

  function loadProgress() {
    try { return JSON.parse(localStorage.getItem('cm-progress') || '{}') || {}; }
    catch (e) { return {}; }
  }
  var lastSave = 0;
  function saveProgress(track, time) {
    if (!track) return;
    var now = Date.now();
    if (now - lastSave < 1500) return; // 1.5s 节流，减少写入
    lastSave = now;
    progress[track.id] = time;
    try { localStorage.setItem('cm-progress', JSON.stringify(progress)); } catch (e) {}
  }
  function applySavedProgress(track) {
    var t = progress[track.id];
    if (!t || t <= 3) return; // 跳过开头 3 秒，避免无意义续播
    var seek = function () {
      if (isFinite(active.duration) && t < active.duration - 2) {
        try { active.currentTime = t; } catch (e) {}
      }
    };
    if (active.readyState >= 1) seek();
    else active.addEventListener('loadedmetadata', seek, { once: true });
  }
  function clearProgress(id) {
    if (!id) return;
    delete progress[id];
    try { localStorage.setItem('cm-progress', JSON.stringify(progress)); } catch (e) {}
  }

  function handleEnded() {
    if (repeat === 'one') { active.currentTime = 0; active.play(); return; }
    if (stopAfterCurrent) { stopAfterCurrent = false; emit('state', false); emit('playlistEnd'); return; }
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
    var prev = active;
    if (prev && !prev.paused) {
      fadeTo(prev, 0, 160);                                  // 旧曲淡出（防爆音）
      setTimeout(function () { try { prev.pause(); } catch (e) {} }, 180);
    } else if (prev) {
      prev.pause();
    }
    index = i;
    var track = playlist[i];
    var isLocal = track.source === 'local';
    active = isLocal ? audioLocal : audioRemote;
    (isLocal ? audioRemote : audioLocal).pause();
    active.volume = 0;                                        // 准备淡入
    active.playbackRate = rate; active.defaultPlaybackRate = rate;
    active.src = getUrl(track);
    active.load();
    applySavedProgress(track);
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
    if (active.volume < targetVolume - 0.001) { active.volume = 0; fadeTo(active, targetVolume, 200); }
    if (CM && CM.Visualizer) CM.Visualizer.start();
  }
  function pause() { if (active) active.pause(); if (CM && CM.Visualizer) CM.Visualizer.stop(); }
  function toggle() { if (!active) { play(); return; } if (active.paused) play(); else pause(); }

  function seekRatio(r) { if (active && isFinite(active.duration)) active.currentTime = r * active.duration; }
  function seekTo(sec) {
    if (active && isFinite(active.duration)) active.currentTime = Math.max(0, Math.min(sec, active.duration));
  }
  function fadeTo(el, target, ms) {
    if (!el) return;
    var start = el.volume, t0 = (global.performance ? performance.now() : Date.now());
    function step(now) {
      var p = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
      el.volume = start + (target - start) * p;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    targetVolume = v;
    audioLocal.volume = v; audioRemote.volume = v;
  }

  function init() {
    progress = loadProgress();
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
    seekTo: seekTo,
    setVolume: setVolume,
    setRepeat: function (m) { repeat = m; },
    getRepeat: function () { return repeat; },
    setShuffle: function (s) { shuffle = s; },
    getShuffle: function () { return shuffle; },
    getIndex: function () { return index; },
    getCurrentTime: function () { return (active && isFinite(active.currentTime)) ? active.currentTime : 0; },
    setIndex: function (i) { index = i; },
    getTrack: function () { return playlist[index]; },
    revokeUrl: revokeUrl,
    clearProgress: clearProgress,
    queuePush: function (track) { if (track) playlist.push(track); },
    queueInsertNext: function (track) {
      if (!track) return;
      if (index < 0) { playlist.unshift(track); loadIndex(0, true); }
      else playlist.splice(index + 1, 0, track);
    },
    getQueue: function () { return playlist; },
    queueRemove: function (i) {
      if (i < 0 || i >= playlist.length) return;
      playlist.splice(i, 1);
      if (i < index) index--;
      else if (i === index) {
        if (playlist.length) loadIndex(Math.min(i, playlist.length - 1), false);
        else { index = -1; if (CM.Visualizer && CM.Visualizer.stop) CM.Visualizer.stop(); emit('playlistEnd'); }
      }
    },
    queueMove: function (from, to) {
      if (from < 0 || to < 0 || from >= playlist.length || to >= playlist.length) return;
      if (from === to) return;
      var moved = playlist.splice(from, 1)[0];
      playlist.splice(to, 0, moved);
      if (index === from) index = to;
      else if (from < index && index <= to) index++;
      else if (to <= index && index < from) index--;
    },
    setEQ: function (gains) {
      if (!eqFilters || !gains) return;
      eqFilters[0].gain.value = gains[0] || 0;
      eqFilters[1].gain.value = gains[1] || 0;
      eqFilters[2].gain.value = gains[2] || 0;
    },
    setRate: function (r) { rate = r; if (active) { active.playbackRate = r; active.defaultPlaybackRate = r; } },
    getRate: function () { return rate; },
    setStopAfterCurrent: function (v) { stopAfterCurrent = !!v; }
  };
})(window);
