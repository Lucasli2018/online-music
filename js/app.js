/* app.js — 总控：装配存储 / 播放 / 列表 / 歌词 / 主题 */
(function (global) {
  'use strict';

  var CM = global.CM;
  var state = {
    master: [],          // 当前播放列表（单一数据源）
    remote: [],          // 远程链接歌（持久化）
    lyrics: {},          // trackId -> lrc 文本
    currentTrackId: null,
    currentLines: [],
    currentLineEls: [],
    lyricsOn: false
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
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }
  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------- 持久化 ---------- */
  function loadRemote() {
    try { state.remote = JSON.parse(localStorage.getItem('cm-remote') || '[]'); }
    catch (e) { state.remote = []; }
    if (!Array.isArray(state.remote)) state.remote = [];
  }
  function saveRemote() {
    try { localStorage.setItem('cm-remote', JSON.stringify(state.remote)); } catch (e) {}
  }
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

  /* ---------- 列表重建 ---------- */
  function rebuild() {
    CM.Player.setPlaylist(state.master);
    CM.Playlist.render(state.master, CM.Player.getIndex());
  }

  function appendLocal(record) {
    state.master.push(record);
    CM.Storage.put(record).catch(function () { toast('本地保存失败（浏览器存储不可用）'); });
    rebuild();
  }
  function addSampleIfAbsent() {
    var have = {};
    state.master.forEach(function (t) { have[t.id] = true; });
    var added = 0;
    CM.samples.forEach(function (s) {
      if (!have[s.id]) {
        var rec = Object.assign({}, s, { cover: s.cover || pickCover(s.id) });
        state.master.push(rec); added++;
      }
    });
    if (added) { rebuild(); toast('已载入 ' + added + ' 首示例曲'); }
    else toast('示例曲已在列表中');
  }
  function removeTrack(id, i) {
    var track = state.master[i];
    if (!track) return;
    if (track.source === 'local') {
      CM.Storage.del(id).catch(function () {});
      CM.Player.revokeUrl(id);
    } else if (track.source === 'remote') {
      state.remote = state.remote.filter(function (r) { return r.id !== id; });
      saveRemote();
    }
    CM.Player.clearProgress(id);
    state.master.splice(i, 1);
    var cur = CM.Player.getIndex();
    if (cur === i) {
      CM.Player.pause();
      if (state.master.length) CM.Player.loadIndex(Math.min(i, state.master.length - 1), false);
      else { $('track-title').textContent = '未在播放'; $('track-artist').textContent = '选择一首歌开始享受'; $('time-current').textContent = '0:00'; $('time-total').textContent = '0:00'; $('seek').value = 0; CM.Playlist.setCurrent(-1); }
    } else if (cur > i) {
      CM.Player.setIndex(cur - 1);
    }
    rebuild();
  }
  function reorder(from, to) {
    if (from < 0 || to < 0 || from >= state.master.length || to >= state.master.length) return;
    var cur = CM.Player.getIndex();
    var moved = state.master.splice(from, 1)[0];
    state.master.splice(to, 0, moved);
    // 修正当前索引（不重载，避免打断播放）
    if (cur === from) cur = to;
    else if (from < cur && cur <= to) cur--;
    else if (to <= cur && cur < from) cur++;
    CM.Player.setPlaylist(state.master);
    CM.Player.setIndex(cur);
    CM.Playlist.render(state.master, cur);
  }

  function playAt(i) { CM.Player.loadIndex(i, true); }

  /* ---------- 歌词 ---------- */
  function showLyricsFor(track) {
    state.currentTrackId = track ? track.id : null;
    var raw = (track && (state.lyrics[track.id] || track.lrc)) || '';
    state.currentLines = CM.Lyrics.parse(raw);
    renderLyrics(state.currentLines);
  }
  function renderLyrics(lines) {
    var box = $('lyrics');
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
      box.appendChild(p);
      state.currentLineEls.push(p);
    });
  }
  function syncLyrics(time) {
    if (!state.lyricsOn || !state.currentLines.length) return;
    var idx = CM.Lyrics.activeIndex(state.currentLines, time);
    var els = state.currentLineEls;
    els.forEach(function (el, i) { el.classList.toggle('active', i === idx); });
    var active = els[idx];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* ---------- 主题 ---------- */
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('cm-theme', cur); } catch (e) {}
    $('btn-theme').textContent = cur === 'dark' ? '☀️' : '🌙';
    if (CM.Visualizer) CM.Visualizer.resize();
  }

  /* ---------- 添加链接 ---------- */
  function openUrlModal() { $('url-modal').classList.remove('hidden'); }
  function closeUrlModal() { $('url-modal').classList.add('hidden'); $('url-input').value = ''; $('url-title').value = ''; $('url-artist').value = ''; $('url-lrc').value = ''; }
  function submitUrl() {
    var url = $('url-input').value.trim();
    if (!url) { toast('请填写歌曲链接'); return; }
    var id = 'remote-' + Date.now();
    var rec = {
      id: id,
      title: $('url-title').value.trim() || url.split('/').pop().split('?')[0] || '远程歌曲',
      artist: $('url-artist').value.trim() || '未知歌手',
      url: url,
      cover: pickCover(id),
      source: 'remote',
      addedAt: Date.now()
    };
    var lrcUrl = $('url-lrc').value.trim();
    function finish() { state.remote.push(rec); saveRemote(); state.master.push(rec); rebuild(); closeUrlModal(); toast('已添加：' + rec.title); }
    if (lrcUrl) {
      fetch(lrcUrl).then(function (r) { return r.text(); }).then(function (txt) {
        state.lyrics[id] = txt; saveLyrics(); rec.lrc = txt; finish();
      }).catch(function () { toast('歌词获取失败，仅添加歌曲'); finish(); });
    } else finish();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    CM.Visualizer.init($('visualizer'));
    CM.Player.init();
    CM.Playlist.init({ onPlay: playAt, onRemove: removeTrack, onReorder: reorder });

    loadRemote(); loadLyrics(); loadSettings();

    // 本地歌曲（异步）
    CM.Storage.getAll().then(function (local) {
      local.forEach(function (r) {
        r.source = 'local';
        r.cover = r.cover || pickCover(r.id);
        state.master.push(r);
      });
      // 若列表仍为空，自动载入示例曲，避免开屏空白
      if (!state.master.length) addSampleIfAbsent();
      else rebuild();
    }).catch(function () {
      if (!state.master.length) addSampleIfAbsent(); else rebuild();
    });

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
      CM.Playlist.setCurrent(CM.Player.getIndex());
      showLyricsFor(track);
      $('btn-play').textContent = '⏸';
    });
    CM.Player.on('time', function (cur, dur) {
      $('time-current').textContent = fmt(cur);
      $('time-total').textContent = fmt(dur);
      if (dur > 0 && !seeking) $('seek').value = Math.round((cur / dur) * 1000);
      syncLyrics(cur);
    });
    CM.Player.on('meta', function () {});
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
      state.lyricsOn = !state.lyricsOn;
      $('lyrics-panel').classList.toggle('hidden', !state.lyricsOn);
      this.classList.toggle('active', state.lyricsOn);
      if (state.lyricsOn) syncLyrics(CM.Player.getTrack() ? 0 : 0);
    });

    $('btn-theme').addEventListener('click', toggleTheme);

    // 上传
    $('btn-upload').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      files.forEach(function (f) {
        var name = f.name.replace(/\.[^.]+$/, '');
        var rec = {
          id: 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1e4),
          title: name, artist: '本地', file: f,
          cover: pickCover(name), source: 'local', addedAt: Date.now()
        };
        if (CM.ID3) {
          CM.ID3.parseCover(f).then(function (url) {
            if (url) rec.cover = url;
            appendLocal(rec);
          }).catch(function () { appendLocal(rec); });
        } else {
          appendLocal(rec);
        }
      });
      e.target.value = '';
      if (files.length) toast('已添加 ' + files.length + ' 首本地歌曲');
    });

    $('btn-add-url').addEventListener('click', openUrlModal);
    $('url-cancel').addEventListener('click', closeUrlModal);
    $('url-ok').addEventListener('click', submitUrl);
    $('url-modal').addEventListener('click', function (e) { if (e.target === this) closeUrlModal(); });

    $('btn-load-samples').addEventListener('click', addSampleIfAbsent);

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

    // 初始化主题按钮图标
    $('btn-theme').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
