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

## 快速开始

### 本地运行

```bash
# 克隆仓库
git clone https://github.com/YOUR_USERNAME/openclaw-panel.git
cd openclaw-panel

# 安装依赖
npm install

# 启动
node server.js
```

访问 http://localhost:19800

### Docker 部署

```bash
# 一键启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
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
- **部署**: Docker + docker-compose

## 项目结构

```
openclaw-panel/
├── server.js          # 主服务
├── lib/
│   └── gateway.js     # Gateway WebSocket 连接
├── public/
│   ├── index.html     # 前端页面（构建生成）
│   └── app.js         # 前端逻辑
├── build.js           # HTML 构建脚本
├── config.json        # 实例配置
├── uploads/           # 上传文件目录
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## License

MIT
