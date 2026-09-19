/* player.js — 播放引擎
 *
 * 通道模型（阶段 5D）：
 *   交叉淡入淡出要求两个音频元素同时发声，因此由「二元」升级为「双池四通道」：
 *     · 可分析池 A1 / A2：同源音频（本地 blob / 云端 R2 / 在线代理）→ 接入 Web Audio，
 *       获得十段 EQ、真实频谱与响度均衡；
 *     · 直连池 B1 / B2：跨域音频 → 接入 MediaElementSource 会被浏览器静音，故直连输出。
 *   MediaElementSource 对每个元素只能创建一次，所以元素与池的归属固定不变；
 *   切歌时在同一池内轮换元素，交叉才有第二个元素可用。
 *
 * 元素创建顺序固定为 A1、B1、A2、B2 —— 「首个可分析元素」与「首个直连元素」的索引稳定，
 * 测试与调试依赖这一顺序，勿调整。
 *
 * 交叉策略：仅在自动切歌（播放到接近结尾）时启用，手动切歌保持即时切换（业界惯例）。
 */
(function (global) {
  'use strict';

  /* ---------- 通道 ---------- */
  var elA1 = new Audio();   // 可分析池 · 通道 1
  var elB1 = new Audio();   // 直连池 · 通道 1
  var elA2 = new Audio();   // 可分析池 · 通道 2
  var elB2 = new Audio();   // 直连池 · 通道 2
  var chA1 = { el: elA1, analysable: true };
  var chB1 = { el: elB1, analysable: false };
  var chA2 = { el: elA2, analysable: true };
  var chB2 = { el: elB2, analysable: false };
  var CHANNELS = [chA1, chB1, chA2, chB2];
  var POOL_ANALYSABLE = [chA1, chA2];
  var POOL_DIRECT = [chB1, chB2];

  var activeCh = null;
  var active = null;
  var audioCtx = null, analyser = null, timeData = null;

  var playlist = [];
  var index = -1;
  var repeat = 'off';   // off | one | all
  var shuffle = false;
  var rate = 1;                 // 倍速
  var keepPitch = true;         // 变速不变调
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

  function perfNow() {
    return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
  }

  /* ---------- 通道选择 ---------- */
  function setActiveCh(ch) { activeCh = ch; active = ch ? ch.el : null; }
  function poolFor(track) { return isAnalysable(track) ? POOL_ANALYSABLE : POOL_DIRECT; }
  // 优先选「与当前不同的那个元素」：同一池内轮换，交叉淡入淡出才有第二个元素可用
  function pickChannel(track) {
    var pool = poolFor(track);
    for (var i = 0; i < pool.length; i++) { if (pool[i] !== activeCh) return pool[i]; }
    return pool[0];
  }

  /* ---------- 十段均衡器 ---------- */
  var EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var EQ_PRESETS = {
    flat:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    pop:       [-1, 0, 2, 4, 4, 2, 0, -1, -1, -1],
    rock:      [5, 4, 2, -1, -2, -1, 1, 3, 4, 4],
    classical: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
    vocal:     [-3, -3, -2, 0, 3, 5, 5, 3, 1, 0],
    bass:      [8, 7, 5, 3, 1, 0, -1, -2, -3, -4]
  };
  var eqGains = EQ_PRESETS.flat.slice();

  /* 旧版本只存 3 段（低 / 中 / 高），这里映射到 10 段，避免升级后用户设置被清空 */
  function normalizeEQ(gains) {
    if (!gains || typeof gains.length !== 'number') return null;
    var out = [];
    var i;
    if (gains.length === EQ_FREQS.length) {
      for (i = 0; i < gains.length; i++) {
        var v = Number(gains[i]);
        out.push(isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0);
      }
      return out;
    }
    if (gains.length === 3) {
      var lo = Number(gains[0]) || 0, mid = Number(gains[1]) || 0, hi = Number(gains[2]) || 0;
      return [lo, lo, lo, mid, mid, mid, mid, hi, hi, hi];
    }
    return null;
  }
  // 把 3 段时代的键名映射成预设名，供 UI 直接复用
  var EQ_LEGACY_PRESET_ALIAS = { low: 'bass', mid: 'vocal', high: 'pop' };

  var eqFilters = null;
  var loudnessGain = null;
  var loudness = { on: false, rms: 0, applied: 1, last: 0 };
  var LOUDNESS_REF = 0.11;   // 目标 RMS 参考值

  function ensureAudioGraph() {
    if (audioCtx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    timeData = new Uint8Array(analyser.fftSize);
    loudnessGain = audioCtx.createGain();
    loudnessGain.gain.value = 1;

    // 十段 EQ：链尾兼做响度补偿的测量点（放在补偿器之前，避免自激震荡）
    eqFilters = EQ_FREQS.map(function (f, i) {
      var node = audioCtx.createBiquadFilter();
      node.type = (i === 0) ? 'lowshelf' : (i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking');
      node.frequency.value = f;
      node.Q.value = 1;
      node.gain.value = eqGains[i] || 0;
      return node;
    });
    // 两个可分析元素都接入同一条链：交叉淡入淡出时天然混音
    var head = eqFilters[0];
    var srcA1 = audioCtx.createMediaElementSource(elA1);
    var srcA2 = audioCtx.createMediaElementSource(elA2);
    srcA1.connect(head); srcA2.connect(head);
    for (var i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1]);
    var tail = eqFilters[eqFilters.length - 1];
    tail.connect(analyser);
    analyser.connect(loudnessGain);
    loudnessGain.connect(audioCtx.destination);
  }

  function setEqGains(gains) {
    var g = normalizeEQ(gains);
    if (!g) return false;
    eqGains = g;
    if (eqFilters) {
      for (var i = 0; i < eqFilters.length; i++) eqFilters[i].gain.value = g[i] || 0;
    }
    return true;
  }

  /* 响度均衡：用播放中的 RMS 估计当前曲目的响度，慢速调整增益做补偿。
   *   · 只在可分析链路生效（跨域音频没有 Web Audio 通路）
   *   · 增益限制在 0.5x–2x，时间常数秒级，避免「呼吸感」
   *   · 极弱段落（静音 / 间奏）不参与估计，否则会在安静处狂加增益 */
  function resetLoudness() { loudness.rms = 0; loudness.last = 0; }

  function updateLoudness() {
    if (!loudness.on || !loudnessGain || !analyser || !activeCh || !activeCh.analysable) return;
    var now = perfNow();
    if (now - loudness.last < 200) return;   // 5Hz 足够，高频读会抖
    loudness.last = now;
    analyser.getByteTimeDomainData(timeData);
    var sum = 0;
    for (var i = 0; i < timeData.length; i++) {
      var d = (timeData[i] - 128) / 128;
      sum += d * d;
    }
    var rms = Math.sqrt(sum / timeData.length);
    if (!isFinite(rms) || rms < 0.004) return;
    loudness.rms = loudness.rms > 0 ? (loudness.rms * 0.85 + rms * 0.15) : rms;
    if (loudness.rms <= 0) return;
    var want = LOUDNESS_REF / loudness.rms;
    if (!isFinite(want)) return;
    want = Math.max(0.5, Math.min(2, want));
    loudness.applied = want;
    try {
      if (loudnessGain.gain.setTargetAtTime) loudnessGain.gain.setTargetAtTime(want, audioCtx.currentTime, 0.6);
      else loudnessGain.gain.value = want;
    } catch (e) {}
  }

  /* ---------- AB 段循环 ---------- */
  var ab = { a: null, b: null, on: false };
  function abState() { return { a: ab.a, b: ab.b, on: ab.on }; }
  function refreshAb() { ab.on = (ab.a != null && ab.b != null && ab.b > ab.a); }
  function setAbPoint(which) {
    if (!active) return false;
    var t = active.currentTime || 0;
    if (which === 'a') {
      ab.a = t;
      if (ab.b != null && ab.b <= ab.a + 0.3) ab.b = null;   // B 落在 A 之前，作废
    } else {
      if (ab.a == null) { ab.a = 0; }                        // 未设 A 时默认从曲首开始
      if (t <= ab.a + 0.3) return false;                     // B 必须明显晚于 A
      ab.b = t;
    }
    refreshAb();
    emit('ab', abState());
    return true;
  }
  function clearAb() { ab.a = null; ab.b = null; ab.on = false; emit('ab', abState()); }
  function setAb(a, b) {
    ab.a = (typeof a === 'number' && isFinite(a)) ? Math.max(0, a) : null;
    ab.b = (typeof b === 'number' && isFinite(b)) ? b : null;
    if (ab.a != null && ab.b != null && ab.b <= ab.a) ab.b = null;
    refreshAb();
    emit('ab', abState());
    return ab.on;
  }
  // 循环回跳：越过 B（或拖到 A 之前）即回到 A
  function enforceAbLoop() {
    if (!ab.on || !active) return;
    var t = active.currentTime;
    if (!isFinite(t)) return;
    if (t >= ab.b || t < ab.a - 0.5) {
      try { active.currentTime = ab.a; } catch (e) {}
    }
  }

  /* ---------- 交叉淡入淡出 ---------- */
  var crossfade = 0;        // 秒，0 = 关闭
  var xfade = { on: false, timer: null, from: null };

  function cancelXfade(pauseFrom) {
    if (xfade.timer) { clearTimeout(xfade.timer); xfade.timer = null; }
    if (pauseFrom && xfade.from) { try { xfade.from.el.pause(); } catch (e) {} }
    xfade.on = false;
    xfade.from = null;
  }

  function getUrl(track) {
    if (track.source === 'local') {
      if (!urlCache[track.id]) urlCache[track.id] = global.URL.createObjectURL(track.file);
      return urlCache[track.id];
    }
    return track.url;
  }
  function revokeUrl(id) { if (urlCache[id]) { global.URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } }

  // 能否接入 Web Audio 分析链路（决定可视化有没有真频谱、EQ 与响度均衡是否生效）：
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

  function applyPitchPreserve(el) {
    try { el.preservesPitch = keepPitch; } catch (e) {}
    try { if ('mozPreservesPitch' in el) el.mozPreservesPitch = keepPitch; } catch (e) {}
    try { if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = keepPitch; } catch (e) {}
  }

  function bind(el) {
    el.addEventListener('timeupdate', function () {
      if (el !== active) return;                 // 交叉期间旧通道的进度不参与
      if (playlist[index]) saveProgress(playlist[index], el.currentTime);
      updatePositionState(false);
      enforceAbLoop();
      maybeCrossfade();
      updateLoudness();
      emit('time', el.currentTime, el.duration || 0);
    });
    el.addEventListener('loadedmetadata', function () {
      if (el !== active) return;
      applySavedProgressAt(el);
      emit('meta', el.duration || 0);
    });
    el.addEventListener('play', function () {
      if (el !== active) return;
      setPlaybackState('playing');
      emit('state', true);
    });
    el.addEventListener('pause', function () {
      if (el !== active) return;
      setPlaybackState('paused');
      emit('state', false);
    });
    el.addEventListener('ended', function () {
      if (el !== active) return;                 // 交叉淡出结束的旧通道自然也会 ended，忽略
      handleEnded();
    });
    el.addEventListener('error', function () {
      if (el !== active) return;
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
  var pendingSeek = null;
  function applySavedProgress(track) {
    pendingSeek = track || null;
    if (!pendingSeek) return;
    applySavedProgressAt(active);
  }
  function applySavedProgressAt(el) {
    if (!pendingSeek || !el) return;
    var t = progress[pendingSeek.id];
    if (!t || t <= 3) { pendingSeek = null; return; }  // 跳过开头 3 秒，避免无意义续播
    if (el.readyState >= 1) {
      if (isFinite(el.duration) && t < el.duration - 2) { try { el.currentTime = t; } catch (e) {} }
      pendingSeek = null;
    }
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
    if (repeat === 'one') {
      markPlayed(playlist[index]);
      resetLoudness();
      active.currentTime = 0;
      active.play();
      return;
    }
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

  /* 把「要播哪首」的准备动作抽出来，供普通切歌与交叉淡入淡出共用 */
  function prepareChannel(ch, track, i) {
    setActiveCh(ch);
    var el = ch.el;
    el.volume = 0;
    el.playbackRate = rate; el.defaultPlaybackRate = rate;
    applyPitchPreserve(el);
    el.src = getUrl(track);
    el.load();
    resetLoudness();
    applySavedProgress(track);
    emit('track', track, i);
    emit('cover', track.cover || null);
    setMediaMetadata(track);
    updatePositionState(true);
    if (CM && CM.Visualizer) CM.Visualizer.setAnalyser(ch.analysable && analyser ? analyser : null);
  }

  function loadIndex(i, autoplay) {
    if (i < 0 || i >= playlist.length) return;
    cancelXfade(true);                            // 手动切歌：取消进行中的交叉，直接停掉旧通道
    var prev = active;
    if (prev && !prev.paused) {
      fadeTo(prev, 0, 160);                       // 旧曲淡出（防爆音）
      setTimeout(function () { try { prev.pause(); } catch (e) {} }, 180);
    } else if (prev) {
      prev.pause();
    }
    index = i;
    var track = playlist[i];
    var ch = pickChannel(track);
    prepareChannel(ch, track, i);
    // 清理交叉残留：既不是新通道、也不是正在淡出的旧通道，一律停掉
    CHANNELS.forEach(function (c) {
      if (c !== ch && c.el !== prev && !c.el.paused) { try { c.el.pause(); } catch (e) {} }
    });
    if (autoplay) { markPlayed(track); play(); }
  }

  /* 交叉淡入淡出：自动切歌（播到接近结尾）时，新曲在当前元素之外的通道上淡入、旧曲同步淡出。
   * 手动切歌不走这里 —— 那时用户已明确表达意图，延迟切换反而迟钝。 */
  function maybeCrossfade() {
    if (!crossfade || xfade.on) return;
    if (!active || active.paused) return;
    if (ab.on || repeat === 'one' || stopAfterCurrent) return;
    var dur = active.duration;
    if (!isFinite(dur) || dur <= 0) return;
    var remain = dur - active.currentTime;
    if (remain > crossfade || remain <= 0.06) return;
    var ni = nextIndex(false);
    if (ni < 0 || ni === index) return;
    startCrossfade(ni);
  }

  function startCrossfade(ni) {
    var track = playlist[ni];
    var fromCh = activeCh;
    var toCh = pickChannel(track);
    if (!toCh || toCh === fromCh) return;         // 单通道时才退化为普通切歌
    var ms = Math.max(200, crossfade * 1000);

    xfade.on = true;
    xfade.from = fromCh;
    index = ni;
    prepareChannel(toCh, track, ni);
    markPlayed(track);

    var p = toCh.el.play();
    if (p && p.catch) p.catch(function () {});
    fadeTo(toCh.el, targetVolume, ms);
    fadeTo(fromCh.el, 0, ms);
    setPlaybackState('playing');

    xfade.timer = setTimeout(function () {
      try { fromCh.el.pause(); } catch (e) {}
      xfade.on = false;
      xfade.from = null;
      xfade.timer = null;
      maybeCrossfade();                           // 极短曲目可能已经开始下一轮交叉
    }, ms + 80);
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
    cancelXfade(true);
    CHANNELS.forEach(function (c) { try { c.el.pause(); } catch (e) {} });  // 交叉可能有两个通道在响
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
    var t0 = perfNow();
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
    CHANNELS.forEach(function (c) { c.el.volume = v; });
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
    CHANNELS.forEach(function (c) {
      bind(c.el);
      c.el.volume = targetVolume;
      applyPitchPreserve(c.el);
    });
    loadPrefs();
    setupMediaSession();
  }

  /* 播放偏好持久化（5D 新增项与既有项统一在这里读写） */
  var LS_PREFS = 'cm-engine';
  function loadPrefs() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(LS_PREFS) || 'null'); } catch (e) { p = null; }
    if (!p || typeof p !== 'object') return;
    if (typeof p.crossfade === 'number') crossfade = Math.max(0, Math.min(8, p.crossfade));
    if (typeof p.keepPitch === 'boolean') setKeepPitch(p.keepPitch);
    if (typeof p.loudness === 'boolean') setLoudness(p.loudness);
  }
  function savePrefs() {
    try {
      localStorage.setItem(LS_PREFS, JSON.stringify({
        crossfade: crossfade, keepPitch: keepPitch, loudness: loudness.on
      }));
    } catch (e) {}
  }
  function setKeepPitch(v) {
    keepPitch = !!v;
    CHANNELS.forEach(function (c) { applyPitchPreserve(c.el); });
    savePrefs();
    return keepPitch;
  }
  function setLoudness(v) {
    loudness.on = !!v;
    resetLoudness();
    if (loudnessGain) {
      try {
        var g = loudness.on ? loudness.applied : 1;
        if (loudnessGain.gain.setTargetAtTime) loudnessGain.gain.setTargetAtTime(g, audioCtx.currentTime, 0.2);
        else loudnessGain.gain.value = g;
      } catch (e) {}
    }
    savePrefs();
    return loudness.on;
  }
  function setCrossfade(sec) {
    var s = Number(sec);
    crossfade = isFinite(s) ? Math.max(0, Math.min(8, s)) : 0;
    if (!crossfade) cancelXfade(true);
    savePrefs();
    return crossfade;
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
    getVolume: function () { return targetVolume; },
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
    queuePushMany: function (list) { (list || []).forEach(function (t) { if (t) playlist.push(t); }); },
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
    /* ---------- 音频引擎（5D） ---------- */
    EQ_FREQS: EQ_FREQS,
    EQ_PRESETS: EQ_PRESETS,
    EQ_LEGACY_PRESET_ALIAS: EQ_LEGACY_PRESET_ALIAS,
    normalizeEQ: normalizeEQ,
    setEQ: function (gains) { return setEqGains(gains); },
    getEQ: function () { return eqGains.slice(); },
    setEQPreset: function (name) {
      var g = EQ_PRESETS[name];
      if (!g) return false;
      setEqGains(g);
      return true;
    },
    setCrossfade: setCrossfade,
    getCrossfade: function () { return crossfade; },
    isCrossfading: function () { return xfade.on; },
    setKeepPitch: setKeepPitch,
    getKeepPitch: function () { return keepPitch; },
    setLoudness: setLoudness,
    getLoudness: function () { return loudness.on; },
    getLoudnessGain: function () { return loudness.applied; },
    setAbPoint: setAbPoint,
    setAb: setAb,
    clearAb: clearAb,
    getAb: abState,
    isAnalysable: isAnalysable,
    /* ---------- 播放参数 ---------- */
    setRate: function (r) {
      rate = r;
      CHANNELS.forEach(function (c) {
        try { c.el.playbackRate = r; c.el.defaultPlaybackRate = r; } catch (e) {}
      });
      updatePositionState(true);
    },
    getRate: function () { return rate; },
    setStopAfterCurrent: function (v) { stopAfterCurrent = !!v; },
    getActiveDuration: function () { return active && isFinite(active.duration) ? active.duration : 0; }
  };
})(window);
