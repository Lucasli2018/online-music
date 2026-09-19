/* tests/lyrics.test.js — LRC 解析 / 高亮索引 / 编码探测 / 纯文本转 LRC */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

function L() { return helpers.loadCM(['lyrics.js']).Lyrics; }

test('parse: 基础时间标签', function () {
  var lines = L().parse('[00:01.00]第一句\n[00:05.50]第二句');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].time, 1);
  assert.strictEqual(lines[0].text, '第一句');
  assert.strictEqual(lines[1].time, 5.5);
  assert.strictEqual(lines[1].text, '第二句');
});

test('parse: 一行多时间标签会展开为多行', function () {
  var lines = L().parse('[00:01.00][00:05.00]重复句');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(helpers.plain(lines.map(function (l) { return l.time; })), [1, 5]);
  assert.strictEqual(lines[0].text, '重复句');
  assert.strictEqual(lines[1].text, '重复句');
});

test('parse: 毫秒补零规则（.5 视为 500ms，1:2.5 视为 62.5s）', function () {
  var Lx = L();
  assert.strictEqual(Lx.parse('[00:01.5]A')[0].time, 1.5);
  assert.strictEqual(Lx.parse('[01:02.5]B')[0].time, 62.5);
  assert.strictEqual(Lx.parse('[00:03.250]C')[0].time, 3.25);
});

test('parse: offset 正负偏移生效，且不产生负时间', function () {
  var Lx = L();
  var neg = Lx.parse('[offset:-500]\n[00:02.00]A');
  assert.strictEqual(neg[0].time, 1.5);

  var plain = Lx.parse('[offset:500]\n[00:02.00]A');
  assert.strictEqual(plain[0].time, 2.5);

  var pos = Lx.parse('[offset:+1000]\n[00:02.00]A');
  assert.strictEqual(pos[0].time, 3);

  var clamp = Lx.parse('[offset:-5000]\n[00:01.00]A');
  assert.strictEqual(clamp[0].time, 0);
});

test('parse: offset 标签带空格写法同样生效', function () {
  assert.strictEqual(L().parse('[ offset : -1500 ]\n[00:05.00]A')[0].time, 3.5);
});

test('parse: 忽略元数据标签与空行', function () {
  var lines = L().parse('[ti:歌名]\n[ar:歌手]\n[al:专辑]\n[by:某人]\n\n[00:01.00]正式歌词');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, '正式歌词');
});

test('parse: 空输入与纯空白返回空数组', function () {
  var Lx = L();
  assert.deepStrictEqual(helpers.plain(Lx.parse('')), []);
  assert.deepStrictEqual(helpers.plain(Lx.parse('   ')), []);
  assert.deepStrictEqual(helpers.plain(Lx.parse('\n\n\n')), []);
  assert.deepStrictEqual(helpers.plain(Lx.parse(null)), []);
  assert.deepStrictEqual(helpers.plain(Lx.parse(undefined)), []);
});

test('parse: 无文本的时间行填充为音符占位', function () {
  var lines = L().parse('[00:01.00]\n[00:05.00]   ');
  assert.strictEqual(lines[0].text, '♪');
  assert.strictEqual(lines[1].text, '♪');
});

test('parse: 三位以上分钟数不匹配时间标签（视为无效行丢弃）', function () {
  assert.deepStrictEqual(helpers.plain(L().parse('[100:00.00]超长分钟')), []);
});

test('parse: 乱序输入按时间升序输出', function () {
  var lines = L().parse('[00:30.00]C\n[00:10.00]A\n[00:20.00]B');
  assert.deepStrictEqual(helpers.plain(lines.map(function (l) { return l.text; })), ['A', 'B', 'C']);
});

test('parse: 逐字卡拉OK内联标签解析为 words', function () {
  var lines = L().parse('[00:10.00]<00:10.50>Hel<00:11.00>lo');
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(helpers.plain(lines[0].words), [
    { t: 10.5, w: 'Hel' },
    { t: 11, w: 'lo' }
  ]);
  assert.strictEqual(lines[0].text, '<00:10.50>Hel<00:11.00>lo');
});

