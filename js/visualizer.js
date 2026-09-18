/* visualizer.js — Canvas 频谱可视化
 * 有 Web Audio analyser 时画真实频谱；远程非同源音频无法读取数据时降级为装饰动画。
 */
(function (global) {
  'use strict';

  var canvas, ctx, raf = null, analyser = null, data = null;
  var bars = 48;

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
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // analyser 为 null 时走装饰模式
  function setAnalyser(node) {
    analyser = node;
    if (node) data = new Uint8Array(node.frequencyBinCount);
  }

  function accentColors() {
    var cs = getComputedStyle(document.documentElement);
    return {
      a: cs.getPropertyValue('--accent').trim() || '#ff7a45',
      soft: cs.getPropertyValue('--accent-soft').trim() || '#ffb38a'
    };
  }

  function draw() {
    raf = global.requestAnimationFrame(draw);
    if (!ctx) return;
    var rect = canvas.getBoundingClientRect();
    var w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);
    var col = accentColors();
    var gap = 3;
    var bw = (w - gap * (bars - 1)) / bars;
    var vals = [];

    if (analyser) {
      analyser.getByteFrequencyData(data);
      var step = Math.floor(data.length / bars) || 1;
      for (var i = 0; i < bars; i++) {
        vals.push(data[i * step] / 255);
      }
    } else {
      // 装饰动画：用正弦叠加制造律动感
      var t = Date.now() / 380;
      for (var j = 0; j < bars; j++) {
        var v = 0.18 + 0.16 * (Math.sin(t + j * 0.4) * 0.5 + 0.5)
              + 0.1 * (Math.sin(t * 1.7 + j * 0.9) * 0.5 + 0.5);
        vals.push(v);
      }
    }

    for (var k = 0; k < bars; k++) {
      var vh = Math.max(2, vals[k] * (h * 0.82));
      var x = k * (bw + gap);
      var y = (h - vh) / 2;
      var grad = ctx.createLinearGradient(0, y, 0, y + vh);
      grad.addColorStop(0, col.a);
      grad.addColorStop(1, col.soft);
      ctx.fillStyle = grad;
      roundRect(ctx, x, y, bw, vh, bw / 2);
      ctx.fill();
    }
  }

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

  function start() { if (!raf) draw(); }
  function stop() { if (raf) { global.cancelAnimationFrame(raf); raf = null; } ctx && ctx.clearRect(0, 0, canvas.width, canvas.height); }

  global.CM = global.CM || {};
  global.CM.Visualizer = { init: init, setAnalyser: setAnalyser, start: start, stop: stop, resize: resize };
})(window);
