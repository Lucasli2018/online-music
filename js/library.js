/* library.js — 曲库（单一事实源）+ 歌单 + 收藏
 * 设计：歌曲只在曲库存一份（track 对象），歌单只存 id 引用列表。
 *  - 本地歌：track.file 为 File 对象（IndexedDB 持久化）
 *  - 远程歌 / 示例曲：track.url 直链
 * 歌单 'all' 包含所有已加入的曲，'fav' 为收藏，用户可建自定义歌单。
 */
(function (global) {
  'use strict';

  var LS_LISTS = 'cm-playlists';
  var LS_CUR = 'cm-cur-list';
  var LS_REMOTE = 'cm-remote';

  var tracks = {}; // id -> track（单一事实源）

  function loadLists() {
    try { return JSON.parse(localStorage.getItem(LS_LISTS) || 'null'); } catch (e) { return null; }
  }
  function saveLists(lists) {
    try { localStorage.setItem(LS_LISTS, JSON.stringify(lists)); } catch (e) {}
  }

  var lists = loadLists();
  if (!lists || typeof lists !== 'object') lists = {};
  if (!lists.all) lists.all = { name: '全部', ids: [] };
  if (!lists.fav) lists.fav = { name: '收藏', ids: [] };

  function get(id) { return tracks[id]; }
  function allTracks() { return Object.keys(tracks).map(function (k) { return tracks[k]; }); }

  function addTrack(track) {
    if (!track || !track.id) return;
    tracks[track.id] = track;
    if (lists.all.ids.indexOf(track.id) < 0) lists.all.ids.push(track.id);
    saveLists(lists);
  }
  function removeTrack(id) {
    delete tracks[id];
    Object.keys(lists).forEach(function (k) {
      lists[k].ids = (lists[k].ids || []).filter(function (x) { return x !== id; });
    });
    saveLists(lists);
  }
  function resolve(ids) {
    return (ids || []).map(function (id) { return tracks[id]; }).filter(function (t) { return !!t; });
  }

  function getLists() { return lists; }
  function getList(id) { return lists[id]; }
  function getCurrentList() { return localStorage.getItem(LS_CUR) || 'all'; }
  function setCurrentList(id) { try { localStorage.setItem(LS_CUR, id); } catch (e) {} }

  function addList(name) {
    var id = 'pl-' + Date.now();
    lists[id] = { name: name || '新歌单', ids: [] };
    saveLists(lists);
    return id;
  }
  function renameList(id, name) {
    if (lists[id] && id !== 'all' && id !== 'fav') { lists[id].name = name; saveLists(lists); }
  }
  function removeList(id) {
    if (id !== 'all' && id !== 'fav') { delete lists[id]; saveLists(lists); }
  }
  function listIds(id) { return (lists[id] && lists[id].ids) || []; }
  function addToList(id, trackId) {
    if (lists[id] && lists[id].ids.indexOf(trackId) < 0) { lists[id].ids.push(trackId); saveLists(lists); }
  }
  function removeFromList(id, trackId) {
    if (lists[id]) { lists[id].ids = lists[id].ids.filter(function (x) { return x !== trackId; }); saveLists(lists); }
  }
  function setListIds(id, ids) {
    if (lists[id]) { lists[id].ids = ids || []; saveLists(lists); }
  }
  function setLists(next) {
    if (!next || typeof next !== 'object') return;
    var merged = {};
    merged.all = (next.all && next.all.ids) ? next.all : { name: '全部', ids: [] };
    merged.fav = (next.fav && next.fav.ids) ? next.fav : { name: '收藏', ids: [] };
    Object.keys(next).forEach(function (k) {
      if (k !== 'all' && k !== 'fav' && next[k] && next[k].ids) merged[k] = next[k];
    });
    lists = merged;
    saveLists(lists);
  }

  function isFav(id) { return lists.fav.ids.indexOf(id) >= 0; }
  function toggleFav(id) {
    if (isFav(id)) removeFromList('fav', id);
    else addToList('fav', id);
    return isFav(id);
  }

  function loadRemote() {
    try { return JSON.parse(localStorage.getItem(LS_REMOTE) || '[]'); } catch (e) { return []; }
  }
  function saveRemote(arr) {
    try { localStorage.setItem(LS_REMOTE, JSON.stringify(arr)); } catch (e) {}
  }

  /* ---------- 排序（5E）----------
   * mode = default 时保持歌单自身的 id 顺序（不排序），保证既有行为零变更。
   */
  var SORT_MODES = {
    default: '默认顺序',
    added: '添加时间',
    title: '歌名',
    artist: '歌手',
    duration: '时长',
    plays: '播放次数',
    recent: '最近播放'
  };

  function cmpText(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN');
  }

  function sortTracks(tracks, mode, stats) {
    var list = (tracks || []).slice();
    if (!mode || mode === 'default' || !SORT_MODES[mode]) return list;
    stats = stats || {};
    var st = function (t) { return stats[t.id] || {}; };
    if (mode === 'title') {
      list.sort(function (a, b) { return cmpText(a.title, b.title); });
    } else if (mode === 'artist') {
      list.sort(function (a, b) {
        return cmpText(a.artist, b.artist) || cmpText(a.title, b.title);
      });
    } else if (mode === 'duration') {
      list.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });
    } else if (mode === 'plays') {
      list.sort(function (a, b) {
        return (st(b).c || 0) - (st(a).c || 0) || (st(b).at || 0) - (st(a).at || 0);
      });
    } else if (mode === 'recent') {
      list.sort(function (a, b) { return (st(b).at || 0) - (st(a).at || 0); });
    } else if (mode === 'added') {
      list.sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
    }
    return list;
  }

  /* ---------- 重复歌曲检测（5E）----------
   * 指纹只用「标题 + 歌手」的规范化文本，不含时长 —— 同一首歌来自不同音源时
   * 时长常差几秒（试听版 / 完整版），带上时长反而会漏判。
   * 代价是「同名不同版本」可能被归为一组，因此去重页面必须让用户逐组确认。
   */
  function normalizeText(s) {
    return String(s || '').toLowerCase()
      .replace(/\.(mp3|m4a|wav|flac|ogg|oga|aac|opus|weba?|ape|wma)$/, '')
      // 先连括号内容一起去掉：文件名里的 (Live) / (Remastered) / 【无损】 多是版本噪声
      .replace(/[（(\[【<《][^）)\]】>》]*[）)\]】>》]/g, '')
      // 再去掉残留的标点与空白，得到纯文本指纹
      .replace(/[\s\-_·、，,。.!！?？'"“”‘’()（）\[\]【】<>《》|/\\]+/g, '')
      .trim();
  }
  function dupKey(t) {
    return normalizeText(t && t.title) + '|' + normalizeText(t && t.artist);
  }
  // 信息完整度：有时长 / 真实封面 / 内嵌歌词 / 云端持久 的更值得保留
  function trackScore(t) {
    var s = 0;
    if (t.duration > 0) s += 2;
    if (t.cover && (t.cover.indexOf('http') === 0 || t.cover.indexOf('data:') === 0)) s += 1;
    if (t.lrc) s += 1;
    if (t.source === 'cloud' || t.source === 'local') s += 1;
    return s;
  }
  function findDuplicates(tracks) {
    var map = {};
    (tracks || []).forEach(function (t) {
      if (!t || !t.id) return;
      var k = dupKey(t);
      if (!k || k === '|') return;   // 标题与歌手都为空，无法判定重
      (map[k] = map[k] || []).push(t);
    });
    var groups = [];
    Object.keys(map).forEach(function (k) {
      if (map[k].length > 1) {
        map[k].sort(function (a, b) {
          return trackScore(b) - trackScore(a) || (b.addedAt || 0) - (a.addedAt || 0);
        });
        groups.push(map[k]);
      }
    });
    // 条目多的组排在前面，用户先看到「重得最厉害」的
    groups.sort(function (a, b) { return b.length - a.length; });
    return groups;
  }

  global.CM = global.CM || {};
  global.CM.Library = {
    tracks: tracks,
    get: get, allTracks: allTracks, addTrack: addTrack, removeTrack: removeTrack, resolve: resolve,
    getLists: getLists, getList: getList, getCurrentList: getCurrentList, setCurrentList: setCurrentList,
    addList: addList, renameList: renameList, removeList: removeList, listIds: listIds,
    addToList: addToList, removeFromList: removeFromList, isFav: isFav, toggleFav: toggleFav,
    loadRemote: loadRemote, saveRemote: saveRemote,
    setListIds: setListIds, setLists: setLists,
    SORT_MODES: SORT_MODES, sortTracks: sortTracks,
    normalizeText: normalizeText, dupKey: dupKey, trackScore: trackScore, findDuplicates: findDuplicates
  };
})(window);
