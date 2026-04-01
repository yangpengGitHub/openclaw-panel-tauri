#!/usr/bin/env node
// Android APK support tests
// Tests: server URL config, WebSocket connection, URL resolution, mobile UI

const PASS = '\x1b[32m✅ PASS\x1b[0m';
const FAIL = '\x1b[31m❌ FAIL\x1b[0m';
const WARN = '\x1b[33m⚠️  WARN\x1b[0m';

const results = [];
function test(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? PASS : FAIL} ${name}${detail ? ' — ' + detail : ''}`);
}

// ===== Test 1: File structure checks =====
console.log('\n=== 📁 File Structure ===');

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname);

// Check Tauri Android config exists
test('tauri.conf.json 存在',
  fs.existsSync(path.join(root, 'src-tauri/tauri.conf.json')));

const tauriConf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
test('tauri.conf.json 有 identifier',
  !!tauriConf.identifier, tauriConf.identifier);
test('tauri.conf.json identifier 是 com.openclaw.panel',
  tauriConf.identifier === 'com.openclaw.panel');
test('tauri.conf.json frontendDist 指向 ../public',
  tauriConf.build?.frontendDist === '../public');
test('tauri.conf.json bundle targets 包含 apk',
  (tauriConf.bundle?.targets || []).includes('apk'));
test('tauri.conf.json android 配置存在',
  !!tauriConf.bundle?.android);
test('tauri.conf.json android minSdkVersion >= 24',
  (tauriConf.bundle?.android?.minSdkVersion || 0) >= 24);
test('tauri.conf.json CSP 允许 http: 和 ws:',
  (tauriConf.app?.security?.csp || '').includes('http:') &&
  (tauriConf.app?.security?.csp || '').includes('ws:'));

// Check lib.rs has Android setup
const libRs = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
test('lib.rs 包含 REMOTE_SERVER',
  libRs.includes('REMOTE_SERVER'), 'http://192.168.1.48:19800');
test('lib.rs 有 android cfg guard',
  libRs.includes('target_os = "android"'));
test('lib.rs 有 mobile_entry_point',
  libRs.includes('mobile_entry_point'));
test('lib.rs 桌面 tray 有 android guard',
  libRs.includes('#[cfg(not(target_os = "android"))]'));

// Check capabilities
const capsFile = path.join(root, 'src-tauri/capabilities/default.json');
if (fs.existsSync(capsFile)) {
  const caps = JSON.parse(fs.readFileSync(capsFile, 'utf8'));
  test('capabilities 支持所有窗口',
    (caps.windows || []).includes('*') || (caps.windows || []).length > 1);
}

// ===== Test 2: Frontend Android support =====
console.log('\n=== 📱 Frontend Android Support ===');

const appJs = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

test('app.js 包含 getServerUrl 函数',
  appJs.includes('function getServerUrl'));
test('app.js 包含 getWsUrl 函数',
  appJs.includes('function getWsUrl'));
test('app.js 包含 resolveUrl 函数',
  appJs.includes('function resolveUrl'));
test('app.js 包含 showServerSetup 函数',
  appJs.includes('function showServerSetup'));
test('app.js 包含 saveServerSetup 函数',
  appJs.includes('function saveServerSetup'));
test('app.js 包含 Tauri 检测',
  appJs.includes('_isTauri'));
test('app.js 包含 Android 检测',
  appJs.includes('_isTauriAndroid'));
test('app.js 使用 oc-server-url localStorage key',
  appJs.includes('oc-server-url'));
test('downloadFile 使用 resolveUrl',
  appJs.includes('url = resolveUrl(url)'));

// Check index.html has server setup modal
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
test('index.html 包含 server-setup-modal',
  indexHtml.includes('server-setup-modal'));
test('index.html 包含 setup-server-url input',
  indexHtml.includes('setup-server-url'));
test('index.html 有默认服务器地址',
  indexHtml.includes('192.168.1.48:19800'));

// Check mobile CSS
test('index.html 包含移动端 media queries',
  indexHtml.includes('@media(max-width:600px)') || indexHtml.includes('@media (max-width:600px)'));
test('index.html 包含 safe-area-inset 支持',
  indexHtml.includes('safe-area-inset'));
test('index.html 有 viewport-fit=cover',
  indexHtml.includes('viewport-fit=cover'));

// ===== Test 3: GitHub Actions =====
console.log('\n=== 🔄 GitHub Actions ===');

const buildYml = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
test('build.yml 包含 Android job',
  buildYml.includes('build-android'));
test('build.yml Android 使用 Java 17',
  buildYml.includes("java-version: '17'"));
test('build.yml Android 设置 ANDROID_NDK_HOME',
  buildYml.includes('ANDROID_NDK_HOME'));
test('build.yml Android 安装 cargo-ndk',
  buildYml.includes('cargo install cargo-ndk'));
test('build.yml Android 运行 tauri android init',
  buildYml.includes('tauri android init'));
test('build.yml Android 运行 tauri android build',
  buildYml.includes('tauri android build'));
test('build.yml Release 包含 APK',
  buildYml.includes('*.apk'));

const androidYml = fs.existsSync(path.join(root, '.github/workflows/android.yml'))
  ? fs.readFileSync(path.join(root, '.github/workflows/android.yml'), 'utf8') : '';
test('android.yml 存在 (push to main workflow)',
  androidYml.length > 0);
if (androidYml) {
  test('android.yml 触发 push to main',
    androidYml.includes('branches: [main]') || androidYml.includes("branches: ['main']"));
  test('android.yml 创建 Release',
    androidYml.includes('softprops/action-gh-release'));
}

// ===== Test 4: WebSocket Connection (live) =====
console.log('\n=== 🌐 WebSocket Connection (live) ===');

const WebSocket = require('ws');
let wsConnected = false;
let wsState = null;
let wsError = null;

try {
  const ws = new WebSocket('ws://localhost:19800/panel-ws');
  ws.on('open', () => {
    wsConnected = true;
    test('WebSocket 连接成功', true, 'ws://localhost:19800/panel-ws');
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'full-state' && !wsState) {
        wsState = msg;
        test('收到 full-state 消息', true, `instances: ${msg.instances?.length || 0}`);
        test('full-state 包含 instances 数组',
          Array.isArray(msg.instances));
        test('full-state 包含时间戳',
          typeof msg.ts === 'number', new Date(msg.ts).toISOString());
        
        // Check each instance
        (msg.instances || []).forEach(inst => {
          test(`实例 ${inst.id} 有 name`, !!inst.name, inst.name);
          test(`实例 ${inst.id} 有 status`, !!inst.status, inst.status);
        });

        // Clean up
        ws.close();
        
        // Print summary
        printSummary();
      }
    } catch (e) {
      wsError = e.message;
    }
  });
  ws.on('error', (err) => {
    wsError = err.message;
    test('WebSocket 连接', false, err.message);
  });

  // Timeout
  setTimeout(() => {
    if (!wsConnected) {
      test('WebSocket 连接', false, 'timeout (is server running?)');
    }
    if (!wsState && wsConnected) {
      test('收到 full-state 消息', false, 'timeout');
    }
    try { ws.close(); } catch(e) {}
    printSummary();
  }, 10000);
} catch (e) {
  test('WebSocket 连接', false, e.message);
  printSummary();
}

function printSummary() {
  // Prevent double summary
  if (printSummary.called) return;
  printSummary.called = true;

  console.log('\n=== 📊 Summary ===');
  const passed = results.filter(r => r.ok === true).length;
  const failed = results.filter(r => r.ok === false).length;
  const total = results.length;
  console.log(`Total: ${total} | ✅ Passed: ${passed} | ❌ Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n❌ Failed tests:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}${r.detail ? ': ' + r.detail : ''}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}
