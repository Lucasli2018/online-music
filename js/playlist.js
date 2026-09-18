/* playlist.js — 左栏曲库 / 歌单浏览渲染（点击播放 / 收藏 / 菜单 / 移除）
 * 拖拽排序已迁移到独立队列面板（queue.js）。高亮改用 trackId，
 * 因为左栏视图与播放队列的索引不一定一致。
 */
(function (global) {
  'use strict';

  var listEl, emptyEl;
  var cb = {};

  function init() {
    listEl = document.getElementById('playlist');
    emptyEl = document.getElementById('playlist-empty');
  }

  function isImg(cover) {
    return cover && (cover.indexOf('data:') === 0 || cover.indexOf('http') === 0);
  }

  function render(list, currentId, opts) {
    cb = opts || {};
    if (!listEl) return;
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', list.length > 0);
    list.forEach(function (track) {
      var li = document.createElement('li');
      li.className = 'track' + (track.id === currentId ? ' playing' : '');
      li.setAttribute('data-id', track.id);

      var badge = document.createElement('div');
      badge.className = 'track-badge';
      var icon = track.source === 'local' ? '💾' : (track.source === 'sample' ? '🎵' : '🔗');
      if (isImg(track.cover)) {
        badge.style.background = '';
        badge.style.backgroundImage = 'url("' + track.cover + '")';
        badge.style.backgroundSize = 'cover';
        badge.textContent = '';
      } else {
        badge.style.backgroundImage = '';
        badge.style.background = track.cover || 'linear-gradient(135deg, var(--accent-soft), var(--accent))';
        badge.textContent = icon;
      }

      var info = document.createElement('div');
      info.className = 'track-info';
      var t = document.createElement('div');
      t.className = 'track-title';
      t.textContent = track.title || '未知标题';
      var s = document.createElement('div');
      s.className = 'track-sub';
      s.textContent = (track.artist || '未知歌手') +
        (track.source === 'local' ? ' · 本地' : (track.source === 'sample' ? ' · 示例' : ' · 链接'));
      info.appendChild(t); info.appendChild(s);

      var favOn = global.CM && global.CM.Library && global.CM.Library.isFav(track.id);
      var fav = document.createElement('button');
      fav.className = 'track-fav' + (favOn ? ' on' : '');
      fav.title = '收藏';
      fav.textContent = favOn ? '♥' : '♡';
      fav.addEventListener('click', function (e) { e.stopPropagation(); if (cb.onFav) cb.onFav(track); });

      var menu = document.createElement('button');
      menu.className = 'track-menu';
      menu.title = '更多（加入队列 / 下一首 / 加入歌单）';
      menu.textContent = '⋮';
      menu.addEventListener('click', function (e) {
        e.stopPropagation();
        var r = menu.getBoundingClientRect();
        if (cb.onMenu) cb.onMenu(track, r.right, r.bottom);
      });

      var del = document.createElement('button');
      del.className = 'track-del';
      del.title = '移除';
      del.textContent = '✕';
      del.addEventListener('click', function (e) { e.stopPropagation(); if (cb.onRemove) cb.onRemove(track); });

      li.appendChild(badge);
      li.appendChild(info);
      li.appendChild(fav);
      li.appendChild(menu);
      li.appendChild(del);

      li.addEventListener('click', function () { if (cb.onPlay) cb.onPlay(track); });

      listEl.appendChild(li);
    });
  }

  function setCurrentById(id) {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.track');
    items.forEach(function (el) { el.classList.toggle('playing', el.getAttribute('data-id') === id); });
  }

  global.CM = global.CM || {};
  global.CM.Playlist = { init: init, render: render, setCurrentById: setCurrentById };
})(window);
