/* tests/online.test.js — 在线音源注册表 / 记录归一化 / 各音源适配 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var helpers = require('./helpers');

var GD_ROUTE = /gdstudio\.xyz/;

/* 按 types 参数分派的 GD 音乐台替身 */
function gdHandler(url) {
  if (url.indexOf('types=search') >= 0) {
    return helpers.jsonResponse([
      { id: 1001, name: '晴天', artist: ['周杰伦'], album: '叶惠美', pic_id: 'p1001', lyric_id: 'l1001' },
      { id: '', name: '无效曲目', artist: ['X'] },
      { id: 1002, name: '七里香', artist: '周杰伦', album: '七里香', pic_id: '', lyric_id: '' }
    ]);
  }
  if (url.indexOf('types=url') >= 0) return helpers.jsonResponse({ url: 'https://cdn.example.com/1001.mp3', br: 320 });
  if (url.indexOf('types=pic') >= 0) return helpers.textResponse('https://img.example.com/p1001.jpg');
  if (url.indexOf('types=lyric') >= 0) return helpers.jsonResponse({ lyric: '[00:01.00]A', tlyric: '[00:01.00]B' });
  return helpers.jsonResponse({});
}

function load(fetchImpl) {
  return helpers.loadCM(['online.js', 'sources.js'], { fetch: fetchImpl });
}

function defaultFetch() {
  return helpers.mockFetch([
    [/audius\.co\/v1\/tracks\/search/, function () {
      return helpers.jsonResponse({
        data: [
          { id: 'a1', title: '流媒体正常', user: { name: '用户A' }, duration: 200, artwork: { '480x480': 'https://c/a1.jpg' }, genre: 'Electronic' },
          { id: 'a2', title: '不可播', user: { name: '用户B' }, is_streamable: false },
          { id: 'a3', title: '门控曲目', user: { name: '用户C' }, is_stream_gated: true },
          { id: null, title: '无 id' }
        ]
      });
    }],
    [/audius\.co\/v1\/tracks\/[^/?]+\?/, function () { return helpers.jsonResponse({}); }],
    [GD_ROUTE, gdHandler],
    [/jamendo\.com/, function () {
      return helpers.jsonResponse({
        headers: { status: 'success' },
        results: [
          { id: 'j1', name: 'CC 曲目', artist_name: 'Jam', duration: 180, image: 'https://j/1.jpg', album_name: 'Alb', audio: 'https://j/1.mp3' },
          { id: 'j2', name: '无音频', artist_name: 'Jam', audio: '' }
        ]
      });
    }],
    [/itunes\.apple\.com/, function () {
      return helpers.jsonResponse({
        results: [
          { trackId: 1, trackName: '试听曲', artistName: '歌手', trackTimeMillis: 210000, artworkUrl100: 'https://i/100x100bb.jpg', collectionName: '专辑', primaryGenreName: 'Pop', previewUrl: 'https://i/p.m4a' },
          { trackId: 2, trackName: '无试听', artistName: '歌手' }
        ]
      });
    }]
  ]);
}

test('音源注册表：内置与追加音源均可发现', function () {
  var CM = load(defaultFetch());
  var ids = CM.Online.getSources().map(function (s) { return s.id; }).sort();
  assert.deepStrictEqual(helpers.plain(ids), ['audius', 'gdstudio', 'itunes', 'jamendo']);
});

test('默认音源为 Audius，非法音源切换被拒绝', function () {
  var CM = load(defaultFetch());
  assert.strictEqual(CM.Online.getSource(), 'audius');
  assert.strictEqual(CM.Online.setSource('不存在'), false);
  assert.strictEqual(CM.Online.getSource(), 'audius');
  assert.strictEqual(CM.Online.setSource('gdstudio'), true);
  assert.strictEqual(CM.Online.getSource(), 'gdstudio');
});

test('音源选择跨会话恢复', function () {
  var store = helpers.createStorage();
  var CMa = helpers.loadCM(['online.js', 'sources.js'], { fetch: defaultFetch(), storage: store });
  CMa.Online.setSource('itunes');
  var CMb = helpers.loadCM(['online.js', 'sources.js'], { fetch: defaultFetch(), storage: store });
  CMb.Online.loadSource();
  assert.strictEqual(CMb.Online.getSource(), 'itunes');
});

