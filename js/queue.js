/* queue.js — 独立播放队列面板（拖拽重排 / 移除 / 点击跳转）
 * 拖拽用 Pointer Events + 手柄（touch-action:none），桌面与移动端统一。
 */
(function (global) {
  'use strict';

  var listEl, emptyEl;
  var cb = {};
  var dragging = false, fromIndex = -1, justDragged = false;
  var indicator = null, startX = 0, startY = 0, curHandle = null;

  function init(opts) {
    listEl = document.getElementById('queue');
    emptyEl = document.getElementById('queue-empty');
    cb = opts || {};
  }

  function isImg(cover) {
    return cover && (cover.indexOf('data:') === 0 || cover.indexOf('http') === 0);
  }

  function render(list, currentIndex) {
    if (!listEl) return;
    listEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', list.length > 0);
    list.forEach(function (track, i) {
      var li = document.createElement('li');
      li.className = 'q-track' + (i === currentIndex ? ' playing' : '');
      li.setAttribute('data-qindex', i);

      var handle = document.createElement('div');
      handle.className = 'drag-handle';
      handle.title = '拖拽排序';
      handle.textContent = '⠿';

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
      s.textContent = track.artist || '未知歌手';
      info.appendChild(t); info.appendChild(s);

      var del = document.createElement('button');
      del.className = 'track-del';
      del.title = '移除';
      del.textContent = '✕';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (cb.onRemove) cb.onRemove(i);
      });

      li.appendChild(handle);
      li.appendChild(badge);
      li.appendChild(info);
      li.appendChild(del);

      li.addEventListener('click', function () {
        if (justDragged) { justDragged = false; return; }
        if (cb.onPlayAt) cb.onPlayAt(i);
      });

      bindDrag(handle, li, i);
      listEl.appendChild(li);
    });
  }

  function bindDrag(handle, li, i) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      fromIndex = i;
      startX = e.clientX; startY = e.clientY;
      curHandle = handle;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  function onMove(e) {
    if (fromIndex < 0) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 8) return;
      dragging = true;
      var cur = listEl.querySelector('.q-track[data-qindex="' + fromIndex + '"]');
      if (cur) cur.classList.add('dragging');
      indicator = document.createElement('li');
      indicator.className = 'drop-indicator';
    }
    var lis = Array.prototype.slice.call(listEl.querySelectorAll('.q-track'));
    var ins = lis.length;
    for (var k = 0; k < lis.length; k++) {
      var r = lis[k].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { ins = k; break; }
    }
    if (ins >= lis.length) listEl.appendChild(indicator);
    else listEl.insertBefore(indicator, lis[ins]);
  }

  function onUp() {
    if (curHandle) {
      curHandle.removeEventListener('pointermove', onMove);
      curHandle.removeEventListener('pointerup', onUp);
      curHandle.removeEventListener('pointercancel', onUp);
    }
    if (dragging) {
      var to = computeDrop(fromIndex);
      var cur = listEl.querySelector('.q-track[data-qindex="' + fromIndex + '"]');
      if (cur) cur.classList.remove('dragging');
      if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
      if (to !== fromIndex && cb.onReorder) cb.onReorder(fromIndex, to);
    }
    justDragged = dragging;
    dragging = false; fromIndex = -1; curHandle = null;
  }

  function computeDrop(from) {
    var kids = Array.prototype.slice.call(listEl.children);
    var indPos = kids.indexOf(indicator);
    if (indPos < 0) return from;
    var before = 0;
    for (var k = 0; k < indPos; k++) {
      if (kids[k].classList.contains('q-track')) before++;
    }
    var ins = before;
    if (from < ins) ins = ins - 1;
    return ins;
  }

  function setCurrent(ci) {
    if (!listEl) return;
    var items = listEl.querySelectorAll('.q-track');
    items.forEach(function (el, i) { el.classList.toggle('playing', i === ci); });
  }

  global.CM = global.CM || {};
  global.CM.Queue = { init: init, render: render, setCurrent: setCurrent };
})(window);
