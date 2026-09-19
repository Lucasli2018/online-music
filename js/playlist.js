/* playlist.js — 左栏曲库 / 歌单浏览渲染（点击播放 / 收藏 / 菜单 / 移除 / 批量多选）
 * 拖拽排序已迁移到独立队列面板（queue.js）。高亮改用 trackId，
 * 因为左栏视图与播放队列的索引不一定一致。
 * 多选态（opts.selection.on）下：行点击改为切换选中，收藏 / 菜单 / 移除按钮隐藏。
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
    var sel = cb.selection || { on: false, ids: {} };
    var selIds = sel.ids || {};
    listEl.innerHTML = '';
    listEl.classList.toggle('multi-mode', !!sel.on);
    emptyEl.classList.toggle('hidden', list.length > 0);
    list.forEach(function (track) {
      var selected = !!selIds[track.id];
      var li = document.createElement('li');
      li.className = 'track'
        + (track.id === currentId ? ' playing' : '')
        + (sel.on ? ' multi' : '')
        + (selected ? ' selected' : '');
      li.setAttribute('data-id', track.id);

      if (sel.on) {
        var pick = document.createElement('span');
        pick.className = 'track-pick' + (selected ? ' on' : '');
        pick.textContent = selected ? '✓' : '';
        li.appendChild(pick);
      }

      var badge = document.createElement('div');
      badge.className = 'track-badge';
      var icon = track.source === 'local' ? '💾' : (track.source === 'sample' ? '🎵' : (track.source === 'online' ? '🌐' : '🔗'));
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
        (track.source === 'local' ? ' · 本地' : (track.source === 'sample' ? ' · 示例' : (track.source === 'online' ? ' · 在线' : ' · 链接')));
      info.appendChild(t); info.appendChild(s);

      li.appendChild(badge);
      li.appendChild(info);

      if (!sel.on) {
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

        li.appendChild(fav);
        li.appendChild(menu);
        li.appendChild(del);
      }

      li.addEventListener('click', function () {
        if (sel.on) { if (cb.onToggleSelect) cb.onToggleSelect(track); return; }
        if (cb.onPlay) cb.onPlay(track);
      });

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