test('toRecord: 记录 id 规则按音源区分（Audius 沿用历史前缀）', function () {
  var CM = load(defaultFetch());
  assert.strictEqual(CM.Online.toRecord({ sid: 'audius', id: 'a1', title: 'T' }).id, 'audius-a1');
  assert.strictEqual(CM.Online.toRecord({ sid: 'gdstudio', id: '1001', title: 'T' }).id, 'ol-gdstudio-1001');
  assert.strictEqual(CM.Online.toRecord({ sid: 'jamendo', id: 'j1', title: 'T' }).id, 'ol-jamendo-j1');
});

test('toRecord: 曲库记录字段与默认值', function () {
  var CM = load(defaultFetch());
  var rec = CM.Online.toRecord({ sid: 'itunes', id: '1' });
  assert.strictEqual(rec.title, '未知标题');
  assert.strictEqual(rec.artist, '未知艺术家');
  assert.strictEqual(rec.source, 'online');
  assert.strictEqual(rec.cover, '');
  assert.strictEqual(rec.album, '');
  assert.strictEqual(rec.duration, 0);
  assert.strictEqual(rec.preview, false);
  assert.strictEqual(typeof rec.addedAt, 'number');
  assert.ok(rec.addedAt > 0);
});

test('toRecord: 透传 GD 二次解析所需的歌词/封面/子源信息', function () {
  var CM = load(defaultFetch());
  var rec = CM.Online.toRecord({
    sid: 'gdstudio', id: '1001', title: '晴天', artist: '周杰伦',
    playUrl: 'https://x/1.mp3', lyricId: 'l1001', lyricSource: 'netease', picId: 'p1001', gsub: 'kuwo'
  });
  assert.strictEqual(rec.lid, 'l1001');
  assert.strictEqual(rec.lsrc, 'netease');
  assert.strictEqual(rec.pid, 'p1001');
  assert.strictEqual(rec.gsub, 'kuwo');
  assert.strictEqual(rec.oid, '1001');
  assert.strictEqual(rec.url, 'https://x/1.mp3');
});

test('toRecord: 无歌词/封面 id 时不写入冗余字段', function () {
  var CM = load(defaultFetch());
  var rec = CM.Online.toRecord({ sid: 'audius', id: 'a1', title: 'T' });
  assert.strictEqual(rec.lid, undefined);
  assert.strictEqual(rec.pid, undefined);
  assert.strictEqual(rec.gsub, undefined);
});

test('audius: 搜索结果过滤不可播与门控曲目', function () {
  var CM = load(defaultFetch());
  return CM.Online.search('测试', 20).then(function (list) {
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'a1');
    assert.strictEqual(list[0].sid, 'audius');
    assert.strictEqual(list[0].artist, '用户A');
    assert.strictEqual(list[0].cover, 'https://c/a1.jpg');
  });
});

test('audius: streamUrl 指向流端点并带 app_name', function () {
  var CM = load(defaultFetch());
  var u = CM.Online.streamUrl('abc');
  assert.ok(u.indexOf('/tracks/abc/stream') > 0);
  assert.ok(u.indexOf('app_name=CoralMusic') > 0);
});

test('gdstudio: 搜索结果归一化并丢弃无 id 项', function () {
  var CM = load(defaultFetch());
  CM.Online.setSource('gdstudio');
  return CM.Online.search('周杰伦', 10).then(function (list) {
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, '1001');
    assert.strictEqual(list[0].artist, '周杰伦');
    assert.strictEqual(list[0].needsResolve, true);
    assert.strictEqual(list[0].lyricId, 'l1001');
    assert.strictEqual(list[0].picId, 'p1001');
    assert.strictEqual(list[0].gsub, 'netease');
    assert.strictEqual(list[0].preview, false);
    assert.strictEqual(list[1].artist, '周杰伦');
  });
});

test('gdstudio: prepare 二次解析出播放地址与封面', function () {
  var CM = load(defaultFetch());
  var item = { sid: 'gdstudio', id: '1001', title: '晴天', playUrl: '', picId: 'p1001', gsub: 'netease' };
  return CM.Online.prepare(item).then(function (out) {
    assert.strictEqual(out.playUrl, 'https://cdn.example.com/1001.mp3');
    assert.strictEqual(out.cover, 'https://img.example.com/p1001.jpg');
  });
});

