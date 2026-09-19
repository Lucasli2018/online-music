/* visualizer.js — Canvas 可视化（多模式）
 * 模式注册表：bars（频谱条）/ wave（波形）/ ring（环形）/ minimal（极简）。
 * 有 Web Audio analyser 时画真实数据（频谱 + 时域），跨域音频拿不到数据时降级为装饰动画，
 * 两种数据源对四种模式都通用，模式实现不必关心数据从哪来。
 */
(function (global) {
  'use strict';

  var canvas, ctx, raf = null, analyser = null;
  var freqData = null;   // Uint8Array(frequencyBinCount)
  var waveData = null;   // Uint8Array(fftSize)
  var bars = 48;

  var MODE_ORDER = ['bars', 'wave', 'ring', 'minimal'];
  var MODE_LABELS = { bars: '频谱条', wave: '波形', ring: '环形', minimal: '极简' };
  var MODE_ICONS = { bars: '📊', wave: '〰', ring: '◎', minimal: '•' };
  var mode = 'bars';

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    resize();
    global.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    var dpr = global.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // analyser 为 null 时走装饰模式
  function setAnalyser(node) {
    analyser = node;
    if (node) {
      freqData = new Uint8Array(node.frequencyBinCount);
      waveData = new Uint8Array(node.fftSize || node.frequencyBinCount * 2);
    }
  }

  function setMode(name) {
    if (MODE_ORDER.indexOf(name) < 0) return mode;
    mode = name;
    return mode;
  }
  function getMode() { return mode; }
  function nextMode() {
    var i = MODE_ORDER.indexOf(mode);
    return setMode(MODE_ORDER[(i + 1) % MODE_ORDER.length]);
  }

  function accentColors() {
    var cs = getComputedStyle(document.documentElement);
    return {
      a: cs.getPropertyValue('--accent').trim() || '#ff7a45',
      soft: cs.getPropertyValue('--accent-soft').trim() || '#ffb38a'
    };
  }

  /* ---------- 数据源 ---------- */
  function freqValues() {
    var out = [], i;
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData);
      var step = Math.floor(freqData.length / bars) || 1;
      for (i = 0; i < bars; i++) out.push(freqData[i * step] / 255);
      return out;
    }
    // 装饰动画：正弦叠加制造律动感
    var t = Date.now() / 380;
    for (i = 0; i < bars; i++) {
      out.push(0.18 + 0.16 * (Math.sin(t + i * 0.4) * 0.5 + 0.5)
        + 0.1 * (Math.sin(t * 1.7 + i * 0.9) * 0.5 + 0.5));
    }
    return out;
  }

  function waveValues() {
    var i, out = [];
    if (analyser && waveData) {
      analyser.getByteTimeDomainData(waveData);
      return waveData;
    }
    var t = Date.now() / 300;
    for (i = 0; i < 128; i++) out.push(128 + 58 * Math.sin(i * 0.11 + t) * Math.cos(i * 0.031 + t * 0.6));
    return out;
  }

  /* ---------- 四种模式 ---------- */
  var MODES = {
    bars: function (c, w, h, vals, wave, col) {
      var gap = 3;
      var bw = (w - gap * (bars - 1)) / bars;
      for (var k = 0; k < bars; k++) {
        var vh = Math.max(2, vals[k] * (h * 0.82));
        var x = k * (bw + gap);
        var y = (h - vh) / 2;
        var grad = c.createLinearGradient(0, y, 0, y + vh);
        grad.addColorStop(0, col.a);
        grad.addColorStop(1, col.soft);
        c.fillStyle = grad;
        roundRect(c, x, y, bw, vh, bw / 2);
        c.fill();
      }
    },

    wave: function (c, w, h, vals, wave, col) {
      var n = wave.length;
      if (!n) return;
      var mid = h / 2;
      c.beginPath();
      for (var i = 0; i < n; i++) {
        var x = (i / (n - 1)) * w;
        var v = (wave[i] - 128) / 128;
        var y = mid + v * (h * 0.42);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.strokeStyle = col.a;
      c.lineWidth = 2;
      c.lineJoin = 'round';
      c.stroke();
      // 镜像一层淡影，让单线不至于太单薄
      c.save();
      c.globalAlpha = 0.22;
      c.beginPath();
      for (var j = 0; j < n; j++) {
        var x2 = (j / (n - 1)) * w;
        var v2 = -(wave[j] - 128) / 128;
        var y2 = mid + v2 * (h * 0.42);
        if (j === 0) c.moveTo(x2, y2); else c.lineTo(x2, y2);
      }
      c.strokeStyle = col.soft;
      c.stroke();
      c.restore();
      // 中线
      c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid);
      c.strokeStyle = col.soft; c.globalAlpha = 0.25; c.lineWidth = 1; c.stroke(); c.globalAlpha = 1;
    },

    ring: function (c, w, h, vals, wave, col) {
      var cx = w / 2, cy = h / 2;
      var size = Math.min(w, h);
      var base = size * 0.23;
      var n = vals.length;
      c.save();
      c.translate(cx, cy);
      for (var i = 0; i < n; i++) {
        var a = (i / n) * Math.PI * 2 - Math.PI / 2;
        var len = 3 + vals[i] * (size * 0.2);
        c.beginPath();
        c.moveTo(Math.cos(a) * base, Math.sin(a) * base);
        c.lineTo(Math.cos(a) * (base + len), Math.sin(a) * (base + len));
        c.strokeStyle = (i / n < 0.5) ? col.a : col.soft;
        c.lineWidth = Math.max(2, ((2 * Math.PI * base) / n) * 0.45);
        c.lineCap = 'round';
        c.stroke();
      }
      c.restore();
      c.beginPath();
      c.arc(cx, cy, base * 0.7, 0, Math.PI * 2);
      c.fillStyle = col.soft;
      c.globalAlpha = 0.16;
      c.fill();
      c.globalAlpha = 1;
    },

    minimal: function (c, w, h, vals, wave, col) {
      var n = Math.max(1, Math.floor(vals.length / 6));
      var low = 0;
      for (var i = 0; i < n; i++) low += vals[i];
      low /= n;
      var cx = w / 2, cy = h / 2;
      var r = Math.min(w, h) * (0.05 + low * 0.2);
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fillStyle = col.a;
      c.globalAlpha = 0.85;
      c.fill();
      c.globalAlpha = 1;
      c.beginPath();
      c.moveTo(cx - w * 0.34, cy);
      c.lineTo(cx + w * 0.34, cy);
      c.strokeStyle = col.soft;
      c.globalAlpha = 0.45;
      c.lineWidth = 1;
      c.stroke();
      c.globalAlpha = 1;
    }
  };

  function roundRect(c, x, y, w, h, r) {
    if (h < r * 2) r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /* 画一帧（抽出来便于测试直接驱动，不必依赖 rAF） */
  function render() {
    if (!ctx || !canvas) return;
    var rect = canvas.getBoundingClientRect();
    var w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    if (w <= 1 || h <= 1) return;
    var fn = MODES[mode] || MODES.bars;
    fn(ctx, w, h, freqValues(), waveValues(), accentColors());
  }

  function draw() {
    raf = global.requestAnimationFrame(draw);
    render();
  }

  function start() { if (!raf) draw(); }
  function stop() {
    if (raf) { global.cancelAnimationFrame(raf); raf = null; }
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  global.CM = global.CM || {};
  global.CM.Visualizer = {
    init: init, setAnalyser: setAnalyser, start: start, stop: stop, resize: resize,
    render: render, setMode: setMode, getMode: getMode, nextMode: nextMode,
    MODE_ORDER: MODE_ORDER, MODE_LABELS: MODE_LABELS, MODE_ICONS: MODE_ICONS
  };
})(window);
