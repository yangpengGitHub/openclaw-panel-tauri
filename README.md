# OpenClaw Panel - Windows Desktop App

Tauri 2 封装的 OpenClaw Panel 桌面客户端。

## 构建步骤（Windows）

### 1. 安装依赖

```powershell
# 安装 Rust (如果还没有)
# 访问 https://rustup.rs 下载 rustup-init.exe 并安装

# 安装 Node.js (如果还没有)
# 访问 https://nodejs.org 下载 LTS 版本

# 安装 Tauri 前置依赖
# https://v2.tauri.app/start/prerequisites/
# 需要安装 Microsoft C++ Build Tools + WebView2

# 安装 Tauri CLI
npm install -g @tauri-apps/cli
```

### 2. 克隆项目

```powershell
git clone <repo-url> openclaw-panel-tauri
cd openclaw-panel-tauri
```

### 3. 修改服务器地址

编辑 `src-tauri/tauri.conf.json`，把 `url` 和 `frontendDist` 改成你的树莓派地址：

```json
"windows": [{
  "url": "http://192.168.1.48:19800"
}],
"build": {
  "frontendDist": "http://192.168.1.48:19800"
}
```

### 4. 开发模式

```powershell
npm install
npm run dev
```

### 5. 构建安装包

```powershell
npm install
npm run build
```

构建产物在 `src-tauri/target/release/bundle/` 下：
- `nsis/` → NSIS 安装包（推荐）
- `msi/` → MSI 安装包

## 功能

- 🪟 独立窗口，不依赖浏览器
- 📌 系统托盘，关闭到托盘（不退出）
- 🔔 Windows 原生通知（通过 Service Worker）
- 📱 响应式布局，支持小窗口

## 配置

服务器地址硬编码在 `src-tauri/tauri.conf.json` 中。
后续版本将支持运行时配置（设置页面内修改）。

## 注意

- 需要树莓派上的 Express 服务正在运行
- Windows 需要安装 WebView2（Win11 自带，Win10 需要单独安装）
- 防火墙需要允许 19800 端口入站
