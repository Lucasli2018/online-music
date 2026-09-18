# 🍊 珊瑚音乐 · Coral Music

一个**纯静态、零依赖、零构建**的在线音乐播放器，可一键部署到 [Cloudflare Pages](https://pages.cloudflare.com/)。

珊瑚橙主题，支持浅色 / 深色模式，所有歌曲数据只存在你自己的浏览器里（不上传任何服务器）。

---

## ✨ 功能

- **三种音源，随心切换**
  - 💾 **本地上传**：从电脑选歌，用 IndexedDB 持久化，刷新 / 重开浏览器后仍在
  - 🎵 **内置示例曲**：5 首免版权示例音频（SoundHelix 直链），一键载入试听
  - 🔗 **远程链接**：粘贴 mp3 / m4a 等直链添加歌曲，可选填 LRC 歌词地址
- **音频可视化**：本地歌曲走 Web Audio 画真实频谱；远程 / 示例曲跨域无法读数据时自动降级为装饰动画（避免被静音）
- **播放列表管理**：点击播放、拖拽排序、删除、随机播放、单曲 / 列表循环
- **歌词**：LRC 解析 + 同步滚动高亮，可手动粘贴编辑歌词
- **深色模式**：珊瑚橙主题，偏好记忆在 localStorage
- **快捷键**：`空格` 播放/暂停，`←` `→` 上一首/下一首

---

## 🗂 项目结构

```
music-player/
├── index.html          # 页面骨架（含防深色模式闪烁的主题脚本）
├── css/
│   └── style.css        # 珊瑚橙主题 + 深色模式（CSS 变量切换）
├── js/
│   ├── storage.js       # 本地歌曲 IndexedDB 持久化
│   ├── samples.js       # 内置示例曲数据
│   ├── lyrics.js        # LRC 解析与同步定位
│   ├── visualizer.js    # Canvas 频谱可视化
│   ├── player.js        # 双 audio 播放引擎 + Web Audio
│   ├── playlist.js      # 歌单渲染 + 拖拽排序 + 删除
│   └── app.js           # 总控（存储 / 播放 / 歌词 / 主题 / 快捷键）
└── wrangler.toml        # Cloudflare Pages 部署配置
```

---

## 💻 本地运行

无需任何依赖与构建，用任意静态服务器打开即可（直接双击 `index.html` 也能跑，但用本地服务器能避免个别浏览器对 `file://` 的限制）：

```bash
# Python
cd music-player
python -m http.server 8080
# 浏览器打开 http://localhost:8080

# 或 Node
npx serve music-player
```

---

## 🚀 部署到 Cloudflare Pages

### 方式一：Cloudflare 控制台（推荐）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages**
2. 连接 Git 仓库 `li-luoqiang/music-player`
3. 构建配置：
   - **Framework preset**：`None`
   - **Build command**：留空
   - **Build output directory**：`.`
4. 保存并部署，稍等片刻即可得到 `*.pages.dev` 地址

### 方式二：Wrangler CLI

```bash
npm install -g wrangler
cd music-player
wrangler pages deploy .
```

> 仓库已自带 `wrangler.toml`（`pages_build_output_dir = "."`），开箱即用。

---

## 📝 使用说明

| 操作 | 方式 |
| --- | --- |
| 添加本地歌曲 | 点右上角「＋ 上传音乐」选择音频文件 |
| 载入示例曲 | 点「🎵 示例曲」 |
| 添加远程歌曲 | 点「🔗 添加链接」，填直链（可附 LRC 歌词地址） |
| 编辑歌词 | 选中一首歌后，点歌词面板「✎ 编辑」粘贴 LRC 文本 |
| 切换深浅色 | 点右上角 🌙 / ☀️ |

---

## ⚠️ 注意事项

- **数据只存本地**：上传的歌曲、添加的远程链接、歌词与主题偏好都保存在当前浏览器，换设备或清缓存会丢失。
- **示例曲需联网**：SoundHelix 音频为在线直链，离线环境无法播放。
- **远程音频跨域**：若远程音频服务器未开启 CORS，播放正常但频谱可视化会降级为装饰动画（这是浏览器安全策略，非 bug）。
- **无后端**：本项目是纯前端静态站点，不包含任何服务器端代码，天然适配 Cloudflare Pages 的静态托管。

---

## 📄 开源说明

示例代码音频来自 [SoundHelix](https://www.soundhelix.com/)，仅供功能演示，非商业用途。
