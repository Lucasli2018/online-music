/* playlist.js — 播放列表渲染与交互（点击播放 / 删除 / 拖拽排序） */
(function (global) {
  'use strict';

  var listEl, emptyEl, dragSrc = null;
  var cb = {};

  function init(opts) {
    listEl = document.getElementById('playlist');
    emptyEl = document.getElementById('playlist-empty');
    cb = opts || {};
  }

  function render(list, currentIndex) {
    if (!listEl) return;
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', list.length > 0);
    list.forEach(function (track, i) {
      var li = document.createElement('li');
      li.className = 'track' + (i === currentIndex ? ' playing' : '');
      li.setAttribute('data-index', i);
      li.setAttribute('draggable', 'true');

      var badge = document.createElement('div');
      badge.className = 'track-badge';
      var icon = track.source === 'local' ? '💾' : (track.source === 'sample' ? '🎵' : '🔗');
      badge.textContent = icon;

      var info = document.createElement('div');
      info.className = 'track-info';
      var t = document.createElement('div');
      t.className = 'track-title';
      t.textContent = track.title || '未知标题';
      var s = document.createElement('div');
      s.className = 'track-sub';
      s.textContent = (track.artist || '未知歌手') + (track.source === 'local' ? ' · 本地' : (track.source === 'sample' ? ' · 示例' : ' · 链接'));
      info.appendChild(t); info.appendChild(s);

      var eq = document.createElement('div');
      eq.className = 'eq';
      eq.innerHTML = '<span></span><span></span><span></span>';

      var del = document.createElement('button');
      del.className = 'track-del';
      del.title = '移除';
      del.textContent = '✕';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (cb.onRemove) cb.onRemove(track.id, i);
      });

      li.appendChild(badge);
      li.appendChild(info);
      li.appendChild(eq);
      li.appendChild(del);

      li.addEventListener('click', function () { if (cb.onPlay) cb.onPlay(i); });

      // 拖拽排序
      li.addEventListener('dragstart', function () { dragSrc = i; li.classList.add('dragging'); });
      li.addEventListener('dragend', function () { li.classList.remove('dragging'); dragSrc = null; });
      li.addEventListener('dragover', function (e) { e.preventDefault(); li.classList.add('drop-target'); });
      li.addEventListener('dragleave', function () { li.classList.remove('drop-target'); });
      li.addEventListener('drop', function (e) {
        e.preventDefault();
        li.classList.remove('drop-target');
        var to = i;
        if (dragSrc !== null && dragSrc !== to && cb.onReorder) cb.onReorder(dragSrc, to);
      });

      listEl.appendChild(li);
    });
  }

  function setCurrent(currentIndex) {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.track');
    items.forEach(function (el, i) {
      el.classList.toggle('playing', i === currentIndex);
    });
  }

  global.CM = global.CM || {};
  global.CM.Playlist = { init: init, render: render, setCurrent: setCurrent };
})(window);
