# OpenClaw Panel

多实例 OpenClaw Gateway 管理面板，支持 WebSocket 实时通信、会话管理、消息收发。

## 功能特性

- 🖥️ **多实例管理** — 同时连接多个 Gateway 实例
- 💬 **实时聊天** — WebSocket 双向通信，消息实时同步
- 📎 **附件上传** — 支持拖拽上传图片/文件，图片在线预览
- 🔍 **消息搜索** — 聊天区内搜索过滤
- ⌨️ **命令补全** — 输入 `/` 弹出命令菜单
- 🎨 **Markdown 工具栏** — 粗体、斜体、代码块一键插入
- 🖼️ **图片灯箱** — 点击放大查看
- 📱 **移动端适配** — 响应式布局
- 🐳 **Docker 部署** — 一键启动

## 下载安装

前往 [Releases](https://github.com/yangpengGitHub/openclaw-panel/releases) 下载最新版本：

| 平台 | 文件 | 说明 |
|------|------|------|
| 🪟 Windows | `OpenClaw Panel_*.exe` | NSIS 安装包 |
| 🐧 Linux | `openclaw-panel_*.deb` | Debian/Ubuntu |
| 🐧 Linux | `openclaw-panel_*.AppImage` | 通用 Linux |
| 🤖 Android | `app-universal-release.apk` | Android 手机/平板 |

> 桌面端基于 [Tauri 2](https://v2.tauri.app/) 构建，体积小、性能好。

## 快速开始

### 本地运行（Web 版）

```bash
git clone https://github.com/yangpengGitHub/openclaw-panel.git
cd openclaw-panel
npm install
node server.js
```

访问 http://localhost:19800

### Docker 部署

```bash
docker compose up -d
docker compose logs -f    # 查看日志
docker compose down       # 停止
```

### 桌面端开发

```bash
npm install
npx tauri dev             # 启动桌面开发模式
```

## 配置

首次打开面板时，点击 `+` 添加 Gateway 实例：

| 字段 | 说明 |
|------|------|
| 名称 | 实例显示名称 |
| WebSocket 地址 | Gateway WS 地址，如 `ws://localhost:18789` |
| Token | Gateway 认证 token（如有） |
| 描述 | 可选，简短说明 |

配置保存在 `config.json` 中。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+K` | 搜索会话 |
| `Ctrl+N` | 新建会话 |
| `Ctrl+R` | 刷新会话列表 |
| `Ctrl+B` | 粗体 |
| `Ctrl+I` | 斜体 |
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `/` | 命令菜单 |

## 技术栈

- **前端**: 原生 HTML/CSS/JS（无框架依赖）
- **后端**: Express + WebSocket (ws)
- **桌面端**: Tauri 2 (Rust + WebView)
- **部署**: Docker + docker-compose

## 项目结构

```
openclaw-panel/
├── server.js              # 主服务
├── lib/
│   └── gateway.js         # Gateway WebSocket 连接
├── public/
│   ├── index.html         # 前端页面
│   ├── app.js             # 前端逻辑
│   ├── manifest.json      # PWA 配置
│   └── sw.js              # Service Worker
├── src-tauri/             # Tauri 桌面端
│   ├── src/
│   │   ├── main.rs        # 入口
│   │   └── lib.rs         # 应用逻辑
│   ├── tauri.conf.json    # Tauri 配置
│   ├── Cargo.toml
│   └── icons/             # 应用图标
├── .github/workflows/
│   └── build.yml          # CI: 三平台自动构建
├── config.json            # 实例配置
├── uploads/               # 上传文件目录
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## 构建

```bash
# Windows
npm run tauri:build:win

# Linux
npm run tauri:build:linux

# Android
npm run tauri:build:android
```

打 tag 自动触发 GitHub Actions 构建三平台安装包：

```bash
git tag v2.x.x
git push origin v2.x.x
```

## License

MIT
