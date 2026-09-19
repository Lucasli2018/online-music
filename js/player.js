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
  var stats = {};       // 每首歌播放统计（trackId -> { c: 次数, at: 最近播放时间戳 }），持久化
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

  // 能否接入 Web Audio 分析链路（决定可视化有没有真频谱、EQ 是否生效）：
  //   · 本地 blob：同源
  //   · 云端 R2（/api/audio/...）与在线代理（/api/proxy?...）：站内相对路径，同源
  // 跨域远程音频若接入 MediaElementSource 会被浏览器静音，只能用独立元素直接播放。
  function isAnalysable(track) {
    if (!track) return false;
    if (track.source === 'local') return true;
    var u = track.url || '';
    if (!u) return false;
    if (u.charAt(0) === '/') return true;
    if (u.indexOf('blob:') === 0) return true;
    try {
      var base = (global.location && global.location.href) || '';
      if (!base) return false;
      return new URL(u, base).origin === new URL(base).origin;
    } catch (e) { return false; }
  }

  function bind(el) {
    el.addEventListener('timeupdate', function () {
      if (el === active && playlist[index]) saveProgress(playlist[index], el.currentTime);
      if (el === active) updatePositionState(false);
      emit('time', el.currentTime, el.duration || 0);
    });
    el.addEventListener('loadedmetadata', function () {
      emit('meta', el.duration || 0);
    });
    el.addEventListener('play', function () {
      if (el === active) setPlaybackState('playing');
      emit('state', true);
    });
    el.addEventListener('pause', function () {
      if (el === active) setPlaybackState('paused');
      emit('state', false);
    });
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
    delete stats[id]; // 移除歌曲时一并清理其播放统计，避免残留
    try { localStorage.setItem('cm-progress', JSON.stringify(progress)); } catch (e) {}
    saveStats();
  }

  /* ---------- 播放统计（次数 / 最近播放时间）---------- */
  function loadStats() {
    try { return JSON.parse(localStorage.getItem('cm-stats') || '{}') || {}; } catch (e) { return {}; }
  }
  function saveStats() {
    try { localStorage.setItem('cm-stats', JSON.stringify(stats)); } catch (e) {}
  }
  // 真正开始播放一首歌时调用（点播 / 切歌 / 单曲循环重播），驱动「最近播放」「最常播」
  function markPlayed(track) {
    if (!track || !track.id) return;
    var s = stats[track.id] || { c: 0, at: 0 };
    s.c += 1;
    s.at = Date.now();
    stats[track.id] = s;
    saveStats();
    emit('played', track.id, s.c, s.at);
  }

  function handleEnded() {
    if (repeat === 'one') { markPlayed(playlist[index]); active.currentTime = 0; active.play(); return; }
    if (stopAfterCurrent) {
      stopAfterCurrent = false;
      setPlaybackState('paused');
      emit('state', false); emit('playlistEnd');
      return;
    }
    var ni = nextIndex(false);
    if (ni === -1) { setPlaybackState('none'); emit('playlistEnd'); return; }
    loadIndex(ni, true);
  }

  // 具名函数：既供导出，也供系统媒体键（上一首 / 下一首）复用
  function next() { var ni = nextIndex(true); if (ni >= 0) loadIndex(ni, true); }
  function prev() { var pi = prevIndex(); if (pi >= 0) loadIndex(pi, true); }

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
    var isLocal = isAnalysable(track);   // 本地 / 云端 / 代理音频都同源，可接入分析链
    active = isLocal ? audioLocal : audioRemote;
    (isLocal ? audioRemote : audioLocal).pause();
    active.volume = 0;                                        // 准备淡入
    active.playbackRate = rate; active.defaultPlaybackRate = rate;
    active.src = getUrl(track);
    active.load();
    applySavedProgress(track);
    emit('track', track, i);
    emit('cover', track.cover || null);
    setMediaMetadata(track);
    updatePositionState(true);
    if (CM && CM.Visualizer) CM.Visualizer.setAnalyser(isLocal && analyser ? analyser : null);
    if (autoplay) { markPlayed(track); play(); }
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
    setPlaybackState('playing');
  }
  function pause() {
    if (active) active.pause();
    if (CM && CM.Visualizer) CM.Visualizer.stop();
    setPlaybackState('paused');
  }
  function toggle() { if (!active) { play(); return; } if (active.paused) play(); else pause(); }

  function seekRatio(r) { if (active && isFinite(active.duration)) active.currentTime = r * active.duration; }
  function seekTo(sec) {
    if (active && isFinite(active.duration)) {
      active.currentTime = Math.max(0, Math.min(sec, active.duration));
      updatePositionState(true);
    }
  }
  function fadeTo(el, target, ms) {
    if (!el) return;
    var start = el.volume;
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    function step(now) {
      // p 必须双向钳制：rAF 时间戳可能早于起点（同帧内注册），
      // 只做 Math.min(1, x) 会让 p 变负，进而算出负音量 → 赋值抛 IndexSizeError，
      // 淡入被中断、音量停在 0（表现为「点了播放没声音」）。
      var p = ms <= 0 ? 1 : (now - t0) / ms;
      if (!isFinite(p)) p = 1; // 时间戳异常（NaN/Infinity）时直接落到目标值，避免写入非法音量
      p = Math.max(0, Math.min(1, p));
      el.volume = Math.max(0, Math.min(1, start + (target - start) * p));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function setVolume(v) {
    v = Math.max(0, Math.min(1, v));
    targetVolume = v;
    audioLocal.volume = v; audioRemote.volume = v;
  }

  /* ---------- 系统媒体控制（Media Session API）----------
   * 让锁屏 / 通知栏 / 蓝牙耳机线控能显示歌曲信息并控制播放。
   * 环境不支持（无 navigator.mediaSession）时静默降级，不影响播放。
   */
  function msApi() { return (global.navigator && global.navigator.mediaSession) || null; }

  function setPlaybackState(state) {
    var ms = msApi();
    if (!ms) return;
    try { ms.playbackState = state; } catch (e) {}
  }

  function setMediaMetadata(track) {
    var ms = msApi();
    if (!ms || !track || !global.MediaMetadata) return;
    try {
      var artwork = [];
      if (track.cover) artwork.push({ src: track.cover, sizes: '512x512' });
      ms.metadata = new global.MediaMetadata({
        title: track.title || '未知标题',
        artist: track.artist || '未知艺术家',
        album: track.album || '珊瑚音乐',
        artwork: artwork
      });
    } catch (e) {}
  }

  var lastPosSync = 0;
  function updatePositionState(force) {
    var ms = msApi();
    if (!ms || !ms.setPositionState || !active) return;
    var dur = active.duration;
    if (!isFinite(dur) || dur <= 0) return;
    var now = Date.now();
    if (!force && now - lastPosSync < 1000) return; // 系统进度条每秒同步一次即可
    lastPosSync = now;
    try {
      ms.setPositionState({
        duration: dur,
        playbackRate: active.playbackRate || 1,
        position: Math.max(0, Math.min(active.currentTime || 0, dur))
      });
    } catch (e) {}
  }

  function seekBy(delta) { if (active) seekTo((active.currentTime || 0) + delta); }

  function setupMediaSession() {
    var ms = msApi();
    if (!ms || !ms.setActionHandler) return;
    var set = function (action, fn) {
      try { ms.setActionHandler(action, fn); } catch (e) {}
    };
    set('play', function () { play(); });
    set('pause', function () { pause(); });
    set('stop', function () { pause(); setPlaybackState('none'); });
    set('previoustrack', function () { prev(); });
    set('nexttrack', function () { next(); });
    set('seekbackward', function (d) { seekBy(-((d && d.seekOffset) || 10)); });
    set('seekforward', function (d) { seekBy((d && d.seekOffset) || 10); });
    set('seekto', function (d) { if (d && typeof d.seekTime === 'number') seekTo(d.seekTime); });
  }

  function init() {
    progress = loadProgress();
    stats = loadStats();
    bind(audioLocal); bind(audioRemote);
    audioLocal.volume = 0.8; audioRemote.volume = 0.8;
    setupMediaSession();
  }

  global.CM = global.CM || {};
  global.CM.Player = {
    init: init,
    on: on,
    setPlaylist: function (list) { playlist = list || []; },
    getPlaylist: function () { return playlist; },
    loadIndex: loadIndex,
    play: play, pause: pause, toggle: toggle,
    next: next,
    prev: prev,
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
    getProgress: function () { return progress; },
    setProgress: function (p) {
      progress = (p && typeof p === 'object') ? p : {};
      try { localStorage.setItem('cm-progress', JSON.stringify(progress)); } catch (e) {}
    },
    getStats: function () { return stats; },
    getStat: function (id) { return stats[id] || null; },
    clearStats: function () { stats = {}; saveStats(); },
    setStats: function (s) {
      stats = (s && typeof s === 'object') ? s : {};
      saveStats();
    },
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
        else {
          index = -1;
          if (CM.Visualizer && CM.Visualizer.stop) CM.Visualizer.stop();
          setPlaybackState('none');
          emit('playlistEnd');
        }
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
    setRate: function (r) {
      rate = r;
      if (active) { active.playbackRate = r; active.defaultPlaybackRate = r; }
      updatePositionState(true);
    },
    getRate: function () { return rate; },
    setStopAfterCurrent: function (v) { stopAfterCurrent = !!v; },
    getActiveDuration: function () { return active && isFinite(active.duration) ? active.duration : 0; }
  };
})(window);
