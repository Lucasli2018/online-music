/* tests/helpers.js — 沙箱加载器
 * 项目里的 js/*.js 都是 IIFE：(function (global) { ... })(window)，把接口挂到 window.CM 上。
 * 在 Node 里用 vm 造一个「全局对象即 window」的沙箱（与浏览器一致），
 * 再按顺序 eval 模块源码，即可拿到真实的 CM 命名空间做纯逻辑测试。
 * 不依赖任何第三方测试框架，只用 node:test + node:assert。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');

/* 内存版 localStorage（对齐 Web Storage 接口） */
function createStorage() {
  var map = new Map();
  return {
    getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { map.set(String(k), String(v)); },
    removeItem: function (k) { map.delete(String(k)); },
    clear: function () { map.clear(); },
    key: function (i) { return Array.from(map.keys())[i] || null; },
    _dump: function () { return Object.fromEntries(map); }
  };
}

/* 最小 Audio 元素替身：只实现 player.js 用到的表面 */
function createAudioStub() {
  var listeners = {};
  var el = {
    src: '',
    volume: 0,
    playbackRate: 1,
    defaultPlaybackRate: 1,
    currentTime: 0,
    duration: 0,
    readyState: 0,
    paused: true,
    load: function () {},
    play: function () { el.paused = false; emit('play'); return Promise.resolve(); },
    pause: function () { el.paused = true; emit('pause'); },
    addEventListener: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener: function () {},
    _listeners: listeners,
    _emit: emit
  };
  function emit(name) {
    (listeners[name] || []).forEach(function (fn) { fn(); });
  }
  return el;
}

/* 最小 Media Session 替身：记录 action handler 与位置状态，供系统媒体控制测试使用 */
function createMediaSessionStub() {
  var handlers = {};
  return {
    metadata: null,
    playbackState: 'none',
    positionState: null,
    setActionHandler: function (action, fn) { handlers[action] = fn; },
    setPositionState: function (s) { this.positionState = s; },
    _handlers: handlers,
    _invoke: function (action, detail) {
      if (!handlers[action]) throw new Error('未注册的媒体动作: ' + action);
      return handlers[action](detail);
    }
  };
}

/* MediaMetadata 替身：仅保留传入字段 */
function createMediaMetadataStub() {
  return function MediaMetadata(init) {
    var self = this;
    Object.keys(init || {}).forEach(function (k) { self[k] = init[k]; });
  };
}

/* 构造一个上下文；opts.fetch / opts.Audio 可覆盖默认实现 */
function createAppContext(opts) {
  opts = opts || {};
  var sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    TextDecoder: TextDecoder,
    TextEncoder: TextEncoder,
    URL: {
      createObjectURL: function () { return 'blob:test/' + Math.random().toString(36).slice(2); },
      revokeObjectURL: function () {}
    },
    // 默认不驱动动画帧（避免淡入淡出回调无限递归）；传 opts.onRaf 可接管帧调度
    requestAnimationFrame: function (cb) {
      if (opts.onRaf) opts.onRaf(cb);
      return 0;
    },
    cancelAnimationFrame: function () {},
    fetch: opts.fetch || function () { return Promise.reject(new Error('测试环境未启用 fetch')); },
    Audio: opts.Audio || createAudioStub,
    localStorage: opts.storage || createStorage(),
    navigator: opts.navigator || {},
    performance: opts.performance || { now: function () { return Date.now(); } }
  };
  if (opts.MediaMetadata) sandbox.MediaMetadata = opts.MediaMetadata;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

/* 按顺序加载 js/ 下的模块到上下文 */
function loadModules(names, ctx) {
  names.forEach(function (name) {
    var full = path.join(ROOT, 'js', name);
    var code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, ctx, { filename: 'js/' + name });
  });
  return ctx.CM;
}

/* 只需 CM 命名空间的便捷入口 */
function loadCM(names, opts) {
  var ctx = createAppContext(opts);
  return loadModules(names, ctx);
}

/* ---------- fetch 路由替身 ---------- */
function jsonResponse(obj) {
  return {
    ok: true, status: 200,
    json: function () { return Promise.resolve(obj); },
    text: function () { return Promise.resolve(JSON.stringify(obj)); }
  };
}
function textResponse(str) {
  return {
    ok: true, status: 200,
    json: function () { return Promise.resolve(JSON.parse(str)); },
    text: function () { return Promise.resolve(str); }
  };
}
function errorResponse(status) {
  return {
    ok: false, status: status,
    json: function () { return Promise.reject(new Error('HTTP ' + status)); },
    text: function () { return Promise.resolve(''); }
  };
}

/* routes: [[正则, url => 响应], ...]；调用记录挂在 fn.calls */
function mockFetch(routes) {
  var fn = function (url) {
    var u = String(url);
    fn.calls.push(u);
    for (var i = 0; i < routes.length; i++) {
      if (routes[i][0].test(u)) return Promise.resolve(routes[i][1](u));
    }
    return Promise.reject(new Error('未匹配的请求: ' + u));
  };
  fn.calls = [];
  return fn;
}

/* 跨沙箱深比较：vm 上下文里造出来的数组/对象与宿主原型不同，
 * assert.deepStrictEqual 会因「非引用相等」失败，故先用 JSON 归一化再比。 */
function plain(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
function uniqSorted(arr) {
  return plain(arr).slice().sort(function (a, b) { return a - b; });
}

module.exports = {
  ROOT: ROOT,
  plain: plain,
  uniqSorted: uniqSorted,
  createStorage: createStorage,
  createAudioStub: createAudioStub,
  createMediaSessionStub: createMediaSessionStub,
  createMediaMetadataStub: createMediaMetadataStub,
  createAppContext: createAppContext,
  loadModules: loadModules,
  loadCM: loadCM,
  mockFetch: mockFetch,
  jsonResponse: jsonResponse,
  textResponse: textResponse,
  errorResponse: errorResponse
};
