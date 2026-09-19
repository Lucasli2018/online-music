/* app.js — 总控：曲库 + 歌单 + 队列 + 搜索 + 收藏 + 歌词 + 主题
 * 阶段 2 数据模型：
 *   曲库（CM.Library.tracks）是歌曲单一事实源；歌单只存 id 引用。
 *   左栏浏览某个歌单（全部/收藏/自定义）+ 搜索过滤；点歌即从该视图起播。
 *   右栏「队列」是独立的播放顺序，可追加/插队/拖拽重排/移除。
 */
(function (global) {
  'use strict';

  var CM = global.CM;
  var Lib = CM.Library;

  var state = {
    currentListId: 'all',   // 当前浏览的歌单 tab
    query: '',              // 搜索关键字
    lyrics: {},             // trackId -> lrc 文本
    currentTrackId: null,
    currentLines: [],
    currentLineEls: [],
    currentWordEls: [],   // 每行对应的逐字 span 数组（用于卡拉OK高亮）
    lyricsVisible: true,  // 侧栏当前是否停在「歌词」面板（决定主面板滚动）
    deskLyricsOn: false,  // 桌面浮动歌词开关
    lyricOffset: 0,       // 歌词整体时间偏移（毫秒）
    sleepMode: null,      // 睡眠定时：null | 'trackEnd' | 到期时间戳(数字)
    sleepTimer: null,
    audiusMe: null,       // 已连接的 Audius 账号资料
    sortMode: 'default',  // 曲库排序方式（5E）
    multi: false,         // 批量多选态（5E）
    selected: {}          // 多选态下已选中的 trackId（5E）
  };
  // 在线曲目播放失败时的自动跳过节流（60s 内最多 3 次，防连锁死循环）
  var onlineSkip = { count: 0, since: 0 };
  var onlineRetry = { id: null, at: 0 };

  var palette = [
    'linear-gradient(135deg,#ff9a6c,#ff5e62)',
    'linear-gradient(135deg,#ffb88c,#de6262)',
    'linear-gradient(135deg,#ff7e5f,#feb47b)',
    'linear-gradient(135deg,#f6d365,#fda085)',
    'linear-gradient(135deg,#f093fb,#f5576c)',
    'linear-gradient(135deg,#ffd26f,#ff7a45)'
  ];
  function pickCover(id) {
    var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }
  function isImgCover(c) { return c && (c.indexOf('data:') === 0 || c.indexOf('http') === 0); }

  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function readText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(CM.Lyrics.decode(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  function baseNameOf(n) { return n.replace(/\.[^.]+$/, ''); }

  /* ---------- 曲库装配 ---------- */
  function addLocalRecord(rec) {
    rec.source = 'local'; rec.cover = rec.cover || pickCover(rec.id);
    Lib.addTrack(rec);
  }
  function addRemoteRecord(rec) {
    rec.cover = rec.cover || pickCover(rec.id);
    Lib.addTrack(rec);
  }
  function addSampleRecord(s) {
    Lib.addTrack(Object.assign({}, s, { cover: s.cover || pickCover(s.id) }));
  }
  function persistRemote() {
    Lib.saveRemote(Lib.allTracks().filter(function (t) {
      return t.source === 'remote' || t.source === 'online' || t.source === 'cloud';
    }));
  }
  function buildLibrary() {
    return CM.Storage.getAll().then(onLocalLoaded, function () { onLocalLoaded([]); });
  }
  function onLocalLoaded(local) {
    (local || []).forEach(addLocalRecord);
    Lib.loadRemote().forEach(addRemoteRecord);
    var firstRun = true;
    try { firstRun = !localStorage.getItem('cm-init'); } catch (e) {}
    if (firstRun) {
      CM.samples.forEach(addSampleRecord);
      try { localStorage.setItem('cm-init', '1'); } catch (e) {}
    }
  }

  /* ---------- 虚拟歌单（按播放统计实时生成，不落 localStorage） ---------- */
  var VIRTUAL_LISTS = { recent: { name: '最近' }, top: { name: '最常播' } };
  var VIRTUAL_ORDER = ['recent', 'top'];
  var VIRTUAL_MAX = 50;

  function isVirtualList(id) { return !!VIRTUAL_LISTS[id]; }

  function virtualTracks(id) {
    var stats = (CM.Player.getStats && CM.Player.getStats()) || {};
    var list = Lib.resolve(Lib.listIds('all')).filter(function (t) { return stats[t.id]; });
    if (id === 'recent') {
      list.sort(function (a, b) { return stats[b.id].at - stats[a.id].at; });
    } else {
      list.sort(function (a, b) {
        return (stats[b.id].c - stats[a.id].c) || (stats[b.id].at - stats[a.id].at);
      });
    }
    return list.slice(0, VIRTUAL_MAX);
  }

  /* ---------- 可见曲目（当前歌单 + 搜索 + 排序） ---------- */
  function getVisibleTracks() {
    var tracks = isVirtualList(state.currentListId)
      ? virtualTracks(state.currentListId)
      : Lib.resolve(Lib.listIds(state.currentListId));
    var q = state.query.trim().toLowerCase();
    if (q) {
      tracks = tracks.filter(function (t) {
        return (t.title || '').toLowerCase().indexOf(q) >= 0 ||
               (t.artist || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    // 虚拟歌单自带「最近 / 最常播」排序，不再叠加用户排序，否则语义会打架
    if (!isVirtualList(state.currentListId)) {
      tracks = Lib.sortTracks(tracks, state.sortMode, CM.Player.getStats());
    }
    return tracks;
  }

  /* ---------- 左栏渲染 ---------- */
  function renderLibrary() {
    renderTabs();
    var tracks = getVisibleTracks();
    var cur = CM.Player.getTrack();
    var hi = -1;
    if (cur) for (var k = 0; k < tracks.length; k++) { if (tracks[k].id === cur.id) { hi = k; break; } }
    CM.Playlist.render(tracks, hi, {
      onPlay: playFromTrack,
      onFav: toggleFav,
      onMenu: openAddMenu,
      onRemove: removeTrack,
      selection: { on: state.multi, ids: state.selected },
      onToggleSelect: toggleSelect
    });
    updateBatchBar();
  }
  function renderTabs() {
    var box = $('list-tabs');
    if (!box) return;
    box.innerHTML = '';
    var lists = Lib.getLists();
    var custom = Object.keys(lists).filter(function (k) { return k !== 'all' && k !== 'fav'; });
    var order = ['all', 'fav'].concat(VIRTUAL_ORDER).concat(custom);
    order.forEach(function (id) {
      var li = lists[id];
      var name, count, closable;
      if (li) {
        name = li.name;
        count = li.ids ? li.ids.length : 0;
        closable = (id !== 'all' && id !== 'fav');
      } else if (VIRTUAL_LISTS[id]) {
        name = VIRTUAL_LISTS[id].name;
        count = virtualTracks(id).length;
        closable = false;
      } else {
        return;
      }
      var tab = document.createElement('button');
      tab.className = 'list-tab' + (id === state.currentListId ? ' active' : '')
        + (VIRTUAL_LISTS[id] ? ' list-tab-virtual' : '');
      tab.setAttribute('data-list-id', id);
      tab.appendChild(document.createTextNode(name + ' '));
      var cnt = document.createElement('span');
      cnt.className = 'list-tab-count';
      cnt.textContent = count;
      tab.appendChild(cnt);
      if (closable) {
        // 重命名入口只出现在当前激活的歌单上：未激活时 tab 空间留给名称与计数，
        // 且单击 tab 会重建整排标签，绑在旧元素上的双击监听并不可靠。
        if (id === state.currentListId) {
          var pen = document.createElement('span');
          pen.className = 'tab-edit'; pen.title = '重命名歌单'; pen.textContent = '✎';
          pen.addEventListener('click', function (e) { e.stopPropagation(); startRenameTab(id, name); });
          tab.appendChild(pen);
        }
        var x = document.createElement('span');
        x.className = 'tab-del'; x.title = '删除歌单'; x.textContent = '✕';
        x.addEventListener('click', function (e) { e.stopPropagation(); removeList(id); });
        tab.appendChild(x);
        tab.title = name + '（点 ✎ 重命名）';
      }
      tab.addEventListener('click', function () { switchList(id); });
      box.appendChild(tab);
    });
    // 保证活动标签留在可视范围内：标签栏可横向滚动，新建的歌单可能落在滚动区外，
    // 那样名号看得见却点不到（连 ✎ / ✕ 都落在相邻面板上）。
    var act = box.querySelector('.list-tab.active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* 歌单内联重命名：回车确认 / Esc 取消 / 失焦确认
   * 注意：不能复用创建标签时的闭包引用 —— renderTabs 会整排重建标签，
   * 闭包里的元素可能已从 DOM 摘除（那样输入框会插到游离节点上，界面毫无反应）。
   * 因此这里按 data-list-id 重新查找当前 DOM 中的标签。 */
  function startRenameTab(id, oldName) {
    var tabEl = document.querySelector('#list-tabs .list-tab[data-list-id="' + id + '"]');
    if (!tabEl) return;
    tabEl.innerHTML = '';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-rename';
    input.value = oldName;
    tabEl.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      var v = input.value.trim();
      if (save && v && v !== oldName) {
        Lib.renameList(id, v);
        toast('歌单已重命名为「' + v + '」');
      }
      renderTabs();
    }
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();   // 不要触发全局快捷键（空格 / 方向键等）
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  function switchList(id) {
    state.currentListId = id;
    Lib.setCurrentList(id);
    clearSelection();
    renderLibrary();
  }
  function removeList(id) {
    var li = Lib.getList(id);
    if (!li) return;
    if (!global.confirm('删除歌单「' + li.name + '」？歌曲不会被移出曲库。')) return;
    Lib.removeList(id);
    if (state.currentListId === id) state.currentListId = 'all';
    renderLibrary();
  }
  function newList() {
    var name = global.prompt('新歌单名称：', '我的歌单');
    if (!name) return;
    var id = Lib.addList(name);
    state.currentListId = id; Lib.setCurrentList(id);
    renderLibrary();
  }

  /* ---------- 播放 / 队列 ---------- */
  function playFromTrack(track) {
    var vis = getVisibleTracks();
    var i = -1;
    for (var k = 0; k < vis.length; k++) { if (vis[k].id === track.id) { i = k; break; } }
    if (i < 0) {
      // 不在当前视图里（例如刚从云端加入的歌）：以它自己为单曲队列播放，避免误播第一首
      CM.Player.setPlaylist([track]);
      CM.Player.loadIndex(0, true);
      renderQueue();
      return;
    }
    CM.Player.setPlaylist(vis);
    CM.Player.loadIndex(i, true);
    renderQueue();
  }
  function addToQueue(track) {
    CM.Player.queuePush(track);
    renderQueue();
    toast('已加入队列');
  }
  function playNext(track) {
    CM.Player.queueInsertNext(track);
    renderQueue();
    toast('将播放下一首');
  }
  function renderQueue() {
    var q = CM.Player.getQueue();
    CM.Queue.render(q, CM.Player.getIndex());
  }
  function clearQueue() {
    CM.Player.pause();
    CM.Player.setPlaylist([]);
    CM.Player.setIndex(-1);
    if (CM.Visualizer && CM.Visualizer.stop) CM.Visualizer.stop();
    renderQueue();
    toast('队列已清空');
  }

  /* ---------- 收藏 / 移除 ---------- */
  function toggleFav(track) {
    var on = Lib.toggleFav(track.id);
    toast(on ? '已收藏 ♥' : '已取消收藏');
    renderLibrary();
  }
  /* 从曲库彻底移除一首歌（本地文件、进度统计、队列位置、远程持久化一并处理）
   * 单曲移除与批量 / 去重共用这一份逻辑，避免三条路径行为不一致。 */
  function dropTrack(track) {
    if (!track) return;
    if (track.source === 'local') {
      CM.Storage.del(track.id).catch(function () {});
      CM.Player.revokeUrl(track.id);
    }
    Lib.removeTrack(track.id);
    CM.Player.clearProgress(track.id);

    var cur = CM.Player.getTrack();
    if (cur && cur.id === track.id) {
      CM.Player.pause();
      var q = CM.Player.getQueue();
      var qi = -1;
      for (var k = 0; k < q.length; k++) { if (q[k].id === track.id) { qi = k; break; } }
      if (qi >= 0) CM.Player.queueRemove(qi);
    }
    if (track.source === 'remote' || track.source === 'online' || track.source === 'cloud') persistRemote();
  }

  function removeTrack(track) {
    dropTrack(track);
    renderLibrary(); renderTabs(); renderQueue();
  }

  /* ---------- 批量多选（5E） ---------- */
  function clearSelection() { state.selected = {}; }

  function selectedTracks() {
    return getVisibleTracks().filter(function (t) { return state.selected[t.id]; });
  }

  function setMulti(on) {
    state.multi = !!on;
    if (!state.multi) clearSelection();
    renderLibrary();
  }

  function toggleSelect(track) {
    if (state.selected[track.id]) delete state.selected[track.id];
    else state.selected[track.id] = true;
    renderLibrary();
  }

  function updateBatchBar() {
    var bar = $('batch-bar');
    var tools = document.querySelector('.lib-tools');
    if (bar) bar.classList.toggle('hidden', !state.multi);
    if (tools) tools.classList.toggle('hidden', state.multi);
    var btn = $('btn-multi');
    if (btn) btn.classList.toggle('active', state.multi);
    var cnt = $('batch-count');
    var n = selectedTracks().length;
    if (cnt) cnt.textContent = '已选 ' + n + ' 首';
  }

  function batchAddToQueue() {
    var list = selectedTracks();
    if (!list.length) { toast('先勾选歌曲'); return; }
    CM.Player.queuePushMany(list);
    renderQueue();
    toast('已加入队列：' + list.length + ' 首');
    setMulti(false);
  }

  function batchAddToList(id) {
    var list = selectedTracks();
    var li = Lib.getList(id);
    if (!list.length || !li) return;
    list.forEach(function (t) { Lib.addToList(id, t.id); });
    renderTabs();
    toast('已把 ' + list.length + ' 首加入「' + li.name + '」');
    setMulti(false);
  }

  function batchRemove() {
    var list = selectedTracks();
    if (!list.length) { toast('先勾选歌曲'); return; }
    if (!global.confirm('从曲库移除选中的 ' + list.length + ' 首歌？（本地上传的文件会一并删除）')) return;
    list.forEach(dropTrack);
    setMulti(false);
    renderLibrary(); renderTabs(); renderQueue();
    toast('已移除 ' + list.length + ' 首');
  }

  /* 批量「加入歌单」的目标选择菜单（复用 add-menu 样式） */
  function openListPicker(x, y) {
    closeAddMenu();
    var lists = Lib.getLists();
    var custom = Object.keys(lists).filter(function (k) { return k !== 'all' && k !== 'fav'; });
    var menu = document.createElement('div');
    menu.className = 'add-menu';
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
    function item(label, fn) {
      var b = document.createElement('button');
      b.className = 'add-menu-item'; b.textContent = label;
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); closeAddMenu(); });
      menu.appendChild(b);
    }
    item('＋ 收藏夹', function () { batchAddToList('fav'); });
    if (!custom.length) item('（无自定义歌单，点歌单栏 ＋ 新建）', function () {});
    custom.forEach(function (id) {
      item('＋ ' + lists[id].name, function () { batchAddToList(id); });
    });
    document.body.appendChild(menu);
    setTimeout(function () { document.addEventListener('click', closeAddMenu, { once: true }); }, 0);
  }

  /* ---------- 排序（5E） ---------- */
  function buildSortSelect() {
    var sel = $('sort-select');
    if (!sel) return;
    sel.innerHTML = '';
    Object.keys(Lib.SORT_MODES).forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      o.textContent = Lib.SORT_MODES[m];
      sel.appendChild(o);
    });
    var saved = null;
    try { saved = localStorage.getItem('cm-sort'); } catch (e) { saved = null; }
    if (saved && Lib.SORT_MODES[saved]) sel.value = saved;
    state.sortMode = sel.value || 'default';
  }

  function changeSort(mode) {
    if (!Lib.SORT_MODES[mode]) mode = 'default';
    state.sortMode = mode;
    try { localStorage.setItem('cm-sort', mode); } catch (e) {}
    clearSelection();
    renderLibrary();
    toast('排序：' + Lib.SORT_MODES[mode]);
  }

  /* ---------- 重复歌曲检测（5E） ---------- */
  var dedupeGroups = [];
  var dedupeKeep = {};

  function sourceLabel(t) {
    return t.source === 'local' ? '💾 本地'
      : t.source === 'cloud' ? '☁️ 云端'
      : t.source === 'sample' ? '🎵 示例'
      : t.source === 'online' ? '🌐 在线' : '🔗 链接';
  }

  function openDedupe() {
    dedupeGroups = Lib.findDuplicates(Lib.resolve(Lib.listIds('all')));
    dedupeKeep = {};
    renderDedupe();
    $('dedupe-modal').classList.remove('hidden');
  }

  function renderDedupe() {
    var box = $('dedupe-list'), sum = $('dedupe-summary');
    if (!box) return;
    box.innerHTML = '';
    if (!dedupeGroups.length) {
      sum.textContent = '没有发现重复歌曲 ✓（按「歌名 + 歌手」判定）';
      return;
    }
    var total = dedupeGroups.reduce(function (n, g) { return n + g.length; }, 0);
    sum.textContent = '发现 ' + dedupeGroups.length + ' 组重复，共 ' + total +
      ' 条；每组默认保留信息最完整的一条，可手动改选。';
    dedupeGroups.forEach(function (g, gi) {
      if (!dedupeKeep[gi]) dedupeKeep[gi] = g[0].id;
      var card = document.createElement('div');
      card.className = 'dedupe-group';
      var head = document.createElement('div');
      head.className = 'dedupe-head';
      head.textContent = (g[0].title || '未知标题') + ' · ' + (g[0].artist || '未知歌手') + '  （' + g.length + ' 条）';
      card.appendChild(head);
      g.forEach(function (t) {
        var row = document.createElement('label');
        row.className = 'dedupe-row' + (dedupeKeep[gi] === t.id ? ' keep' : '');
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'dup-' + gi;
        radio.checked = dedupeKeep[gi] === t.id;
        radio.addEventListener('change', function () { dedupeKeep[gi] = t.id; renderDedupe(); });
        var info = document.createElement('span');
        info.className = 'dedupe-info';
        info.textContent = sourceLabel(t) + ' · ' +
          (t.duration ? fmt(t.duration) : '时长未知') + ' · ' +
          (t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '加入时间未知');
        row.appendChild(radio);
        row.appendChild(info);
        card.appendChild(row);
      });
      box.appendChild(card);
    });
  }

  function applyDedupe() {
    if (!dedupeGroups.length) { toast('没有需要处理的重复歌曲'); return; }
    var victims = [];
    dedupeGroups.forEach(function (g, gi) {
      var keep = dedupeKeep[gi];
      g.forEach(function (t) { if (t.id !== keep) victims.push(t); });
    });
    if (!victims.length) { toast('没有需要删除的条目'); return; }
    if (!global.confirm('删除 ' + victims.length + ' 条重复歌曲？（每组保留选中的那一条）')) return;
    victims.forEach(dropTrack);
    clearSelection();
    renderLibrary(); renderTabs(); renderQueue();
    openDedupe();   // 删除后重新扫描，让弹窗状态与曲库一致
    toast('已删除 ' + victims.length + ' 条重复歌曲');
  }

  /* ---------- 加入歌单菜单 ---------- */
  function closeAddMenu() {
    var m = document.querySelector('.add-menu');
    if (m) m.parentNode.removeChild(m);
  }
  function openAddMenu(track, x, y) {
    closeAddMenu();
    var lists = Lib.getLists();
    var custom = Object.keys(lists).filter(function (k) { return k !== 'all' && k !== 'fav'; });
    var menu = document.createElement('div');
    menu.className = 'add-menu';
    menu.style.left = Math.max(8, x) + 'px';
    menu.style.top = Math.max(8, y) + 'px';
    function item(label, fn) {
      var b = document.createElement('button');
      b.className = 'add-menu-item'; b.textContent = label;
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); closeAddMenu(); });
      menu.appendChild(b);
    }
    item('⤵ 加入队列', function () { addToQueue(track); });
    item('⏭ 下一首播放', function () { playNext(track); });
    if (!custom.length) item('（无自定义歌单，点顶栏 ＋ 新建）', function () {});
    custom.forEach(function (id) {
      item('＋ 加入「' + lists[id].name + '」', function () {
        Lib.addToList(id, track.id);
        renderTabs();
        toast('已加入「' + lists[id].name + '」');
      });
    });
    document.body.appendChild(menu);
    setTimeout(function () { document.addEventListener('click', closeAddMenu, { once: true }); }, 0);
  }

  /* ---------- 歌词 ----------
   * 侧栏歌词与全屏歌词共享同一份渲染结果：每条视图各自持有一组行元素与逐字元素，
   * 这样两处永远同步，也不必让两套 DOM 逻辑各自演化（走偏了很难发现）。
   */
  var lyricViews = [];   // [{ box, lineEls, wordEls }]

  function showLyricsFor(track) {
    state.currentTrackId = track ? track.id : null;
    var raw = (track && (state.lyrics[track.id] || track.lrc)) || '';
    state.currentLines = CM.Lyrics.parse(raw);
    renderLyrics(state.currentLines);
  }

  function lyricContainers() {
    return ['lyrics', 'lyrics-full-box'].map($).filter(function (el) { return !!el; });
  }

  function buildLyricView(box, lines) {
    box.innerHTML = '';
    var lineEls = [], wordEls = [];
    if (!lines.length) {
      var empty = document.createElement('p');
      empty.className = 'lyrics-empty';
      empty.textContent = '暂无歌词。点「🔍 匹配」在线获取，或「✎ 编辑」粘贴 LRC。';
      box.appendChild(empty);
      return { box: box, lineEls: lineEls, wordEls: wordEls };
    }
    lines.forEach(function (l) {
      var p = document.createElement('p');
      p.dataset.time = l.time;
      var main = document.createElement('span');
      main.className = 'lyric-main';
      if (l.words && l.words.length) {
        l.words.forEach(function (w) {
          var s = document.createElement('span');
          s.className = 'w';
          s.textContent = w.w;
          if (w.t != null) s.dataset.t = w.t;
          main.appendChild(s);
        });
      } else {
        main.textContent = l.text;
      }
      p.appendChild(main);
      if (l.sub) {
        var sub = document.createElement('span');
        sub.className = 'lyric-sub';
        sub.textContent = l.sub;
        p.appendChild(sub);
      }
      p.addEventListener('click', function () {
        if (!CM.Player.getTrack()) return;
        CM.Player.seekTo(l.time);
        syncLyrics(l.time); // 立即对齐高亮，不等下一个 timeupdate
      });
      box.appendChild(p);
      lineEls.push(p);
      wordEls.push(Array.prototype.slice.call(p.querySelectorAll('.w')));
    });
    return { box: box, lineEls: lineEls, wordEls: wordEls };
  }

  function renderLyrics(lines) {
    state.currentLines = lines || [];
    lyricViews = lyricContainers().map(function (box) { return buildLyricView(box, state.currentLines); });
    var side = lyricViews[0];
    state.currentLineEls = side ? side.lineEls : [];
    state.currentWordEls = side ? side.wordEls : [];
    var info = $('lyrics-full-info');
    if (info) {
      var t = CM.Player.getTrack();
      info.textContent = t ? ((t.title || '未知标题') + ' · ' + (t.artist || '未知歌手')) : '未在播放';
    }
  }

  function syncLyrics(time) {
    var t = time + state.lyricOffset / 1000;
    var idx = state.currentLines.length ? CM.Lyrics.activeIndex(state.currentLines, t) : -1;
    lyricViews.forEach(function (v) {
      v.lineEls.forEach(function (el, i) { el.classList.toggle('active', i === idx); });
      // 逐字卡拉OK：当前行按绝对时间点亮已唱字
      v.wordEls.forEach(function (arr, i) {
        if (!arr.length) return;
        var on = (i === idx);
        arr.forEach(function (sp) {
          var wt = sp.dataset.t;
          if (wt == null) { sp.classList.toggle('sung', on); return; }
          sp.classList.toggle('sung', on && parseFloat(wt) <= t);
        });
      });
      // 只滚动可见的那份（隐藏容器 clientHeight 为 0）
      if (idx >= 0 && v.box.clientHeight > 0) {
        var a = v.lineEls[idx];
        if (a && a.scrollIntoView) a.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    updateDesktopLyrics(idx);
  }

  /* ---------- 全屏沉浸歌词与字号（5F） ---------- */
  // 字号与行距联动：小字配宽行距（读词更松），大字收紧（避免一屏只放两行）
  var LYRIC_SCALES = [
    { size: 13, lh: 2.5 },
    { size: 15, lh: 2.3 },
    { size: 18, lh: 2.1 },
    { size: 22, lh: 1.9 },
    { size: 28, lh: 1.7 }
  ];
  var lyricScale = 1;

  function applyLyricScale() {
    var s = LYRIC_SCALES[lyricScale] || LYRIC_SCALES[1];
    document.documentElement.style.setProperty('--lyric-size', s.size + 'px');
    document.documentElement.style.setProperty('--lyric-lh', String(s.lh));
    try { localStorage.setItem('cm-lyric-scale', String(lyricScale)); } catch (e) {}
  }

  function changeLyricScale(delta) {
    var next = Math.max(0, Math.min(LYRIC_SCALES.length - 1, lyricScale + delta));
    if (next === lyricScale) { toast('已经是' + (delta > 0 ? '最大' : '最小') + '字号'); return; }
    lyricScale = next;
    applyLyricScale();
    var s = LYRIC_SCALES[lyricScale];
    toast('歌词字号：' + s.size + 'px');
    syncLyrics(CM.Player.getCurrentTime());
  }

  function loadLyricScale() {
    try {
      var v = parseInt(localStorage.getItem('cm-lyric-scale'), 10);
      if (isFinite(v) && v >= 0 && v < LYRIC_SCALES.length) lyricScale = v;
    } catch (e) {}
    applyLyricScale();
  }

  function isFullLyricsOpen() {
    var el = $('lyrics-full');
    return !!el && !el.classList.contains('hidden');
  }

  function openFullLyrics() {
    var el = $('lyrics-full');
    if (!el) return;
    renderLyrics(state.currentLines);   // 重建两份视图，保证与当前曲目一致
    el.classList.remove('hidden');
    document.body.classList.add('no-scroll');
    syncLyrics(CM.Player.getCurrentTime());
  }

  function closeFullLyrics() {
    var el = $('lyrics-full');
    if (!el) return;
    el.classList.add('hidden');
    document.body.classList.remove('no-scroll');
    renderLyrics(state.currentLines);
  }

  function toggleFullLyrics() {
    if (isFullLyricsOpen()) closeFullLyrics();
    else openFullLyrics();
  }

  /* ---------- 歌词导出（5F） ---------- */
  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = global.URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { global.URL.revokeObjectURL(a.href); }, 1000);
  }

  function exportLrc() {
    var t = CM.Player.getTrack();
    var raw = t ? (state.lyrics[t.id] || t.lrc || '') : '';
    if (!raw.trim()) { toast('当前歌曲没有歌词可导出'); return; }
    var base = ((t.artist ? t.artist + ' - ' : '') + (t.title || '歌词')).replace(/[\\/:*?"<>|]/g, '_');
    downloadText(base + '.lrc', raw, 'text/plain;charset=utf-8');
    // 纯文本歌词（无时间标签）导出的 .lrc 在播放器里无法同步滚动，提示但不阻断
    if (!/\[\d{1,3}:\d{2}/.test(raw)) toast('已导出 ' + base + '.lrc（无时间轴，播放器可能无法自动滚动）');
    else toast('已导出 ' + base + '.lrc');
  }

  /* ---------- 可视化模式与全屏（5F） ---------- */
  function updateVizButton() {
    var b = $('btn-viz-mode');
    if (!b) return;
    var m = CM.Visualizer.getMode();
    b.textContent = CM.Visualizer.MODE_ICONS[m] || '📊';
    b.title = '可视化模式：' + (CM.Visualizer.MODE_LABELS[m] || m) + '（点击切换）';
  }

  function initVizMode() {
    var m = null;
    try { m = localStorage.getItem('cm-viz'); } catch (e) { m = null; }
    if (m && CM.Visualizer.MODE_ORDER.indexOf(m) >= 0) CM.Visualizer.setMode(m);
    updateVizButton();
  }

  function cycleVizMode() {
    var m = CM.Visualizer.nextMode();
    try { localStorage.setItem('cm-viz', m); } catch (e) {}
    updateVizButton();
    toast('可视化：' + (CM.Visualizer.MODE_LABELS[m] || m));
  }

  function isVizFull() {
    var w = document.querySelector('.cover-wrap');
    return !!w && w.classList.contains('viz-fs');
  }

  function toggleVizFull() {
    var wrap = document.querySelector('.cover-wrap');
    if (!wrap) return;
    var on = wrap.classList.toggle('viz-fs');
    var b = $('btn-viz-full');
    if (b) b.textContent = on ? '⤡' : '⛶';
    document.body.classList.toggle('no-scroll', on);
    // 布局切换后画布尺寸会变，等两帧再取一次尺寸，避免首帧按旧尺寸渲染
    setTimeout(function () { CM.Visualizer.resize(); }, 60);
    setTimeout(function () { CM.Visualizer.resize(); }, 280);
  }

  function updateDesktopLyrics(idx) {
    var el = $('desktop-lyrics');
    if (!el) return;
    if (!state.deskLyricsOn) { el.classList.add('hidden'); el._idx = -1; return; }
    var line = state.currentLines[idx];
    if (!line) {
      // 无歌词 / 未播放时也保留提示条，让「开启桌面歌词」有可见反馈
      if (el._idx !== -1) { el.innerHTML = '<span class="dl-main">♪ 桌面歌词已开启</span>'; el._words = []; el._idx = -1; }
      el.classList.remove('hidden');
      return;
    }
    var t = (CM.Player.getCurrentTime ? CM.Player.getCurrentTime() : 0) + state.lyricOffset / 1000;
    if (el._idx !== idx) {
      el.classList.remove('hidden');
      el.innerHTML = '';
      if (line.words && line.words.length) {
        var wrap = document.createElement('span'); wrap.className = 'dl-main';
        line.words.forEach(function (w) {
          var s = document.createElement('span'); s.className = 'w'; s.textContent = w.w;
          if (w.t != null) s.dataset.t = w.t;
          wrap.appendChild(s);
        });
        el.appendChild(wrap);
      } else {
        var main = document.createElement('span'); main.className = 'dl-main';
        main.textContent = line.text;
        el.appendChild(main);
      }
      if (line.sub) {
        var sub = document.createElement('span'); sub.className = 'dl-sub';
        sub.textContent = line.sub;
        el.appendChild(sub);
      }
      el._words = Array.prototype.slice.call(el.querySelectorAll('.w'));
      el._idx = idx;
    }
    if (el._words && el._words.length) {
      el._words.forEach(function (sp) {
        var wt = sp.dataset.t;
        if (wt == null) return;
        sp.classList.toggle('sung', parseFloat(wt) <= t);
      });
    }
  }

  /* ---------- 在线曲目播放失败兜底 ---------- */
  function skipOnline() {
    var now = Date.now();
    if (now - onlineSkip.since > 60000) { onlineSkip.count = 0; onlineSkip.since = now; }
    onlineSkip.count++;
    if (onlineSkip.count > 3) {
      CM.Player.pause();
      toast('多个在线曲目无法播放，已停止自动跳过，请检查曲库');
      return;
    }
    toast('在线曲目不可播放（可能已失效）：' + ((CM.Player.getTrack() || {}).title || '') + '，已自动跳过');
    setTimeout(function () { CM.Player.next(); }, 700);
  }
  /* ---------- 歌词匹配（多来源候选，手动选择） ---------- */
  var matchCands = [];
  function openMatchModal() {
    var track = CM.Player.getTrack();
    if (!track) { toast('请先选择一首歌'); return; }
    $('match-modal').classList.remove('hidden');
    var q = $('match-query');
    var kw = ((track.title || '') + ' ' + (track.artist || '')).trim();
    if (q && !q.value.trim()) q.value = kw;
    searchMatch();
    setTimeout(function () { if (q) q.focus(); }, 0);
  }
  function closeMatchModal() {
    $('match-modal').classList.add('hidden');
    $('match-results').innerHTML = '';
    $('match-status').textContent = '';
    matchCands = [];
  }
  function searchMatch() {
    var q = $('match-query').value.trim();
    var st = $('match-status');
    if (!q) { toast('请输入歌名 / 歌手'); return; }
    st.textContent = '正在搜索候选（GD Studio + LRCLIB）…';
    $('match-results').innerHTML = '';
    matchCands = [];
    CM.Lyrics.searchCandidates(q).then(function (list) {
      matchCands = list || [];
      renderMatchResults();
      st.textContent = matchCands.length
        ? ('找到 ' + matchCands.length + ' 条候选，点击即可应用')
        : '没有找到候选，换个关键词试试';
    }).catch(function (e) {
      st.textContent = '搜索失败：' + (e && e.message ? e.message : '网络受限');
    });
  }
  function renderMatchResults() {
    var box = $('match-results');
    box.innerHTML = '';
    if (!matchCands.length) {
      var p = document.createElement('p');
      p.className = 'online-empty';
      p.textContent = '暂无候选';
      box.appendChild(p);
      return;
    }
    matchCands.forEach(function (c, idx) {
      var row = document.createElement('div');
      row.className = 'online-item match-item';
      var icon = document.createElement('div');
      icon.className = 'online-cover';
      icon.textContent = '♪';
      row.appendChild(icon);
      var meta = document.createElement('div');
      meta.className = 'online-meta';
      var tt = document.createElement('div'); tt.className = 'online-title'; tt.textContent = c.title;
      var ar = document.createElement('div'); ar.className = 'online-artist';
      ar.textContent = (c.artist || '未知艺术家') + (c.album ? ' · ' + c.album : '');
      meta.appendChild(tt); meta.appendChild(ar);
      row.appendChild(meta);
      var src = document.createElement('span');
      src.className = 'match-src';
      src.textContent = c.provLabel || c.prov;
      row.appendChild(src);
      row.addEventListener('click', function () { applyMatchCandidate(idx); });
      box.appendChild(row);
    });
  }
  function applyMatchCandidate(idx) {
    var track = CM.Player.getTrack();
    var c = matchCands[idx];
    if (!track || !c) return;
    var st = $('match-status');
    st.textContent = '正在获取歌词：' + c.title + '…';
    CM.Lyrics.fetchCandidate(c).then(function (lrc) {
      if (!lrc) throw new Error('无歌词数据');
      state.lyrics[track.id] = lrc; saveLyrics();
      track.lrc = lrc;
      showLyricsFor(track);
      closeMatchModal();
      toast('已应用歌词：' + c.title + '（' + (c.provLabel || c.prov) + '）');
    }).catch(function (e) {
      st.textContent = '获取失败：' + (e && e.message ? e.message : '网络受限');
    });
  }

  /* ---------- 播放统计 ---------- */
  var SOURCE_LABEL = { local: '本地上传', remote: '远程链接', online: '在线音乐', sample: '示例曲' };

  function fmtLong(sec) {
    sec = Math.round(sec || 0);
    if (!sec) return '0 分钟';
    var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    if (h && m) return h + ' 小时 ' + m + ' 分';
    if (h) return h + ' 小时';
    return m + ' 分钟';
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function renderStats() {
    var box = $('stats-body');
    if (!box) return;
    box.innerHTML = '';

    var all = Lib.resolve(Lib.listIds('all'));
    var bySource = {}, totalSec = 0;
    all.forEach(function (t) {
      var k = t.source || 'other';
      bySource[k] = (bySource[k] || 0) + 1;
      if (t.duration) totalSec += t.duration;
    });
    var stats = (CM.Player.getStats && CM.Player.getStats()) || {};
    var heard = Object.keys(stats);
    var plays = 0;
    heard.forEach(function (k) { plays += stats[k].c || 0; });

    var cards = el('div', 'stats-cards');
    [['曲目总数', String(all.length)], ['总时长', fmtLong(totalSec)],
     ['累计播放', plays + ' 次'], ['听过的歌', heard.length + ' 首']].forEach(function (pair) {
      var c = el('div', 'stat-card');
      c.appendChild(el('span', 'stat-num', pair[1]));
      c.appendChild(el('span', 'stat-label', pair[0]));
      cards.appendChild(c);
    });
    box.appendChild(cards);

    var srcBox = el('div', 'stats-section');
    srcBox.appendChild(el('h4', null, '来源分布'));
    var srcKeys = Object.keys(bySource);
    if (srcKeys.length) {
      var total = all.length || 1;
      srcKeys.forEach(function (k) {
        var row = el('div', 'stat-bar-row');
        row.appendChild(el('span', 'stat-bar-name', SOURCE_LABEL[k] || k));
        var track = el('div', 'stat-bar-track');
        var fill = el('div', 'stat-bar-fill');
        fill.style.width = Math.max(2, Math.round((bySource[k] / total) * 100)) + '%';
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'stat-bar-val', bySource[k] + ' 首'));
        srcBox.appendChild(row);
      });
    } else {
      srcBox.appendChild(el('p', 'empty-hint', '曲库还没有歌曲'));
    }
    box.appendChild(srcBox);

    var rankBox = el('div', 'stats-section');
    rankBox.appendChild(el('h4', null, '播放排行 Top 10'));
    var ranked = all.filter(function (t) { return stats[t.id]; })
      .sort(function (a, b) { return stats[b.id].c - stats[a.id].c; })
      .slice(0, 10);
    if (ranked.length) {
      var ul = el('ul', 'stat-rank');
      ranked.forEach(function (t, i) {
        var li = el('li', 'stat-rank-item');
        li.appendChild(el('span', 'stat-rank-no', String(i + 1)));
        var meta = el('span', 'stat-rank-meta');
        meta.appendChild(el('span', 'stat-rank-title', t.title || '未知标题'));
        meta.appendChild(el('span', 'stat-rank-artist', t.artist || '未知歌手'));
        li.appendChild(meta);
        li.appendChild(el('span', 'stat-rank-count', stats[t.id].c + ' 次'));
        ul.appendChild(li);
      });
      rankBox.appendChild(ul);
    } else {
      rankBox.appendChild(el('p', 'empty-hint', '还没有播放记录，听几首就有数据了'));
    }
    box.appendChild(rankBox);
  }

  function openStats() { renderStats(); $('stats-modal').classList.remove('hidden'); }

  /* ---------- 云端（Cloudflare Pages Functions + R2） ---------- */
  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function cloudStatus(msg, isErr) {
    var bar = $('cloud-status');
    if (!bar) return;
    bar.textContent = msg || '';
    bar.classList.toggle('cloud-err', !!isErr);
  }
  // 把云端失败翻译成「下一步该做什么」，避免只甩一个 HTTP 状态码
  function cloudHintFor(e) {
    var status = e && e.status;
    if (status === 404) return '（本地静态服务器没有 /api 端点，需部署到 Cloudflare Pages）';
    if (status === 401) return '（口令不合法，需 ≥10 位）';
    if (status === 503) return '（云端 R2 绑定未生效，检查 Pages 项目的 MUSIC_BUCKET 绑定）';
    if (status === 413) return '（文件超出单次上传上限）';
    if (!status) return '（网络不可达或不是 Pages 环境）';
    return '';
  }
  function cloudSpaceLabel() {
    var lbl = $('cloud-space');
    if (!lbl) return;
    if (!CM.Cloud.hasPass()) { lbl.textContent = '未设置口令'; return; }
    var slug = CM.Cloud.getSlug();
    var last = CM.Cloud.getLastSync();
    lbl.textContent = '空间 ' + (slug ? slug.slice(0, 8) + '…' : '（待连接）') +
      (last ? ' · 上次同步 ' + new Date(last).toLocaleString() : '');
  }

  function openCloud() {
    $('cloud-modal').classList.remove('hidden');
    var input = $('cloud-pass');
    if (input && !input.value) input.value = CM.Cloud.getPass();
    cloudSpaceLabel();
    if (!CM.Cloud.hasPass()) { cloudStatus('先设置口令（≥10 位），点「保存」连接云端'); return; }
    cloudStatus('正在连接云端…');
    CM.Cloud.ping().then(function (d) {
      if (!d.ok) { cloudStatus('云端未就绪：' + (d.reason || 'R2 绑定不可用'), true); return; }
      cloudStatus('已连接 · 云端曲目 ' + (d.cloudTracks || 0) + ' 首');
      cloudSpaceLabel();
      return cloudRefreshList();
    }).catch(function (e) {
      cloudStatus('云端不可用：' + e.message + cloudHintFor(e), true);
    });
  }
  function closeCloud() { $('cloud-modal').classList.add('hidden'); }

  function cloudSavePass() {
    var v = ($('cloud-pass').value || '').trim();
    var problem = CM.Cloud.passProblem(v);
    if (problem) { cloudStatus(problem, true); toast(problem); return; }
    CM.Cloud.setPass(v);
    cloudSpaceLabel();
    cloudStatus('口令已保存，正在连接…');
    CM.Cloud.ping().then(function (d) {
      if (!d.ok) { cloudStatus('云端未就绪：' + (d.reason || 'R2 绑定不可用'), true); return; }
      cloudStatus('已连接 · 云端曲目 ' + (d.cloudTracks || 0) + ' 首');
      cloudSpaceLabel();
      return cloudRefreshList();
    }).catch(function (e) {
      cloudStatus('连接失败：' + e.message + cloudHintFor(e), true);
    });
  }

  function cloudGenPass() {
    $('cloud-pass').value = CM.Cloud.randomPass();
    $('cloud-pass').type = 'text';
    $('cloud-pass-show').checked = true;
    toast('已生成随机口令，请抄下来保存');
  }

  function cloudRefreshList() {
    if (!CM.Cloud.hasPass()) return Promise.resolve();
    cloudStatus('正在读取云端曲库…');
    return CM.Cloud.listCloud().then(function (d) {
      renderCloudList((d && d.items) || []);
      cloudStatus('云端曲库 ' + ((d && d.count) || 0) + ' 首' + (d && d.truncated ? '（仅显示前 1000 首）' : ''));
      cloudSpaceLabel();
    }).catch(function (e) {
      cloudStatus('读取失败：' + e.message + cloudHintFor(e), true);
    });
  }

  function renderCloudList(items) {
    var box = $('cloud-list');
    if (!box) return;
    box.innerHTML = '';
    if (!items.length) {
      var hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = CM.Cloud.hasPass()
        ? '云端还没有歌曲。点上方「⤴ 本地歌曲上传到云端」把本机上传输的音频传上去。'
        : '先设置口令。';
      box.appendChild(hint);
      return;
    }
    items.sort(function (a, b) { return (b.uploaded || 0) - (a.uploaded || 0); });
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'cloud-item';

      var info = document.createElement('div');
      info.className = 'cloud-item-info';
      var title = document.createElement('div');
      title.className = 'cloud-item-title';
      title.textContent = it.title || it.id;
      var sub = document.createElement('div');
      sub.className = 'cloud-item-sub';
      sub.textContent = (it.artist ? it.artist + ' · ' : '') + fmtSize(it.size) + (it.ext ? ' · ' + it.ext : '');
      info.appendChild(title); info.appendChild(sub);

      var playBtn = document.createElement('button');
      playBtn.className = 'chip'; playBtn.title = '播放'; playBtn.textContent = '▶';
      playBtn.addEventListener('click', function () { playCloudItem(it); });

      var addBtn = document.createElement('button');
      addBtn.className = 'chip'; addBtn.title = '加入曲库'; addBtn.textContent = '＋';
      addBtn.addEventListener('click', function () { addCloudTrack(it, false); });

      var delBtn = document.createElement('button');
      delBtn.className = 'chip'; delBtn.title = '从云端删除'; delBtn.textContent = '🗑';
      delBtn.addEventListener('click', function () {
        if (!global.confirm('从云端删除「' + (it.title || it.id) + '」？此操作不可恢复。')) return;
        CM.Cloud.removeCloud(it.id).then(function () {
          toast('已从云端删除');
          cloudRefreshList();
        }).catch(function (e) { cloudStatus('删除失败：' + e.message, true); });
      });

      row.appendChild(info); row.appendChild(playBtn); row.appendChild(addBtn); row.appendChild(delBtn);
      box.appendChild(row);
    });
  }

  function cloudRecordOf(item) {
    return {
      id: 'cloud-' + item.id,
      title: item.title || item.id,
      artist: item.artist || '云端',
      url: CM.Cloud.playUrl(item.id),
      cover: pickCover('cloud-' + item.id),
      album: '',
      duration: 0,
      source: 'cloud',
      cloudId: item.id,
      addedAt: Date.now()
    };
  }
  function addCloudTrack(item, play) {
    var rec = Lib.get('cloud-' + item.id) || cloudRecordOf(item);
    Lib.addTrack(rec);
    persistRemote();
    renderLibrary(); renderTabs(); renderQueue();
    toast('已加入曲库：' + rec.title);
    if (play) playFromTrack(rec);
    return rec;
  }
  function playCloudItem(item) {
    var rec = Lib.get('cloud-' + item.id);
    if (!rec) rec = addCloudTrack(item, false);
    playFromTrack(rec);
  }

  function cloudUploadAll() {
    if (!CM.Cloud.hasPass()) { toast('请先设置并保存口令'); return; }
    var locals = Lib.allTracks().filter(function (t) { return t.source === 'local' && t.file; });
    if (!locals.length) { toast('没有可上传的本地歌曲（只有本机上传输的音频能传到云端）'); return; }
    if (!global.confirm('将 ' + locals.length + ' 首本地歌曲上传到云端？大文件较慢，请保持页面打开。')) return;

    var i = 0, ok = 0, fail = 0;
    cloudStatus('上传中… 0/' + locals.length);
    (function next() {
      if (i >= locals.length) {
        cloudStatus('上传完成：成功 ' + ok + ' 首' + (fail ? '，失败 ' + fail + ' 首' : ''));
        toast('云端上传完成：' + ok + ' 首');
        cloudRefreshList();
        return;
      }
      var t = locals[i++];
      CM.Cloud.uploadFile(t.file, { id: t.id, title: t.title, artist: t.artist })
        .then(function () { ok++; })
        .catch(function () { fail++; })
        .then(function () {
          cloudStatus('上传中… ' + i + '/' + locals.length);
          next();
        });
    })();
  }

  function collectCloudState() {
    var lists = Lib.getLists();
    return {
      lists: Object.keys(lists).map(function (k) {
        return { id: k, name: lists[k].name, ids: (lists[k].ids || []).slice() };
      }),
      remote: Lib.allTracks().filter(function (t) {
        return t.source === 'remote' || t.source === 'online' || t.source === 'cloud';
      }).map(function (t) {
        var o = {
          id: t.id, title: t.title, artist: t.artist, url: t.url,
          cover: t.cover, album: t.album, duration: t.duration,
          source: t.source, addedAt: t.addedAt
        };
        ['sid', 'oid', 'lid', 'lsrc', 'pid', 'gsub', 'cloudId', 'preview'].forEach(function (k) {
          if (t[k] !== undefined) o[k] = t[k];
        });
        return o;
      }),
      lyrics: state.lyrics,
      settings: {
        theme: document.documentElement.getAttribute('data-theme'),
        volume: (+$('volume').value) / 100,
        eq: CM.Player.getEQ()
      },
      stats: CM.Player.getStats(),
      progress: CM.Player.getProgress(),
      device: (global.navigator && navigator.userAgent ? navigator.userAgent : '').slice(0, 60),
      updatedAt: Date.now()
    };
  }

  function applyCloudState(st) {
    var listCount = 0;
    if (Array.isArray(st.lists) && st.lists.length) {
      var merged = {};
      st.lists.forEach(function (l) {
        if (!l || !l.id) return;
        merged[l.id] = { name: l.name || l.id, ids: Array.isArray(l.ids) ? l.ids : [] };
      });
      Lib.setLists(merged);
      listCount = Object.keys(merged).length;
    }
    if (Array.isArray(st.remote) && st.remote.length) {
      st.remote.forEach(function (t) { if (t && t.id) Lib.addTrack(t); });
      persistRemote();
    }
    if (st.lyrics && typeof st.lyrics === 'object') {
      Object.keys(st.lyrics).forEach(function (k) { state.lyrics[k] = st.lyrics[k]; });
      saveLyrics();
    }
    if (st.stats && CM.Player.setStats) CM.Player.setStats(st.stats);
    if (st.progress && CM.Player.setProgress) CM.Player.setProgress(st.progress);
    if (st.settings) applySettings(st.settings);
    return listCount;
  }

  function cloudSyncUp() {
    if (!CM.Cloud.hasPass()) { toast('请先设置并保存口令'); return; }
    cloudStatus('正在上传歌单与设置…');
    CM.Cloud.pushState(collectCloudState()).then(function (d) {
      var kb = Math.max(1, Math.round(((d && d.bytes) || 0) / 1024));
      cloudStatus('已存到云端（' + kb + ' KB）· ' + new Date().toLocaleString());
      cloudSpaceLabel();
      toast('歌单与设置已存到云端');
    }).catch(function (e) {
      cloudStatus('保存失败：' + e.message + cloudHintFor(e), true);
    });
  }

  function cloudSyncDown() {
    if (!CM.Cloud.hasPass()) { toast('请先设置并保存口令'); return; }
    if (!global.confirm('从云端恢复会把云端的歌单 / 远程曲目 / 歌词 / 设置合并到本机（本地上传的音频文件不受影响），继续？')) return;
    cloudStatus('正在读取云端备份…');
    CM.Cloud.pullState().then(function (d) {
      if (!d || d.empty || !d.state) { cloudStatus('云端还没有备份，先点「⤒ 歌单与设置存到云端」'); return; }
      var n = applyCloudState(d.state);
      renderLibrary(); renderTabs(); renderQueue();
      cloudStatus('已从云端恢复（' + n + ' 个歌单）· ' + new Date(d.updatedAt).toLocaleString());
      toast('已从云端恢复');
    }).catch(function (e) {
      cloudStatus('恢复失败：' + e.message + cloudHintFor(e), true);
    });
  }

  /* ---------- 主题 ---------- */
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('cm-theme', cur); } catch (e) {}
    $('btn-theme').textContent = cur === 'dark' ? '☀️' : '🌙';
    if (CM.Visualizer) CM.Visualizer.resize();
  }

  /* ---------- 侧栏切换（歌词 / 队列） ---------- */
  function showSide(which) {
    state.lyricsVisible = (which === 'lyrics');
    $('lyrics-view').classList.toggle('hidden', which !== 'lyrics');
    $('queue-view').classList.toggle('hidden', which !== 'queue');
    document.querySelectorAll('.panel-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-panel') === which);
    });
    // 「词」按钮随面板状态高亮
    var lb = $('btn-lyrics');
    if (lb) lb.classList.toggle('active', which === 'lyrics');
    // 切到歌词面板时立即按当前播放进度对齐，避免停顿后才更新
    if (state.lyricsVisible) syncLyrics(CM.Player.getCurrentTime ? CM.Player.getCurrentTime() : 0);
  }

  /* ---------- 音效：十段均衡器 ---------- */
  var eqInputs = [];
  var PRESET_LABELS = { flat: '平坦', pop: '流行', rock: '摇滚', classical: '古典', vocal: '人声', bass: '低音增强' };

  function fmtFreq(f) { return f >= 1000 ? (f / 1000) + 'k' : String(f); }

  function buildEqBand() {
    var box = $('eq-band');
    if (!box) return;
    box.innerHTML = '';
    eqInputs = [];
    CM.Player.EQ_FREQS.forEach(function (f, i) {
      var cell = document.createElement('div');
      cell.className = 'eq-cell';
      var gain = document.createElement('span');
      gain.className = 'eq-gain';
      gain.textContent = '0';
      var input = document.createElement('input');
      input.type = 'range';
      input.min = '-12'; input.max = '12'; input.step = '1'; input.value = '0';
      input.className = 'eq-slider-v';
      input.setAttribute('data-index', String(i));
      input.setAttribute('aria-label', fmtFreq(f) + ' Hz 增益');
      input.addEventListener('input', applyEQ);
      var freq = document.createElement('label');
      freq.className = 'eq-freq';
      freq.textContent = fmtFreq(f);
      cell.appendChild(gain); cell.appendChild(input); cell.appendChild(freq);
      box.appendChild(cell);
      eqInputs.push(input);
    });
  }

  function buildEqPresets() {
    var box = $('eq-presets');
    if (!box) return;
    box.innerHTML = '';
    Object.keys(CM.Player.EQ_PRESETS).forEach(function (name) {
      var b = document.createElement('button');
      b.className = 'chip eq-preset';
      b.setAttribute('data-preset', name);
      b.textContent = PRESET_LABELS[name] || name;
      b.addEventListener('click', function () { applyPreset(name); });
      box.appendChild(b);
    });
  }

  function setEqValues(gains) {
    if (!eqInputs.length) return;
    eqInputs.forEach(function (input, i) { input.value = String(gains[i] || 0); });
  }

  function applyEQ() {
    if (!eqInputs.length) return;
    var g = eqInputs.map(function (input) { return +input.value; });
    CM.Player.setEQ(g);
    eqInputs.forEach(function (input) {
      var v = +input.value;
      var lab = input.parentNode && input.parentNode.querySelector('.eq-gain');
      if (lab) {
        lab.textContent = (v > 0 ? '+' : '') + v;
        lab.classList.toggle('up', v > 0);
      }
    });
    try { localStorage.setItem('cm-eq', JSON.stringify(g)); } catch (e) {}
    markEqPreset(g);
  }

  function presetOf(g) {
    var names = Object.keys(CM.Player.EQ_PRESETS);
    for (var i = 0; i < names.length; i++) {
      var p = CM.Player.EQ_PRESETS[names[i]];
      var same = true;
      for (var k = 0; k < p.length; k++) { if (p[k] !== g[k]) { same = false; break; } }
      if (same) return names[i];
    }
    return null;
  }

  function markEqPreset(g) {
    var name = presetOf(g);
    document.querySelectorAll('.eq-preset').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-preset') === name);
    });
    var cur = $('eq-current');
    if (cur) cur.textContent = name ? (PRESET_LABELS[name] || name) : '自定义';
  }

  function applyPreset(name) {
    var g = CM.Player.EQ_PRESETS[name];
    if (!g) return;
    setEqValues(g);
    applyEQ();
    toast('音效预设：' + (PRESET_LABELS[name] || name));
  }

  function loadEQ() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem('cm-eq') || 'null'); } catch (e) { raw = null; }
    // 旧版三段数据由 normalizeEQ 映射到十段，升级不清空用户设置
    var g = CM.Player.normalizeEQ(raw) || CM.Player.EQ_PRESETS.flat.slice();
    setEqValues(g);
    applyEQ();
  }

  /* ---------- 音效：播放引擎开关（交叉淡入淡出 / 响度均衡 / 变速不变调） ---------- */
  function markCrossfade(v) {
    var lab = $('fx-crossfade-val');
    if (lab) lab.textContent = v > 0 ? v + 's' : '关闭';
  }

  function syncEngineSwitches() {
    var l = $('fx-loudness'); if (l) l.checked = CM.Player.getLoudness();
    var p = $('fx-keep-pitch'); if (p) p.checked = CM.Player.getKeepPitch();
    var r = $('rate-keep-pitch'); if (r) r.checked = CM.Player.getKeepPitch();
  }

  function initFxUI() {
    var cf = $('fx-crossfade');
    if (cf) {
      var v = CM.Player.getCrossfade();
      cf.value = String(v);
      markCrossfade(v);
    }
    syncEngineSwitches();
  }

  function openFx() { initFxUI(); $('fx-modal').classList.remove('hidden'); }

  /* ---------- AB 段循环 ---------- */
  function updateAbBand(ab) {
    var band = $('ab-band');
    if (!band) return;
    var dur = CM.Player.getActiveDuration();
    if (!ab.on || !(dur > 0)) { band.classList.add('hidden'); return; }
    var left = Math.max(0, Math.min(100, (ab.a / dur) * 100));
    var right = Math.max(left, Math.min(100, (ab.b / dur) * 100));
    band.classList.remove('hidden');
    band.style.left = left + '%';
    band.style.width = (right - left) + '%';
  }

  function updateAbUI() {
    var ab = CM.Player.getAb();
    var a = $('btn-ab-a'), b = $('btn-ab-b'), c = $('btn-ab-clear'), lab = $('ab-label');
    if (a) a.classList.toggle('active', ab.a != null);
    if (b) b.classList.toggle('active', ab.b != null);
    if (c) c.classList.toggle('active', ab.on);
    if (lab) {
      if (ab.on) lab.textContent = fmt(ab.a) + ' – ' + fmt(ab.b) + ' 循环中';
      else if (ab.a != null) lab.textContent = 'A = ' + fmt(ab.a) + '，待设 B';
      else lab.textContent = 'AB 未设置';
    }
    updateAbBand(ab);
  }

  /* ---------- 倍速 / 睡眠定时 / 桌面歌词 / 偏移 ---------- */
  function restorePlaybackPrefs() {
    try {
      var r = parseFloat(localStorage.getItem('cm-rate'));
      if (r && r !== 1) { CM.Player.setRate(r); markRate(r); }
    } catch (e) {}
    try {
      var s = localStorage.getItem('cm-sleep');
      if (s === 'trackEnd') setSleep('trackEnd', true);
      else if (s) {
        var exp = +s;
        if (exp > Date.now()) setSleep(String(Math.round((exp - Date.now()) / 60000)), true);
        else localStorage.removeItem('cm-sleep');
      }
    } catch (e) {}
    try {
      if (localStorage.getItem('cm-desk-lyrics') === '1') {
        state.deskLyricsOn = true;
        var db = $('btn-desktop-lyrics'); if (db) db.classList.add('active');
      }
    } catch (e) {}
    try {
      var o = parseInt(localStorage.getItem('cm-lyric-offset') || '0', 10) || 0;
      state.lyricOffset = o;
      var lo = $('lyric-offset');
      if (lo) { lo.value = o; $('lyric-offset-val').textContent = (o / 1000).toFixed(1) + 's'; }
    } catch (e) {}
  }
  function markRate(r) {
    document.querySelectorAll('.rate-opt').forEach(function (b) {
      b.classList.toggle('active', parseFloat(b.getAttribute('data-rate')) === r);
    });
  }
  function setSleep(mode, silent) {
    if (state.sleepTimer) { clearTimeout(state.sleepTimer); state.sleepTimer = null; }
    try { localStorage.removeItem('cm-sleep'); } catch (e) {}
    state.sleepMode = null;
    CM.Player.setStopAfterCurrent(false);
    if (mode === 'off' || mode === '' || mode == null) {
      markSleep('off');
      if (!silent) toast('已关闭睡眠定时');
      return;
    }
    if (mode === 'trackEnd') {
      state.sleepMode = 'trackEnd';
      CM.Player.setStopAfterCurrent(true);
      try { localStorage.setItem('cm-sleep', 'trackEnd'); } catch (e) {}
      markSleep('trackEnd');
      if (!silent) toast('睡眠定时：本曲播完停止');
      return;
    }
    var mins = parseInt(mode, 10);
    if (!mins) return;
    var ms = mins * 60 * 1000, exp = Date.now() + ms;
    state.sleepMode = exp;
    try { localStorage.setItem('cm-sleep', String(exp)); } catch (e) {}
    state.sleepTimer = setTimeout(function () {
      CM.Player.pause();
      state.sleepMode = null;
      try { localStorage.removeItem('cm-sleep'); } catch (e) {}
      toast('睡眠定时：已停止播放');
    }, ms);
    markSleep(String(mins));
    if (!silent) toast('睡眠定时：' + mins + ' 分钟后停止');
  }
  function markSleep(mode) {
    document.querySelectorAll('.sleep-opt').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-min') === String(mode));
    });
  }

  /* ---------- 添加链接 ---------- */
  function openUrlModal() { $('url-modal').classList.remove('hidden'); }
  function closeUrlModal() {
    $('url-modal').classList.add('hidden');
    $('url-input').value = ''; $('url-title').value = ''; $('url-artist').value = ''; $('url-lrc').value = '';
  }
  function submitUrl() {
    var url = $('url-input').value.trim();
    if (!url) { toast('请填写歌曲链接'); return; }
    var id = 'remote-' + Date.now();
    var rec = {
      id: id,
      title: $('url-title').value.trim() || url.split('/').pop().split('?')[0] || '远程歌曲',
      artist: $('url-artist').value.trim() || '未知歌手',
      url: url, cover: pickCover(id), source: 'remote', addedAt: Date.now()
    };
    var lrcUrl = $('url-lrc').value.trim();
    function finish() {
      addRemoteRecord(rec); persistRemote();
      renderLibrary(); renderTabs(); closeUrlModal();
      toast('已添加：' + rec.title);
    }
    if (lrcUrl) {
      fetch(lrcUrl).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        var txt = CM.Lyrics.decode(buf);
        state.lyrics[id] = txt; saveLyrics(); rec.lrc = txt; finish();
      }).catch(function () { toast('歌词获取失败，仅添加歌曲'); finish(); });
    } else finish();
  }

  /* ---------- 在线音乐（Audius 免费音乐 API） ---------- */
  function openOnlineModal() {
    $('online-modal').classList.remove('hidden');
    var ak = $('online-apikey');
    if (ak && !ak.value) ak.value = (CM.Online.getApiKey ? CM.Online.getApiKey() : '') || '';
    renderSourceTabs();
    renderSourceConfig();
    refreshAccount();
    var box = $('online-results');
    if (box && !box.children.length) {
      var hint = document.createElement('p');
      hint.className = 'online-empty';
      var src = CM.Online.getSources().filter(function (s) { return s.id === CM.Online.getSource(); })[0] || {};
      hint.textContent = '搜索 ' + (src.name || '在线') + ' 曲库，点击即可播放并加入曲库';
      box.appendChild(hint);
    }
    setTimeout(function () { var q = $('online-query'); if (q) q.focus(); }, 0);
  }
  function toggleOnlineSettings() {
    var panel = $('online-settings');
    var btn = $('online-settings-toggle');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (btn) btn.classList.toggle('active', !panel.classList.contains('hidden'));
  }
  function closeOnlineModal() {
    $('online-modal').classList.add('hidden');
    $('online-results').innerHTML = '';
    $('online-status').textContent = '';
  }
  function renderOnlineResults(items) {
    var box = $('online-results');
    box.innerHTML = '';
    if (!items.length) {
      var p = document.createElement('p');
      p.className = 'online-empty';
      p.textContent = '没有找到可播放的曲目，换个关键词试试～';
      box.appendChild(p);
      return;
    }
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'online-item';
      row.setAttribute('data-aid', it.id);
      var cover = document.createElement('div');
      cover.className = 'online-cover';
      if (it.cover) cover.style.backgroundImage = 'url("' + it.cover + '")';
      else cover.textContent = '🌐';
      row.appendChild(cover);
      var meta = document.createElement('div');
      meta.className = 'online-meta';
      var tt = document.createElement('div'); tt.className = 'online-title'; tt.textContent = it.title;
      var ar = document.createElement('div'); ar.className = 'online-artist';
      ar.textContent = it.artist + (it.duration ? ' · ' + fmt(it.duration) : '') + (it.genre ? ' · ' + it.genre : '');
      if (it.preview) {
        var pv = document.createElement('span');
        pv.className = 'online-preview';
        pv.textContent = '30秒试听';
        ar.appendChild(document.createTextNode(' '));
        ar.appendChild(pv);
      }
      var ly = document.createElement('span');
      ly.className = 'online-lyric';
      ly.dataset.state = 'probing';
      ly.textContent = '♪ 检测歌词…';
      ar.appendChild(document.createTextNode(' '));
      ar.appendChild(ly);
      meta.appendChild(tt); meta.appendChild(ar);
      row.appendChild(meta);
      var add = document.createElement('button');
      add.className = 'chip online-add';
      add.textContent = '＋ 加入';
      add.addEventListener('click', function (e) { e.stopPropagation(); addOnlineTrack(it, false); });
      row.appendChild(add);
      row.addEventListener('click', function () { addOnlineTrack(it, true); });
      box.appendChild(row);
    });
  }
  /* ---------- 音源切换 ---------- */
  function renderSourceTabs() {
    var box = $('online-sources');
    if (!box) return;
    box.innerHTML = '';
    CM.Online.getSources().forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'chip source-tab' + (s.id === CM.Online.getSource() ? ' active' : '');
      b.textContent = s.name;
      b.title = s.hint || '';
      b.addEventListener('click', function () {
        CM.Online.setSource(s.id);
        renderSourceTabs();
        renderSourceConfig();
        $('online-results').innerHTML = '';
        $('online-status').textContent = '已切换到 ' + s.name + (s.hint ? '（' + s.hint + '）' : '');
      });
      box.appendChild(b);
    });
    // API Key / 账号区仅属于 Audius
    var ao = $('audius-only');
    if (ao) ao.classList.toggle('hidden', CM.Online.getSource() !== 'audius');
  }
  function renderSourceConfig() {
    var box = $('online-source-config');
    if (!box) return;
    box.innerHTML = '';
    var src = CM.Online.getSources().filter(function (s) { return s.id === CM.Online.getSource(); })[0];
    if (!src || !src.needsConfig) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var label = document.createElement('label');
    label.className = 'online-cfg-label';
    label.textContent = src.configLabel || '配置';
    box.appendChild(label);
    var inp = document.createElement('input');
    inp.id = 'online-source-cfg';
    inp.type = 'text';
    inp.placeholder = '粘贴配置后回车保存';
    inp.value = src.getConfig ? (src.getConfig() || '') : '';
    inp.addEventListener('change', function () {
      if (src.setConfig) src.setConfig(inp.value);
      toast(inp.value.trim() ? ('已保存 ' + (src.configLabel || '配置')) : '已清除配置');
    });
    box.appendChild(inp);
    if (src.configHint) {
      var h = document.createElement('p');
      h.className = 'online-key-hint';
      h.textContent = src.configHint;
      box.appendChild(h);
    }
  }

  /* ---------- Audius 账号（OAuth 2.0 PKCE，只读） ---------- */
  function renderAccount(me) {
    var label = $('audius-account');
    var login = $('btn-audius-login');
    var mine = $('btn-audius-mine');
    var out = $('btn-audius-logout');
    if (!label) return;
    var on = CM.Auth.isLoggedIn();
    label.textContent = on
      ? (me ? ('已连接：' + (me.name || me.handle || 'Audius 用户')) : '已连接 Audius 账号')
      : '未连接 Audius 账号';
    if (login) login.classList.toggle('hidden', on);
    if (mine) mine.classList.toggle('hidden', !on);
    if (out) out.classList.toggle('hidden', !on);
  }
  function refreshAccount() {
    if (!CM.Auth.isLoggedIn()) { state.audiusMe = null; renderAccount(null); return; }
    renderAccount(state.audiusMe);
    CM.Auth.fetchMe().then(function (me) {
      state.audiusMe = me;
      renderAccount(me);
    }).catch(function (e) {
      var label = $('audius-account');
      if (label) label.textContent = '连接异常：' + (e && e.message ? e.message : '未知');
    });
  }
  function audiusLogin() {
    if (!CM.Online.getApiKey()) { toast('请先填写 Audius API Key，再点「连接账号」'); return; }
    toast('正在跳转到 Audius 授权…');
    CM.Auth.login().catch(function (e) { toast('登录失败：' + (e && e.message ? e.message : '未知')); });
  }
  function audiusLogout() {
    CM.Auth.clearToken();
    state.audiusMe = null;
    renderAccount(null);
    toast('已断开 Audius 账号');
  }
  function loadMyTracks() {
    var st = $('online-status');
    if (st) st.textContent = '正在载入我的曲目…';
    CM.Auth.myTracks(50).then(function (items) {
      renderOnlineResults(items);
      if (st) st.textContent = items.length ? ('我的曲目：' + items.length + ' 首') : '我的曲目为空';
      probeLyricsForResults(items);
    }).catch(function (e) {
      if (st) st.textContent = '载入失败：' + (e && e.message ? e.message : '未知');
    });
  }

  // 逐条（限流）探测 LRCLIB 是否有歌词，更新结果行标记
  function probeLyricsForResults(items) {
    var i = 0;
    function step() {
      if (i >= items.length) return;
      var it = items[i++];
      var el = document.querySelector('.online-item[data-aid="' + it.id + '"] .online-lyric');
      if (!el) return step(); // 结果已被替换
      // GD Studio：搜索结果自带歌词 id，直接标注，省一次探测请求
      if (it.lyricId) {
        el.dataset.state = 'yes';
        el.textContent = '♪ 支持歌词';
        setTimeout(step, 0);
        return;
      }
      CM.Lyrics.probe({ title: it.title, artist: it.artist, duration: it.duration })
        .then(function (ok) {
          el.dataset.state = ok ? 'yes' : 'no';
          el.textContent = ok ? '♪ 有歌词' : '— 无歌词';
        })
        .catch(function () { el.dataset.state = 'no'; el.textContent = '— 无歌词'; })
        .then(function () { setTimeout(step, 320); }); // LRCLIB 建议顺序 + 间隔
    }
    step();
  }
  function searchOnline() {
    var q = $('online-query').value.trim();
    if (!q) { toast('请输入歌名 / 艺术家 / 关键词'); return; }
    var st = $('online-status');
    st.textContent = '搜索中…';
    $('online-results').innerHTML = '';
    CM.Online.search(q).then(function (items) {
      renderOnlineResults(items);
      var srec = CM.Online.getSources().filter(function (s) { return s.id === CM.Online.getSource(); })[0] || {};
      st.textContent = items.length ? ('找到 ' + items.length + ' 首 · 来自 ' + (srec.name || '在线音乐')) : '没有结果';
      probeLyricsForResults(items);
    }).catch(function (e) {
      st.textContent = '搜索失败：' + (e && e.message ? e.message : '网络受限') + '（在线音乐为境外服务，需联网）';
    });
  }
  function addOnlineTrack(item, play) {
    if (!item || !item.id) { toast('曲目信息无效'); return; }
    toast((play ? '正在加载：' : '正在校验：') + item.title);
    // GD Studio 等二次解析音源：先换取真实播放 URL（解析成功即为校验通过），再入库
    CM.Online.prepare(item).then(function (it) {
      var resolved = it.playUrl; // prepare 后仍无 URL 且需要解析 → 判定失效
      if (it.needsResolve && !resolved) {
        toast('无法获取播放链接（可能已失效或触发限流）：' + it.title); return;
      }
      var rec = CM.Online.toRecord(it);
      var checked = it.needsResolve
        ? Promise.resolve(true)
        : CM.Online.verify(it).then(function (ok) {
            if (!ok) toast('该曲目在音源上已失效或不可播放：' + rec.title);
            return ok;
          });
      checked.then(function (ok) {
        if (!ok) return;
        if (!Lib.get(rec.id)) { addRemoteRecord(rec); persistRemote(); }
        renderLibrary(); renderTabs();
        toast((play ? '正在播放：' : '已加入曲库：') + rec.title);
        if (play) {
          var all = Lib.resolve(Lib.listIds('all'));
          CM.Player.setPlaylist(all);
          var i = -1;
          for (var k = 0; k < all.length; k++) { if (all[k].id === rec.id) { i = k; break; } }
          if (i >= 0) CM.Player.loadIndex(i, true);
          renderQueue();
        }
        // 静默尝试在线匹配歌词（GD Studio 优先，回退 LRCLIB）
        if (!state.lyrics[rec.id]) {
          CM.Lyrics.fetchLyrics({ title: rec.title, artist: rec.artist, duration: rec.duration })
            .then(function (lrc) {
              if (!lrc || state.lyrics[rec.id]) return;
              state.lyrics[rec.id] = lrc; saveLyrics(); rec.lrc = lrc;
              if (state.currentTrackId === rec.id) showLyricsFor(rec);
            }).catch(function () {});
        }
      });
    }).catch(function () {
      toast('加载失败：' + (item.title || '') + '（网络受限或触发限流）');
    });
  }

  /* ---------- 歌单导出 / 导入（JSON 备份） ---------- */
  function exportData() {
    var data = {
      app: 'coral-music',
      version: 1,
      exportedAt: new Date().toISOString(),
      lists: JSON.parse(JSON.stringify(Lib.getLists())),
      remote: Lib.loadRemote(),
      lyrics: state.lyrics,
      settings: {
        theme: document.documentElement.getAttribute('data-theme'),
        volume: (+$('volume').value) / 100,
        eq: CM.Player.getEQ()
      }
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = global.URL.createObjectURL(blob);
    a.download = 'coral-music-backup-' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    global.URL.revokeObjectURL(a.href);
    toast('已导出备份 JSON');
  }
  function applySettings(s) {
    if (!s) return;
    if (s.theme) {
      document.documentElement.setAttribute('data-theme', s.theme);
      try { localStorage.setItem('cm-theme', s.theme); } catch (e) {}
      $('btn-theme').textContent = s.theme === 'dark' ? '☀️' : '🌙';
    }
    if (typeof s.volume === 'number') {
      $('volume').value = Math.round(s.volume * 100);
      CM.Player.setVolume(s.volume); saveVolume(s.volume);
    }
    if (s.eq) {
      // 兼容旧备份：三段数据由 normalizeEQ 映射到十段
      var g = CM.Player.normalizeEQ(s.eq);
      if (g) { setEqValues(g); applyEQ(); }
    }
  }
  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (data.app && data.app !== 'coral-music') { toast('文件格式不匹配'); return; }
        if (data.lists) Lib.setLists(data.lists);
        if (Array.isArray(data.remote)) Lib.saveRemote(data.remote);
        if (data.lyrics && typeof data.lyrics === 'object') { state.lyrics = data.lyrics; saveLyrics(); }
        applySettings(data.settings);
        buildLibrary().then(function () {
          state.currentListId = Lib.getCurrentList();
          if (!Lib.getLists()[state.currentListId]) state.currentListId = 'all';
          renderLibrary(); renderQueue();
          toast('已导入备份，歌单与远程歌曲已恢复');
        });
      } catch (e) { toast('导入失败：JSON 解析错误'); }
    };
    reader.onerror = function () { toast('导入失败：无法读取文件'); };
    reader.readAsText(file);
  }

  /* ---------- 偏好持久化 ---------- */
  function loadLyrics() {
    try { state.lyrics = JSON.parse(localStorage.getItem('cm-lyrics') || '{}'); }
    catch (e) { state.lyrics = {}; }
  }
  function saveLyrics() {
    try { localStorage.setItem('cm-lyrics', JSON.stringify(state.lyrics)); } catch (e) {}
  }
  function loadSettings() {
    try {
      var v = parseFloat(localStorage.getItem('cm-volume'));
      if (!isNaN(v)) { $('volume').value = Math.round(v * 100); CM.Player.setVolume(v); }
    } catch (e) {}
  }
  function saveVolume(v) { try { localStorage.setItem('cm-volume', String(v)); } catch (e) {} }

  /* ---------- 初始化 ---------- */
  function init() {
    CM.Visualizer.init($('visualizer'));
    CM.Player.init();
    CM.Playlist.init();
    CM.Queue.init({
      onPlayAt: function (i) { CM.Player.loadIndex(i, true); renderQueue(); },
      onRemove: function (i) { CM.Player.queueRemove(i); renderQueue(); },
      onReorder: function (from, to) { CM.Player.queueMove(from, to); renderQueue(); }
    });

    loadLyrics(); loadSettings();
    loadLyricScale();
    initVizMode();
    buildEqBand(); buildEqPresets();
    buildSortSelect();
    loadEQ();
    restorePlaybackPrefs();
    updateAbUI();

    state.currentListId = Lib.getCurrentList();
    var lists = Lib.getLists();
    if (!lists[state.currentListId]) state.currentListId = 'all';

    buildLibrary().then(function () { renderLibrary(); renderQueue(); });

    // 播放器事件
    CM.Player.on('track', function (track) {
      $('track-title').textContent = track.title || '未知标题';
      $('track-artist').textContent = track.artist || '未知歌手';
      var cover = $('cover');
      if (isImgCover(track.cover)) {
        cover.style.background = '';
        cover.style.backgroundImage = 'url("' + track.cover + '")';
        cover.style.backgroundSize = 'cover';
      } else {
        cover.style.backgroundImage = '';
        cover.style.background = track.cover || pickCover(track.id);
      }
      CM.Playlist.setCurrentById(track.id);
      CM.Queue.setCurrent(CM.Player.getIndex());
      showLyricsFor(track);
      $('btn-play').textContent = '⏸';
      // AB 段是「针对某一首歌」的选区，换歌后自动清除，避免误导
      CM.Player.clearAb();
    });
    CM.Player.on('time', function (cur, dur) {
      $('time-current').textContent = fmt(cur);
      $('time-total').textContent = fmt(dur);
      if (dur > 0 && !seeking) $('seek').value = Math.round((cur / dur) * 1000);
      syncLyrics(cur);
      updateAbBand(CM.Player.getAb());
    });
    CM.Player.on('state', function (playing) {
      $('btn-play').textContent = playing ? '⏸' : '▶';
      $('cover').classList.toggle('spin', playing);
    });
    // 元数据就绪时回写真实时长：搜索接口常不返回时长（示例曲 / GD / 在线源），
    // 播放过一遍后统计面板的「总时长」才准确。
    CM.Player.on('meta', function (dur) {
      var t = CM.Player.getTrack();
      if (!t || !(dur > 0) || Math.abs((t.duration || 0) - dur) < 1) return;
      t.duration = dur;
      if (t.source === 'remote' || t.source === 'online') persistRemote();
    });
    CM.Player.on('playlistEnd', function () {
      $('btn-play').textContent = '▶';
      $('cover').classList.remove('spin');
    });
    CM.Player.on('error', function (title) {
      var cur = CM.Player.getTrack();
      // GD Studio 曲目：播放 URL 有时效，失效先重解析一次再播放（每曲限一次，防死循环）
      if (cur && cur.sid === 'gdstudio' && cur.lid && onlineRetry.id !== cur.id) {
        onlineRetry.id = cur.id;
        onlineRetry.at = Date.now();
        toast('播放链接已过期，正在重新获取：' + (cur.title || ''));
        CM.Online.prepare({ sid: 'gdstudio', id: cur.oid, gsub: cur.gsub, picId: cur.pid, title: cur.title })
          .then(function (it) {
            if (!it || !it.playUrl) throw new Error('重解析失败');
            cur.url = it.playUrl;
            if (it.cover) cur.cover = it.cover;
            persistRemote(); // 同步回曲库持久化
            CM.Player.loadIndex(CM.Player.getIndex(), true);
          })
          .catch(function () {
            toast('重新获取播放链接失败：' + (cur.title || ''));
            skipOnline();
          });
        return;
      }
      // 在线曲目：多为曲目已失效 / 不可播放，自动跳过以免卡住（连续失败 3 次即停，防死循环）
      if (cur && cur.source === 'online') {
        skipOnline();
        return;
      }
      toast('播放失败' + (title ? '：' + title : '') + '（链接可能失效或跨域受限）');
    });

    // 控件
    $('btn-play').addEventListener('click', function () { CM.Player.toggle(); });
    $('btn-prev').addEventListener('click', function () { CM.Player.prev(); });
    $('btn-next').addEventListener('click', function () { CM.Player.next(); });

    var seeking = false;
    $('seek').addEventListener('input', function () {
      seeking = true;
      var r = this.value / 1000;
      $('time-current').textContent = fmt(r * (parseFloat($('time-total').textContent) || 0));
    });
    $('seek').addEventListener('change', function () {
      CM.Player.seekRatio(this.value / 1000); seeking = false;
    });

    $('volume').addEventListener('input', function () {
      var v = this.value / 100; CM.Player.setVolume(v); saveVolume(v);
    });

    $('btn-shuffle').addEventListener('click', function () {
      var s = !CM.Player.getShuffle();
      CM.Player.setShuffle(s);
      this.classList.toggle('active', s);
      toast(s ? '随机播放：开' : '随机播放：关');
    });
    var repeatMap = { off: 'one', one: 'all', all: 'off' };
    var repeatIcon = { off: '🔁', one: '🔂', all: '🔁' };
    $('btn-repeat').addEventListener('click', function () {
      var m = repeatMap[CM.Player.getRepeat()];
      CM.Player.setRepeat(m);
      this.classList.toggle('active', m !== 'off');
      this.textContent = repeatIcon[m];
      toast(m === 'one' ? '单曲循环' : (m === 'all' ? '列表循环' : '循环：关'));
    });

    $('btn-lyrics').addEventListener('click', function () {
      // 词按钮 = 在「歌词」与「队列」面板间切换；同步高亮由面板可见性决定
      showSide(state.lyricsVisible ? 'queue' : 'lyrics');
    });
    $('btn-eq').addEventListener('click', openFx);
    $('btn-queue-tab').addEventListener('click', function () { showSide('queue'); });

    $('btn-theme').addEventListener('click', toggleTheme);

    // 上传
    $('btn-upload').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;

      var audioExt = /\.(mp3|m4a|wav|ogg|flac|aac|opus|weba?)$/i;
      var audios = files.filter(function (f) {
        return f.type.indexOf('audio') === 0 || audioExt.test(f.name);
      });
      var lrcs = files.filter(function (f) { return /\.lrc$/i.test(f.name); });

      // 先把 .lrc 文本读出来，按文件名（去扩展名）建索引，便于同名配对
      var lrcMap = {};
      var reads = lrcs.map(function (f) {
        return readText(f).then(function (txt) { lrcMap[baseNameOf(f.name)] = txt; });
      });

      Promise.all(reads).then(function () {
        var added = 0;
        audios.forEach(function (f) {
          var name = baseNameOf(f.name);
          var lrcText = lrcMap[name];
          var rec = {
            id: 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
            title: name, artist: '本地', file: f,
            cover: pickCover(name), source: 'local', addedAt: Date.now()
          };
          if (lrcText) { rec.lrc = lrcText; }
          function add() {
            addLocalRecord(rec);
            if (lrcText) { state.lyrics[rec.id] = lrcText; saveLyrics(); }
            CM.Storage.put(rec).catch(function () { toast('本地保存失败（浏览器存储不可用）'); });
            added++;
            renderLibrary(); renderQueue();
            // 若当前正在播放这首歌，立即刷新歌词
            var cur = CM.Player.getTrack();
            if (cur && cur.id === rec.id) showLyricsFor(rec);
          }
          if (CM.ID3) {
            CM.ID3.parseCover(f).then(function (url) { if (url) rec.cover = url; add(); })
              .catch(function () { add(); });
          } else add();
        });
        if (added) {
          var tip = lrcs.length ? ('（已自动关联 ' + lrcs.length + ' 个歌词文件）') : '';
          toast('已添加 ' + added + ' 首本地歌曲' + tip);
        } else if (!audios.length) {
          toast('未识别到音频文件（可同时选择同名 .lrc 歌词）');
        }
      });
    });

    $('btn-add-url').addEventListener('click', openUrlModal);
    $('url-cancel').addEventListener('click', closeUrlModal);
    $('url-ok').addEventListener('click', submitUrl);
    $('url-modal').addEventListener('click', function (e) { if (e.target === this) closeUrlModal(); });

    // 在线音乐（Audius 免费音乐 API）—— 元素缺失时跳过，避免中断后续所有绑定
    function bindEl(id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); }
    bindEl('btn-online', 'click', openOnlineModal);
    bindEl('online-close', 'click', closeOnlineModal);
    bindEl('online-settings-toggle', 'click', toggleOnlineSettings);
    bindEl('online-search', 'click', searchOnline);
    bindEl('online-query', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchOnline(); } });
    bindEl('online-modal', 'click', function (e) { if (e.target === this) closeOnlineModal(); });
    // Audius API Key（仅存前端，官方允许）—— 变更即保存，用于提升速率配额
    bindEl('online-apikey', 'change', function () {
      CM.Online.setApiKey(this.value);
      toast(this.value.trim() ? '已保存 Audius API Key（提升速率配额）' : '已清除 Audius API Key');
    });
    // Audius 账号（OAuth 2.0 PKCE）
    bindEl('btn-audius-login', 'click', audiusLogin);
    bindEl('btn-audius-logout', 'click', audiusLogout);
    bindEl('btn-audius-mine', 'click', loadMyTracks);

    // 播放统计面板
    bindEl('btn-stats', 'click', openStats);
    bindEl('stats-close', 'click', function () { $('stats-modal').classList.add('hidden'); });
    bindEl('stats-clear', 'click', function () {
      if (!global.confirm('清空全部播放统计？「最近」「最常播」也会同时清空。')) return;
      CM.Player.clearStats();
      renderStats(); renderTabs();
      toast('播放统计已清空');
    });
    bindEl('stats-modal', 'click', function (e) { if (e.target === this) this.classList.add('hidden'); });

    // 播放后刷新「最近 / 最常播」的计数
    CM.Player.on('played', function () {
      if (isVirtualList(state.currentListId)) renderLibrary();
      else renderTabs();
    });

    // 云端（R2）
    bindEl('btn-cloud', 'click', openCloud);
    bindEl('cloud-close', 'click', closeCloud);
    bindEl('cloud-modal', 'click', function (e) { if (e.target === this) closeCloud(); });
    bindEl('cloud-pass-save', 'click', cloudSavePass);
    bindEl('cloud-pass-gen', 'click', cloudGenPass);
    bindEl('cloud-pass-show', 'change', function () {
      $('cloud-pass').type = this.checked ? 'text' : 'password';
    });
    bindEl('cloud-pass', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); cloudSavePass(); } });
    bindEl('cloud-refresh', 'click', cloudRefreshList);
    bindEl('cloud-upload-all', 'click', cloudUploadAll);
    bindEl('cloud-sync-up', 'click', cloudSyncUp);
    bindEl('cloud-sync-down', 'click', cloudSyncDown);

    $('btn-load-samples').addEventListener('click', function () {
      var have = {};
      Lib.allTracks().forEach(function (t) { if (t.source === 'sample') have[t.id] = true; });
      var added = 0;
      CM.samples.forEach(function (s) { if (!have[s.id]) { addSampleRecord(s); added++; } });
      if (added) toast('已载入 ' + added + ' 首示例曲'); else toast('示例曲已在列表中');
      renderLibrary(); renderTabs();
    });

    // 歌单导出 / 导入
    $('btn-export').addEventListener('click', exportData);
    $('btn-import').addEventListener('click', function () { $('import-input').click(); });
    $('import-input').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });

    // 歌单
    $('btn-new-list').addEventListener('click', newList);
    $('search').addEventListener('input', function () {
      state.query = this.value;
      clearSelection();          // 搜索条件变化后旧的勾选可能已不可见，直接清空避免误删
      renderLibrary();
    });

    // 曲库工具条：多选 / 排序 / 去重
    bindEl('btn-multi', 'click', function () { setMulti(!state.multi); });
    bindEl('batch-cancel', 'click', function () { setMulti(false); });
    bindEl('batch-queue', 'click', batchAddToQueue);
    bindEl('batch-remove', 'click', batchRemove);
    bindEl('batch-add', 'click', function () {
      var r = this.getBoundingClientRect();
      openListPicker(r.left, r.bottom);
    });
    bindEl('sort-select', 'change', function () { changeSort(this.value); });
    bindEl('btn-dedupe', 'click', openDedupe);
    bindEl('dedupe-close', 'click', function () { $('dedupe-modal').classList.add('hidden'); });
    bindEl('dedupe-modal', 'click', function (e) { if (e.target === this) this.classList.add('hidden'); });
    bindEl('dedupe-apply', 'click', applyDedupe);

    // 队列
    $('btn-queue-clear').addEventListener('click', clearQueue);

    // 音效：十段 EQ + 播放引擎
    bindEl('fx-close', 'click', function () { $('fx-modal').classList.add('hidden'); });
    bindEl('fx-done', 'click', function () { $('fx-modal').classList.add('hidden'); });
    bindEl('fx-modal', 'click', function (e) { if (e.target === this) this.classList.add('hidden'); });
    bindEl('fx-reset', 'click', function () {
      setEqValues(CM.Player.EQ_PRESETS.flat.slice());
      applyEQ();
      CM.Player.setCrossfade(0);
      CM.Player.setLoudness(false);
      CM.Player.setKeepPitch(true);
      initFxUI();
      toast('音效设置已恢复默认');
    });
    bindEl('fx-crossfade', 'input', function () {
      var v = CM.Player.setCrossfade(parseFloat(this.value));
      markCrossfade(v);
    });
    bindEl('fx-loudness', 'change', function () {
      CM.Player.setLoudness(this.checked);
      toast(this.checked ? '响度均衡：开（自动补偿音量差异）' : '响度均衡：关');
    });
    bindEl('fx-keep-pitch', 'change', function () {
      CM.Player.setKeepPitch(this.checked);
      syncEngineSwitches();
    });
    bindEl('rate-keep-pitch', 'change', function () {
      CM.Player.setKeepPitch(this.checked);
      syncEngineSwitches();
    });

    // AB 段循环
    bindEl('btn-ab-a', 'click', function () {
      if (!CM.Player.getTrack()) { toast('请先播放一首歌'); return; }
      if (CM.Player.setAbPoint('a')) toast('A 点：' + fmt(CM.Player.getCurrentTime()));
      updateAbUI();
    });
    bindEl('btn-ab-b', 'click', function () {
      if (!CM.Player.getTrack()) { toast('请先播放一首歌'); return; }
      if (CM.Player.setAbPoint('b')) toast('B 点：' + fmt(CM.Player.getCurrentTime()) + '，开始 AB 循环');
      else toast('B 点需要晚于 A 点至少 0.3 秒');
      updateAbUI();
    });
    bindEl('btn-ab-clear', 'click', function () {
      CM.Player.clearAb();
      updateAbUI();
      toast('已清除 AB 循环');
    });
    CM.Player.on('ab', updateAbUI);

    // 侧栏 tab
    document.querySelectorAll('.panel-tab').forEach(function (t) {
      t.addEventListener('click', function () { showSide(t.getAttribute('data-panel')); });
    });

    // 歌词：全屏 / 导出 / 字号
    bindEl('btn-lyrics-full', 'click', toggleFullLyrics);
    bindEl('btn-lyrics-full-close', 'click', closeFullLyrics);
    bindEl('btn-lyrics-export', 'click', exportLrc);
    bindEl('btn-lyric-smaller', 'click', function () { changeLyricScale(-1); });
    bindEl('btn-lyric-larger', 'click', function () { changeLyricScale(1); });

    // 可视化：模式切换 / 全屏
    bindEl('btn-viz-mode', 'click', cycleVizMode);
    bindEl('btn-viz-full', 'click', toggleVizFull);

    // 歌词在线匹配（多来源候选，手动选择）
    $('btn-lyrics-match').addEventListener('click', openMatchModal);
    bindEl('match-close', 'click', closeMatchModal);
    bindEl('match-search', 'click', searchMatch);
    bindEl('match-query', 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); searchMatch(); } });
    bindEl('match-modal', 'click', function (e) { if (e.target === this) closeMatchModal(); });
    // 歌词编辑
    $('btn-lyrics-edit').addEventListener('click', function () {
      var id = state.currentTrackId;
      if (!id) { toast('请先选择一首歌'); return; }
      $('lrc-input').value = state.lyrics[id] || (CM.Player.getTrack() && CM.Player.getTrack().lrc) || '';
      $('lrc-modal').classList.remove('hidden');
      $('lrc-input').dataset.trackId = id;
    });
    $('lrc-cancel').addEventListener('click', function () { $('lrc-modal').classList.add('hidden'); });
    $('lrc-ok').addEventListener('click', function () {
      var id = $('lrc-input').dataset.trackId;
      state.lyrics[id] = $('lrc-input').value;
      saveLyrics();
      $('lrc-modal').classList.add('hidden');
      showLyricsFor(CM.Player.getTrack());
      toast('歌词已保存');
    });
    $('lrc-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });

    // 键盘：空格播放/暂停，左右切歌，Esc 退出全屏层
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        if (isFullLyricsOpen()) { closeFullLyrics(); return; }
        if (isVizFull()) { toggleVizFull(); return; }
        return;
      }
      if (e.code === 'Space') { e.preventDefault(); CM.Player.toggle(); }
      else if (e.code === 'ArrowRight') CM.Player.next();
      else if (e.code === 'ArrowLeft') CM.Player.prev();
    });

    $('btn-theme').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';

    // 同步初始侧栏状态（默认停在歌词面板，词按钮高亮）
    showSide('lyrics');

    // 倍速
    $('btn-rate').addEventListener('click', function () { markRate(CM.Player.getRate()); $('rate-modal').classList.remove('hidden'); });
    $('rate-close').addEventListener('click', function () { $('rate-modal').classList.add('hidden'); });
    $('rate-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });
    document.querySelectorAll('.rate-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = parseFloat(b.getAttribute('data-rate'));
        CM.Player.setRate(r);
        try { localStorage.setItem('cm-rate', String(r)); } catch (e) {}
        markRate(r);
        toast('倍速：' + r + 'x');
      });
    });

    // 睡眠定时
    $('btn-sleep').addEventListener('click', function () {
      var cur = state.sleepMode === 'trackEnd' ? 'trackEnd'
        : (state.sleepMode ? String(Math.round((state.sleepMode - Date.now()) / 60000)) : 'off');
      markSleep(cur); $('sleep-modal').classList.remove('hidden');
    });
    $('sleep-close').addEventListener('click', function () { $('sleep-modal').classList.add('hidden'); });
    $('sleep-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });
    document.querySelectorAll('.sleep-opt').forEach(function (b) {
      b.addEventListener('click', function () { setSleep(b.getAttribute('data-min')); });
    });

    // 桌面浮动歌词开关
    $('btn-desktop-lyrics').addEventListener('click', function () {
      state.deskLyricsOn = !state.deskLyricsOn;
      this.classList.toggle('active', state.deskLyricsOn);
      try { localStorage.setItem('cm-desk-lyrics', state.deskLyricsOn ? '1' : '0'); } catch (e) {}
      if (state.deskLyricsOn) syncLyrics(CM.Player.getCurrentTime());
      else { var el = $('desktop-lyrics'); if (el) el.classList.add('hidden'); }
      toast(state.deskLyricsOn ? '已开启桌面歌词' : '已关闭桌面歌词');
    });

    // 歌词偏移微调
    $('lyric-offset').addEventListener('input', function () {
      state.lyricOffset = parseInt(this.value, 10) || 0;
      $('lyric-offset-val').textContent = (state.lyricOffset / 1000).toFixed(1) + 's';
      try { localStorage.setItem('cm-lyric-offset', String(state.lyricOffset)); } catch (e) {}
      syncLyrics(CM.Player.getCurrentTime());
    });

    // 桌面歌词条拖动
    (function enableDragDL() {
      var el = $('desktop-lyrics'); if (!el) return;
      var dx = 0, dy = 0, dragging = false;
      el.addEventListener('pointerdown', function (e) {
        dragging = true;
        var r = el.getBoundingClientRect();
        dx = e.clientX - r.left; dy = e.clientY - r.top;
        try { el.setPointerCapture(e.pointerId); } catch (e2) {}
      });
      el.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        el.style.left = (e.clientX - dx) + 'px';
        el.style.top = (e.clientY - dy) + 'px';
        el.style.bottom = 'auto'; el.style.transform = 'none';
      });
      el.addEventListener('pointerup', function () { dragging = false; });
    })();

    // Audius OAuth 回调处理（URL 带 ?code=&state= 时）—— 完成登录并刷新账号区
    CM.Auth.handleRedirect().then(function (t) {
      if (t) toast('已连接 Audius 账号');
      refreshAccount();
    }).catch(function (e) {
      toast('Audius 登录失败：' + (e && e.message ? e.message : '未知'));
      refreshAccount();
    });

    // PWA：注册 Service Worker（离线可开 / 可安装到桌面）
    // 新 SW 接管后自动刷新一次，避免「HTML 已更新、JS 仍是 SW 缓存的旧版」造成新按钮无绑定
    if ('serviceWorker' in navigator) {
      var hadController = !!navigator.serviceWorker.controller;
      var reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloading) return;
        reloading = true;
        global.location.reload();
      });
      global.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          if (reg.update) reg.update();
        }).catch(function () { /* 非 https/localhost 环境忽略 */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
