'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// ===== Single Instance Lock =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Panel] Another instance is running, quitting');
  app.quit();
}

let mainWindow = null;
let tray = null;
let serverProcess = null;

const PORT = process.env.PANEL_PORT || 19800;
const SERVER_URL = `http://localhost:${PORT}`;

// ===== Window State Persistence =====
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { width: 1200, height: 800, x: undefined, y: undefined, maximized: false };
  }
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: mainWindow.isMaximized()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    console.error('[Panel] Failed to save window state:', err.message);
  }
}

// ===== Server =====
function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'darwin', // Detach on Windows/Linux, not on macOS
      windowsHide: true, // Hide cmd window on Windows
    });

    // Allow the parent to exit independently on Windows
    if (process.platform === 'win32' && serverProcess.unref) {
      serverProcess.unref();
    }

    serverProcess.stdout.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.log('[Server]', msg);
    });
    serverProcess.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.error('[Server ERR]', msg);
    });

    const startTime = Date.now();
    const checkReady = () => {
      if (Date.now() - startTime > 15000) {
        reject(new Error('Server failed to start within 15s'));
        return;
      }
      const http = require('http');
      const req = http.get(SERVER_URL, res => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
        } else {
          res.resume();
          setTimeout(checkReady, 500);
        }
      });
      req.on('error', () => setTimeout(checkReady, 500));
      req.end();
    };
    checkReady();

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      console.log('[Server] exited with code', code);
      if (code !== 0 && !app.isQuitting) {
        setTimeout(() => startServer().catch(console.error), 2000);
      }
    });
  });
}

// ===== Window =====
function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width || 1200,
    height: state.height || 800,
    x: state.x,
    y: state.y,
    minWidth: 480,
    minHeight: 400,
    title: 'OpenClaw Panel',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true,
    show: false // Don't show until ready
  });

  // Restore maximized state
  if (state.maximized) {
    mainWindow.maximize();
  }

  // Show when ready to avoid visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL(SERVER_URL);

  // Save window state on resize/move (debounced)
  let saveTimer = null;
  const debouncedSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 500);
  };
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);
  mainWindow.on('maximize', () => saveWindowState());
  mainWindow.on('unmaximize', () => saveWindowState());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== Tray =====
function createTray() {
  let icon;
  try {
    const iconPath = path.join(__dirname, 'public', 'icon.png');
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (icon.isEmpty()) throw new Error('empty icon');
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开面板',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: '重启服务',
      click: async () => {
        if (serverProcess) serverProcess.kill();
        await new Promise(r => setTimeout(r, 1000));
        try {
          await startServer();
          if (mainWindow) mainWindow.loadURL(SERVER_URL);
        } catch (err) {
          console.error('[Panel] Restart failed:', err.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        if (serverProcess) serverProcess.kill();
        app.quit();
      }
    }
  ]);

  tray.setToolTip('OpenClaw Panel');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// ===== Second Instance Handler =====
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ===== App Lifecycle =====
app.whenReady().then(async () => {
  console.log('[Panel] Starting server on port', PORT);
  try {
    await startServer();
    console.log('[Panel] Server ready at', SERVER_URL);
  } catch (err) {
    console.error('[Panel] Server start failed:', err.message);
  }

  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit on Windows when all windows closed (tray keeps it alive)
});

app.on('before-quit', () => {
  app.isQuitting = true;
  saveWindowState();
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});

// Prevent navigation away from the app
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const url = new URL(navigationUrl);
    if (url.origin !== new URL(SERVER_URL).origin) {
      event.preventDefault();
    }
  });
});
