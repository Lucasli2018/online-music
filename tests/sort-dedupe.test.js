/* tests/sort-dedupe.test.js — 5E 曲库管理纯逻辑
 * 覆盖排序（六种模式 + 默认不排序）与重复歌曲检测（指纹规范化、分组、保留优先级）。
 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function lib() { return helpers.loadCM(['library.js']).Library; }

function t(id, extra) {
  return Object.assign({ id: id, title: id, artist: 'A' }, extra || {});
}
function ids(list) { return helpers.plain(list.map(function (x) { return x.id; })); }

/* ---------- 排序 ---------- */

test('排序：模式表包含默认顺序与六种排序', function () {
  var L = lib();
  var modes = helpers.plain(Object.keys(L.SORT_MODES));
  assert.deepStrictEqual(modes, ['default', 'added', 'title', 'artist', 'duration', 'plays', 'recent']);
});

test('排序：默认模式保持歌单自身顺序，且不修改原数组', function () {
  var L = lib();
  var src = [t('c'), t('a'), t('b')];
  var out = L.sortTracks(src, 'default');
  assert.deepStrictEqual(ids(out), ['c', 'a', 'b']);
  assert.notStrictEqual(out, src, '应返回新数组，避免调用方误改曲库顺序');
  assert.deepStrictEqual(ids(src), ['c', 'a', 'b'], '原数组不应被排序');
});

test('排序：未知模式退化为默认顺序', function () {
  var L = lib();
  assert.deepStrictEqual(ids(L.sortTracks([t('b'), t('a')], '不存在')), ['b', 'a']);
  assert.deepStrictEqual(ids(L.sortTracks([t('b'), t('a')], '')), ['b', 'a']);
});

test('排序：按歌名（缺失标题视为空串，排在最前）', function () {
  var L = lib();
  var out = L.sortTracks([t('c', { title: 'C' }), { id: 'x' }, t('a', { title: 'A' })], 'title');
  assert.deepStrictEqual(ids(out), ['x', 'a', 'c']);
});

test('排序：按歌手，同歌手内再按歌名', function () {
  var L = lib();
  var out = L.sortTracks([
    t('1', { artist: 'B', title: 'Z' }),
    t('2', { artist: 'A', title: 'Y' }),
    t('3', { artist: 'B', title: 'A' })
  ], 'artist');
  assert.deepStrictEqual(ids(out), ['2', '3', '1']);
});

test('排序：按时长降序（缺失时长视为 0）', function () {
  var L = lib();
  var out = L.sortTracks([t('a', { duration: 100 }), t('b'), t('c', { duration: 300 })], 'duration');
  assert.deepStrictEqual(ids(out), ['c', 'a', 'b']);
});

test('排序：按添加时间升序（缺失视为 0）', function () {
  var L = lib();
  var out = L.sortTracks([
    t('a', { addedAt: 300 }), t('b', { addedAt: 100 }), t('c')
  ], 'added');
  assert.deepStrictEqual(ids(out), ['c', 'b', 'a']);
});

test('排序：按播放次数降序，次数相同用最近播放兜底', function () {
  var L = lib();
  var stats = { a: { c: 2, at: 100 }, b: { c: 5, at: 10 }, c: { c: 2, at: 900 } };
  var out = L.sortTracks([t('a'), t('b'), t('c')], 'plays', stats);
  assert.deepStrictEqual(ids(out), ['b', 'c', 'a']);
});

test('排序：按最近播放降序，无统计的排最后', function () {
  var L = lib();
  var stats = { a: { c: 1, at: 100 }, c: { c: 9, at: 500 } };
  var out = L.sortTracks([t('a'), t('b'), t('c')], 'recent', stats);
  assert.deepStrictEqual(ids(out), ['c', 'a', 'b']);
});

test('排序：空输入与缺省 stats 均安全', function () {
  var L = lib();
  assert.deepStrictEqual(helpers.plain(L.sortTracks([], 'plays')), []);
  assert.deepStrictEqual(helpers.plain(L.sortTracks(null, 'title')), []);
  assert.strictEqual(L.sortTracks([t('a'), t('b')], 'plays').length, 2);
});

/* ---------- 重复歌曲检测 ---------- */

