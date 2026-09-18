/* samples.js — 内置示例曲（远程直链，仅作演示）
 * 来源：SoundHelix 提供的免费示例音频（用于播放器功能演示，非商业用途）。
 * 这些链接需要联网才能播放；可视化对远程非同源音频降级为装饰动画。
 */
(function (global) {
  'use strict';

  var gradients = [
    'linear-gradient(135deg,#ff9a6c,#ff5e62)',
    'linear-gradient(135deg,#ffb88c,#de6262)',
    'linear-gradient(135deg,#ff7e5f,#feb47b)',
    'linear-gradient(135deg,#f6d365,#fda085)',
    'linear-gradient(135deg,#f093fb,#f5576c)'
  ];

  var raw = [
    { title: 'SoundHelix 示例 1', artist: 'Demo', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
    { title: 'SoundHelix 示例 2', artist: 'Demo', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
    { title: 'SoundHelix 示例 3', artist: 'Demo', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
    { title: 'SoundHelix 示例 4', artist: 'Demo', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
    { title: 'SoundHelix 示例 5', artist: 'Demo', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3' }
  ];

  var samples = raw.map(function (s, i) {
    return {
      id: 'sample-' + (i + 1),
      title: s.title,
      artist: s.artist,
      url: s.url,
      cover: gradients[i % gradients.length],
      source: 'sample',
      addedAt: Date.now()
    };
  });

  global.CM = global.CM || {};
  global.CM.samples = samples;
})(window);