test('parse: 无内联标签的行不产生 words', function () {
  var lines = L().parse('[00:10.00]普通歌词');
  assert.deepStrictEqual(helpers.plain(lines[0].words), []);
});

test('parse: 同时间戳双语行合并为 主文本 + sub', function () {
  var lines = L().parse('[00:01.00]Hello\n[00:01.00]你好');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, 'Hello');
  assert.strictEqual(lines[0].sub, '你好');
});

test('parse: 三行同时间戳的副文本用 / 连接', function () {
  var lines = L().parse('[00:01.00]Hello\n[00:01.00]你好\n[00:01.00]こんにちは');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].sub, '你好 / こんにちは');
});

test('parse: 不同时间戳的行不会被误合并', function () {
  var lines = L().parse('[00:01.00]Hello\n[00:02.00]你好');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].sub, undefined);
});

test('activeIndex: 空数组返回 -1', function () {
  assert.strictEqual(L().activeIndex([], 10), -1);
});

test('activeIndex: 首行之前定位到第 0 行，末行之后定位到最后一行', function () {
  var Lx = L();
  var lines = Lx.parse('[00:10.00]A\n[00:20.00]B\n[00:30.00]C');
  assert.strictEqual(Lx.activeIndex(lines, 0), 0);
  assert.strictEqual(Lx.activeIndex(lines, 9.999), 0);
  assert.strictEqual(Lx.activeIndex(lines, 999), 2);
});

test('activeIndex: 边界与中间定位（含整秒相等）', function () {
  var Lx = L();
  var lines = Lx.parse('[00:10.00]A\n[00:20.00]B\n[00:30.00]C');
  assert.strictEqual(Lx.activeIndex(lines, 10), 0);
  assert.strictEqual(Lx.activeIndex(lines, 10.001), 0);
  assert.strictEqual(Lx.activeIndex(lines, 20), 1);
  assert.strictEqual(Lx.activeIndex(lines, 25), 1);
  assert.strictEqual(Lx.activeIndex(lines, 30), 2);
});

test('plainToLrc: 过滤元数据行并按步长生成时间轴', function () {
  var Lx = L();
  var out = Lx.plainToLrc('第一行\n\n[lrc元数据]\n第二行', 4);
  var parsed = Lx.parse(out);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].time, 0);
  assert.strictEqual(parsed[0].text, '第一行');
  assert.strictEqual(parsed[1].time, 4);
  assert.strictEqual(parsed[1].text, '第二行');
});

test('plainToLrc: 未指定步长时默认 4 秒', function () {
  var parsed = L().parse(L().plainToLrc('A\nB\nC'));
  assert.deepStrictEqual(helpers.plain(parsed.map(function (l) { return l.time; })), [0, 4, 8]);
});

test('plainToLrc: 空文本返回空字符串', function () {
  assert.strictEqual(L().plainToLrc(''), '');
});

test('decode: 去除 UTF-8 BOM 并正确解码中文', function () {
  var Lx = L();
  var body = Buffer.from('[00:01.00]你好', 'utf8');
  var withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body]);
  assert.strictEqual(Lx.decode(withBom), '[00:01.00]你好');
});

test('decode: 非 UTF-8 字节流不抛异常（GBK 回退）', function () {
  var Lx = L();
  // "中文" 的 GBK 字节，严格 UTF-8 解码会失败，应走 GBK 回退
  var gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]);
  var out = Lx.decode(gbk);
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('decode: 输入字节流与 parse 串联可用', function () {
  var Lx = L();
  var buf = Buffer.from('[00:02.00]测试歌词', 'utf8');
  var lines = Lx.parse(Lx.decode(buf));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, '测试歌词');
  assert.strictEqual(lines[0].time, 2);
});