test('指纹：忽略大小写、扩展名、标点与空白', function () {
  var L = lib();
  assert.strictEqual(L.normalizeText('Hello World.mp3'), 'helloworld');
  assert.strictEqual(L.normalizeText('Hello World'), 'helloworld');
  assert.strictEqual(L.normalizeText('Hello, World!'), 'helloworld');
  assert.strictEqual(L.normalizeText('  多 余 空 格  '), '多余空格');
  assert.strictEqual(L.normalizeText('A - B (Live)'), 'ab', '括号连同内容一起去掉（版本标记）');
  assert.strictEqual(L.normalizeText('Song【无损】'), 'song');
  assert.strictEqual(L.normalizeText('Song (Official Video).flac'), 'song');
  assert.strictEqual(L.normalizeText('Song (未闭合'), 'song未闭合', '不成对的括号只去掉符号本身');
  assert.strictEqual(L.normalizeText(null), '');
});

test('指纹：标题相同但歌手不同不算重复', function () {
  var L = lib();
  assert.notStrictEqual(L.dupKey({ title: 'X', artist: 'A' }), L.dupKey({ title: 'X', artist: 'B' }));
});

test('检测：标题 + 歌手相同才归组，不同标题各自独立', function () {
  var L = lib();
  var groups = helpers.plain(L.findDuplicates([
    { id: '1', title: 'Song', artist: 'A' },
    { id: '2', title: 'song', artist: 'a', duration: 100 },
    { id: '3', title: 'Other', artist: 'A' }
  ]).map(function (g) { return g.map(function (x) { return x.id; }); }));
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].sort(), ['1', '2']);
});

test('检测：单条不成组；标题与歌手都为空的不参与判定', function () {
  var L = lib();
  var groups = L.findDuplicates([
    { id: '1', title: 'Solo', artist: 'A' },
    { id: '2', title: '', artist: '' },
    { id: '3', title: '', artist: '' }
  ]);
  assert.strictEqual(groups.length, 0);
});

test('检测：组内按信息完整度排序（有时长的排前面）', function () {
  var L = lib();
  var groups = helpers.plain(L.findDuplicates([
    { id: 'noinfo', title: 'Song', artist: 'A' },
    { id: 'full', title: 'Song', artist: 'A', duration: 200, cover: 'https://c/x.jpg', lrc: '[00:00]x' },
    { id: 'half', title: 'Song', artist: 'A', duration: 200 }
  ]));
  assert.deepStrictEqual(groups[0].map(function (x) { return x.id; }), ['full', 'half', 'noinfo']);
});

test('检测：条目多的组排在前面', function () {
  var L = lib();
  var groups = helpers.plain(L.findDuplicates([
    { id: 'a1', title: 'A', artist: 'x' }, { id: 'a2', title: 'A', artist: 'x' },
    { id: 'b1', title: 'B', artist: 'x' }, { id: 'b2', title: 'B', artist: 'x' }, { id: 'b3', title: 'B', artist: 'x' }
  ]).map(function (g) { return g.length; }));
  assert.deepStrictEqual(groups, [3, 2], '3 条的组应排在 2 条的组前面');
});

test('完整度打分：时长 / 封面 / 歌词 / 持久来源分别加分', function () {
  var L = lib();
  assert.strictEqual(L.trackScore({}), 0);
  assert.strictEqual(L.trackScore({ duration: 10 }), 2);
  assert.strictEqual(L.trackScore({ duration: 10, cover: '#ff0000' }), 2, '渐变占位封面不算真实封面');
  assert.strictEqual(L.trackScore({ duration: 10, cover: 'https://c/x.jpg' }), 3);
  assert.strictEqual(L.trackScore({ duration: 10, lrc: 'x' }), 3);
  assert.strictEqual(L.trackScore({ source: 'local' }), 1);
  assert.strictEqual(L.trackScore({ source: 'cloud' }), 1);
  assert.strictEqual(L.trackScore({ source: 'online' }), 0);
});

test('检测：空输入 / 缺字段条目不会抛错', function () {
  var L = lib();
  assert.deepStrictEqual(helpers.plain(L.findDuplicates([])), []);
  assert.deepStrictEqual(helpers.plain(L.findDuplicates(null)), []);
  assert.deepStrictEqual(helpers.plain(L.findDuplicates([null, undefined, {}])), []);
});
