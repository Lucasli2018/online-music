/* sw.js — 珊瑚音乐 Service Worker
 * 策略（v3 起）：同源资源一律 network-first —— 在线时总是拿最新，离线才回退缓存。
 * 背景：早期版本用 cache-first + install 时一次性 addAll，导致 js 被永久钉在首次缓存的版本，
 *       用户端出现「HTML 是新版、JS 是旧版」——新按钮存在但没绑定、点击无反应。
 * 不接管音频：本地歌走 IndexedDB（不经网络），远程 / 在线音频跨域不拦截。
 */
const CACHE = 'coral-music-v4';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/style.css',
  './js/storage.js',
  './js/samples.js',
  './js/lyrics.js',
  './js/online.js',
  './js/auth.js',
  './js/visualizer.js',
  './js/id3.js',
  './js/library.js',
  './js/player.js',
  './js/playlist.js',
  './js/queue.js',
  './js/app.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // cache:'reload' 绕过 HTTP 缓存，避免把旧的 js 预缓存进来
      return Promise.all(SHELL.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
          if (res && res.ok) return c.put(u, res);
        }).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（远程 / 在线音频等）不接管

  // 同源资源：network-first（拿最新），离线才回退缓存
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
      });
    })
  );
});
