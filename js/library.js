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

  global.CM = global.CM || {};
  global.CM.Library = {
    tracks: tracks,
    get: get, allTracks: allTracks, addTrack: addTrack, removeTrack: removeTrack, resolve: resolve,
    getLists: getLists, getList: getList, getCurrentList: getCurrentList, setCurrentList: setCurrentList,
    addList: addList, renameList: renameList, removeList: removeList, listIds: listIds,
    addToList: addToList, removeFromList: removeFromList, isFav: isFav, toggleFav: toggleFav,
    loadRemote: loadRemote, saveRemote: saveRemote,
    setListIds: setListIds, setLists: setLists
  };
})(window);
