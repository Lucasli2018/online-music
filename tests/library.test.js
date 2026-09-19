/* tests/library.test.js — 曲库单一事实源 / 多歌单 / 收藏 / 持久化 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function newLib() { return helpers.loadCM(['library.js']).Library; }

test('addTrack: 歌曲入库并自动进入「全部」', function () {
  var lib = newLib();
  lib.addTrack({ id: 't1', title: 'A' });
  assert.strictEqual(lib.get('t1').title, 'A');
  assert.strictEqual(lib.allTracks().length, 1);
  assert.deepStrictEqual(helpers.plain(lib.listIds('all')), ['t1']);
});

test('addTrack: 同一 id 重复加入不会在「全部」中出现两次', function () {
  var lib = newLib();
  lib.addTrack({ id: 't1', title: 'A' });
  lib.addTrack({ id: 't1', title: 'A2' });
  assert.strictEqual(lib.allTracks().length, 1);
  assert.deepStrictEqual(helpers.plain(lib.listIds('all')), ['t1']);
  assert.strictEqual(lib.get('t1').title, 'A2');
});

test('addTrack: 缺少 id 的记录被忽略', function () {
  var lib = newLib();
  lib.addTrack({ title: '无 id' });
  lib.addTrack(null);
  assert.strictEqual(lib.allTracks().length, 0);
});

test('resolve: 按 id 顺序还原，缺失 id 被过滤', function () {
  var lib = newLib();
  lib.addTrack({ id: 'a' });
  lib.addTrack({ id: 'b' });
  assert.deepStrictEqual(helpers.plain(lib.resolve(['b', 'ghost', 'a']).map(function (t) { return t.id; })), ['b', 'a']);
  assert.deepStrictEqual(helpers.plain(lib.resolve(null)), []);
});

test('内置歌单 all / fav 默认存在', function () {
  var lib = newLib();
  assert.strictEqual(lib.getList('all').name, '全部');
  assert.strictEqual(lib.getList('fav').name, '收藏');
});

test('自定义歌单：新建 / 重命名 / 删除', function () {
  var lib = newLib();
  var id = lib.addList('我的歌单');
  assert.strictEqual(lib.getList(id).name, '我的歌单');
  lib.renameList(id, '改名后');
  assert.strictEqual(lib.getList(id).name, '改名后');
  lib.removeList(id);
  assert.strictEqual(lib.getList(id), undefined);
});

test('内置歌单不可被重命名或删除', function () {
  var lib = newLib();
  lib.renameList('all', 'X');
  lib.renameList('fav', 'Y');
  lib.removeList('all');
  lib.removeList('fav');
  assert.strictEqual(lib.getList('all').name, '全部');
  assert.strictEqual(lib.getList('fav').name, '收藏');
});

test('歌单存 id 引用：加入 / 移除 / 顺序', function () {
  var lib = newLib();
  var id = lib.addList('L');
  lib.addToList(id, 'a');
  lib.addToList(id, 'b');
  lib.addToList(id, 'a'); // 重复不叠加
  assert.deepStrictEqual(helpers.plain(lib.listIds(id)), ['a', 'b']);
  lib.removeFromList(id, 'a');
  assert.deepStrictEqual(helpers.plain(lib.listIds(id)), ['b']);
});

test('收藏：toggle 在两个状态间切换', function () {
  var lib = newLib();
  assert.strictEqual(lib.isFav('s1'), false);
  assert.strictEqual(lib.toggleFav('s1'), true);
  assert.strictEqual(lib.isFav('s1'), true);
  assert.deepStrictEqual(helpers.plain(lib.listIds('fav')), ['s1']);
  assert.strictEqual(lib.toggleFav('s1'), false);
  assert.strictEqual(lib.isFav('s1'), false);
});

test('removeTrack: 同时从曲库与所有歌单中清除', function () {
  var lib = newLib();
  var id = lib.addList('L');
  lib.addTrack({ id: 'x' });
  lib.addToList(id, 'x');
  lib.toggleFav('x');
  lib.removeTrack('x');
  assert.strictEqual(lib.get('x'), undefined);
  assert.deepStrictEqual(helpers.plain(lib.listIds('all')), []);
  assert.deepStrictEqual(helpers.plain(lib.listIds(id)), []);
  assert.deepStrictEqual(helpers.plain(lib.listIds('fav')), []);
});

test('setLists: 保留 all / fav 骨架，丢弃缺少 ids 的异常项', function () {
  var lib = newLib();
  lib.setLists({
    fav: { name: '收藏', ids: ['f1'] },
    'pl-1': { name: '备份歌单', ids: ['a'] },
    broken: { name: '坏数据' },
    all: null
  });
  assert.deepStrictEqual(helpers.plain(lib.listIds('all')), []);
  assert.deepStrictEqual(helpers.plain(lib.listIds('fav')), ['f1']);
  assert.deepStrictEqual(helpers.plain(lib.listIds('pl-1')), ['a']);
  assert.strictEqual(lib.getList('broken'), undefined);
});

test('setLists: 非法入参直接忽略', function () {
  var lib = newLib();
  lib.addTrack({ id: 'keep' });
  lib.setLists(null);
  lib.setLists('不是对象');
  assert.deepStrictEqual(helpers.plain(lib.listIds('all')), ['keep']);
});

test('setListIds: 覆盖整个歌单顺序', function () {
  var lib = newLib();
  var id = lib.addList('L');
  lib.setListIds(id, ['c', 'a', 'b']);
  assert.deepStrictEqual(helpers.plain(lib.listIds(id)), ['c', 'a', 'b']);
});

test('当前歌单默认 all，可切换并持久化', function () {
  var store = helpers.createStorage();
  var libA = helpers.loadCM(['library.js'], { storage: store }).Library;
  assert.strictEqual(libA.getCurrentList(), 'all');
  libA.setCurrentList('fav');

  var libB = helpers.loadCM(['library.js'], { storage: store }).Library;
  assert.strictEqual(libB.getCurrentList(), 'fav');
});

test('曲库与歌单跨会话持久化（同一 localStorage 重载）', function () {
  var store = helpers.createStorage();
  var libA = helpers.loadCM(['library.js'], { storage: store }).Library;
  var listId = libA.addList('持久化歌单');
  libA.addTrack({ id: 'p1', title: 'P' });
  libA.addToList(listId, 'p1');
  libA.toggleFav('p1');

  var libB = helpers.loadCM(['library.js'], { storage: store }).Library;
  assert.strictEqual(libB.getList(listId).name, '持久化歌单');
  assert.deepStrictEqual(helpers.plain(libB.listIds(listId)), ['p1']);
  assert.deepStrictEqual(helpers.plain(libB.listIds('fav')), ['p1']);
});

test('远程歌曲列表：读写与损坏数据兜底', function () {
  var lib = newLib();
  assert.deepStrictEqual(helpers.plain(lib.loadRemote()), []);
  lib.saveRemote([{ id: 'r1' }]);
  assert.deepStrictEqual(helpers.plain(lib.loadRemote()), [{ id: 'r1' }]);
});