test('gdstudio: verify 在无播放链接时判定为不可播', function () {
  var badFetch = helpers.mockFetch([[GD_ROUTE, function (url) {
    if (url.indexOf('types=url') >= 0) return helpers.jsonResponse({ url: '' });
    return helpers.jsonResponse({});
  }]]);
  var CM = load(badFetch);
  return CM.Online.verify({ sid: 'gdstudio', id: 'x', playUrl: '', gsub: 'netease' }).then(function (ok) {
    assert.strictEqual(ok, false);
  });
});

test('gdstudio: 子音源配置只接受白名单值', function () {
  var CM = load(defaultFetch());
  var gd = CM.Online.getSources().filter(function (s) { return s.id === 'gdstudio'; })[0];
  assert.strictEqual(gd.getConfig(), 'netease');
  gd.setConfig('kuwo');
  assert.strictEqual(gd.getConfig(), 'kuwo');
  gd.setConfig('不存在的平台');
  assert.strictEqual(gd.getConfig(), 'netease');
  gd.setConfig('  KUWO  ');
  assert.strictEqual(gd.getConfig(), 'kuwo');
});

test('jamendo: 未配置 Client ID 时给出明确错误', function () {
  var CM = load(defaultFetch());
  CM.Online.setSource('jamendo');
  return CM.Online.search('jazz', 10).then(function () {
    throw new Error('本应被拒绝');
  }, function (err) {
    assert.ok(/Client ID/.test(err.message));
  });
});

test('jamendo: 配置后结果归一化，无音频项被丢弃', function () {
  var CM = load(defaultFetch());
  var jam = CM.Online.getSources().filter(function (s) { return s.id === 'jamendo'; })[0];
  jam.setConfig('my-client-id');
  assert.strictEqual(jam.getConfig(), 'my-client-id');
  CM.Online.setSource('jamendo');
  return CM.Online.search('jazz', 10).then(function (list) {
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'j1');
    assert.strictEqual(list[0].duration, 180);
    assert.strictEqual(list[0].playUrl, 'https://j/1.mp3');
    assert.strictEqual(list[0].preview, false);
  });
});

test('itunes: 仅保留带试听地址的结果并标记 preview', function () {
  var CM = load(defaultFetch());
  CM.Online.setSource('itunes');
  return CM.Online.search('song', 10).then(function (list) {
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, '1');
    assert.strictEqual(list[0].duration, 210);
    assert.strictEqual(list[0].cover, 'https://i/300x300bb.jpg');
    assert.strictEqual(list[0].preview, true);
  });
});

test('prepare: 无二次解析需求的音源原样返回同一对象', function () {
  var CM = load(defaultFetch());
  var item = { sid: 'itunes', id: '1', playUrl: 'https://i/p.m4a' };
  return CM.Online.prepare(item).then(function (out) {
    assert.strictEqual(out, item);
  });
});

test('prepare: 空入参安全返回', function () {
  var CM = load(defaultFetch());
  return CM.Online.prepare(null).then(function (out) {
    assert.strictEqual(out, null);
  });
});

test('verify: 无 verify 实现的音源以 playUrl 存在性判定', function () {
  var CM = load(defaultFetch());
  return CM.Online.verify({ sid: 'itunes', id: '1', playUrl: 'https://i/p.m4a' }).then(function (ok) {
    assert.strictEqual(ok, true);
  }).then(function () {
    return CM.Online.verify({ sid: 'itunes', id: '2', playUrl: '' });
  }).then(function (ok) {
    assert.strictEqual(ok, false);
  });
});

test('verify: 未知音源与空入参一律判定不可播', function () {
  var CM = load(defaultFetch());
  return CM.Online.verify(null).then(function (ok) {
    assert.strictEqual(ok, false);
  }).then(function () {
    return CM.Online.verify({ sid: '幽灵音源', playUrl: 'https://x' });
  }).then(function (ok) {
    assert.strictEqual(ok, false);
  });
});

test('search: 空关键词由 Audius 源自身兜底为空结果', function () {
  var CM = load(defaultFetch());
  return CM.Online.search('', 10).then(function (list) {
    assert.deepStrictEqual(helpers.plain(list), []);
  });
});
