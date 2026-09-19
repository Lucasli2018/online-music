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
    lyricsVisible: true,  // 侧栏当前是否停在「歌词」面板（决定主面板滚动）
    deskLyricsOn: false,  // 桌面浮动歌词开关
    lyricOffset: 0,       // 歌词整体时间偏移（毫秒）
    sleepMode: null,      // 睡眠定时：null | 'trackEnd' | 到期时间戳(数字)
    sleepTimer: null
  };

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
    Lib.saveRemote(Lib.allTracks().filter(function (t) { return t.source === 'remote'; }));
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

  /* ---------- 可见曲目（当前歌单 + 搜索） ---------- */
  function getVisibleTracks() {
    var tracks = Lib.resolve(Lib.listIds(state.currentListId));
    var q = state.query.trim().toLowerCase();
    if (q) {
      tracks = tracks.filter(function (t) {
        return (t.title || '').toLowerCase().indexOf(q) >= 0 ||
               (t.artist || '').toLowerCase().indexOf(q) >= 0;
      });
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
      onRemove: removeTrack
    });
  }
  function renderTabs() {
    var box = $('list-tabs');
    if (!box) return;
    box.innerHTML = '';
    var lists = Lib.getLists();
    var order = ['all', 'fav'].concat(Object.keys(lists).filter(function (k) { return k !== 'all' && k !== 'fav'; }));
    order.forEach(function (id) {
      var li = lists[id];
      if (!li) return;
      var tab = document.createElement('button');
      tab.className = 'list-tab' + (id === state.currentListId ? ' active' : '');
      tab.appendChild(document.createTextNode(li.name + ' '));
      var cnt = document.createElement('span');
      cnt.className = 'list-tab-count';
      cnt.textContent = (li.ids ? li.ids.length : 0);
      tab.appendChild(cnt);
      if (id !== 'all' && id !== 'fav') {
        var x = document.createElement('span');
        x.className = 'tab-del'; x.title = '删除歌单'; x.textContent = '✕';
        x.addEventListener('click', function (e) { e.stopPropagation(); removeList(id); });
        tab.appendChild(x);
      }
      tab.addEventListener('click', function () { switchList(id); });
      box.appendChild(tab);
    });
  }
  function switchList(id) {
    state.currentListId = id;
    Lib.setCurrentList(id);
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
    CM.Player.setPlaylist(vis);
    var i = -1;
    for (var k = 0; k < vis.length; k++) { if (vis[k].id === track.id) { i = k; break; } }
    if (i < 0) i = 0;
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
  function removeTrack(track) {
    if (track.source === 'local') {
      CM.Storage.del(track.id).catch(function () {});
      CM.Player.revokeUrl(track.id);
    }
    Lib.removeTrack(track.id);
    if (track.source === 'remote') persistRemote();
    CM.Player.clearProgress(track.id);

    var cur = CM.Player.getTrack();
    if (cur && cur.id === track.id) {
      CM.Player.pause();
      var q = CM.Player.getQueue();
      var qi = -1;
      for (var k = 0; k < q.length; k++) { if (q[k].id === track.id) { qi = k; break; } }
      if (qi >= 0) CM.Player.queueRemove(qi);
    }
    renderLibrary(); renderTabs(); renderQueue();
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

  /* ---------- 歌词 ---------- */
  function showLyricsFor(track) {
    state.currentTrackId = track ? track.id : null;
    var raw = (track && (state.lyrics[track.id] || track.lrc)) || '';
    state.currentLines = CM.Lyrics.parse(raw);
    renderLyrics(state.currentLines);
  }
  function renderLyrics(lines) {
    var box = $('lyrics');
    if (!box) return;
    box.innerHTML = '';
    state.currentLineEls = [];
    if (!lines.length) {
      var p = document.createElement('p');
      p.className = 'lyrics-empty';
      p.textContent = '暂无歌词。点击「编辑」粘贴 LRC 文本，或添加链接时填写歌词地址。';
      box.appendChild(p);
      return;
    }
    lines.forEach(function (l) {
      var p = document.createElement('p');
      p.textContent = l.text;
      p.dataset.time = l.time;
      p.addEventListener('click', function () {
        if (!CM.Player.getTrack()) return;
        CM.Player.seekTo(l.time);
        syncLyrics(l.time); // 立即对齐高亮，不等下一个 timeupdate
      });
      box.appendChild(p);
      state.currentLineEls.push(p);
    });
  }
  function syncLyrics(time) {
    var t = time + state.lyricOffset / 1000;
    var idx = state.currentLines.length ? CM.Lyrics.activeIndex(state.currentLines, t) : -1;
    var els = state.currentLineEls;
    els.forEach(function (el, i) { el.classList.toggle('active', i === idx); });
    if (state.lyricsVisible && idx >= 0) {
      var a = els[idx];
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    updateDesktopLyrics(idx);
  }
  function updateDesktopLyrics(idx) {
    var el = $('desktop-lyrics');
    if (!el) return;
    if (!state.deskLyricsOn) { el.classList.add('hidden'); return; }
    var line = state.currentLines[idx];
    el.textContent = line ? line.text : '♪';
    el.classList.remove('hidden');
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

  /* ---------- EQ ---------- */
  function loadEQ() {
    try {
      var g = JSON.parse(localStorage.getItem('cm-eq') || 'null');
      if (g && g.length === 3) {
        $('eq-low').value = g[0]; $('eq-mid').value = g[1]; $('eq-high').value = g[2];
        applyEQ();
      }
    } catch (e) {}
  }
  function applyEQ() {
    var g = [+$('eq-low').value, +$('eq-mid').value, +$('eq-high').value];
    CM.Player.setEQ(g);
    $('eq-low-val').textContent = (g[0] > 0 ? '+' : '') + g[0];
    $('eq-mid-val').textContent = (g[1] > 0 ? '+' : '') + g[1];
    $('eq-high-val').textContent = (g[2] > 0 ? '+' : '') + g[2];
    try { localStorage.setItem('cm-eq', JSON.stringify(g)); } catch (e) {}
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
        eq: [+$('eq-low').value, +$('eq-mid').value, +$('eq-high').value]
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
    if (Array.isArray(s.eq) && s.eq.length === 3) {
      $('eq-low').value = s.eq[0]; $('eq-mid').value = s.eq[1]; $('eq-high').value = s.eq[2];
      applyEQ();
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
    loadEQ();
    restorePlaybackPrefs();

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
    });
    CM.Player.on('time', function (cur, dur) {
      $('time-current').textContent = fmt(cur);
      $('time-total').textContent = fmt(dur);
      if (dur > 0 && !seeking) $('seek').value = Math.round((cur / dur) * 1000);
      syncLyrics(cur);
    });
    CM.Player.on('state', function (playing) {
      $('btn-play').textContent = playing ? '⏸' : '▶';
      $('cover').classList.toggle('spin', playing);
    });
    CM.Player.on('playlistEnd', function () {
      $('btn-play').textContent = '▶';
      $('cover').classList.remove('spin');
    });
    CM.Player.on('error', function (title) {
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
    $('btn-eq').addEventListener('click', function () { $('eq-modal').classList.remove('hidden'); });
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
    $('search').addEventListener('input', function () { state.query = this.value; renderLibrary(); });

    // 队列
    $('btn-queue-clear').addEventListener('click', clearQueue);

    // EQ
    $('eq-low').addEventListener('input', applyEQ);
    $('eq-mid').addEventListener('input', applyEQ);
    $('eq-high').addEventListener('input', applyEQ);
    $('eq-reset').addEventListener('click', function () {
      $('eq-low').value = 0; $('eq-mid').value = 0; $('eq-high').value = 0; applyEQ(); toast('EQ 已重置');
    });
    $('eq-close').addEventListener('click', function () { $('eq-modal').classList.add('hidden'); });
    $('eq-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.add('hidden'); });

    // 侧栏 tab
    document.querySelectorAll('.panel-tab').forEach(function (t) {
      t.addEventListener('click', function () { showSide(t.getAttribute('data-panel')); });
    });

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

    // 键盘：空格播放/暂停，左右切歌
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
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

    // PWA：注册 Service Worker（离线可开 / 可安装到桌面）
    if ('serviceWorker' in navigator) {
      global.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 非 https/localhost 环境忽略 */ });
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
