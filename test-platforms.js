#!/usr/bin/env node
// test-platforms.js — Comprehensive test for Windows app + Android PWA adaptation

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:19800';
let passed = 0, failed = 0, skipped = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result === 'skip') {
      console.log(`  ⏭  ${name} (skipped)`);
      skipped++;
    } else {
      console.log(`  ✅ ${name}`);
      passed++;
    }
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function httpTest(name, urlPath, checks) {
  return new Promise((resolve) => {
    http.get(`${BASE}${urlPath}`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          checks(res, body);
          console.log(`  ✅ ${name} (HTTP ${res.statusCode})`);
          passed++;
        } catch (err) {
          console.log(`  ❌ ${name}: ${err.message}`);
          failed++;
        }
        resolve();
      });
    }).on('error', err => {
      console.log(`  ❌ ${name}: ${err.message}`);
      failed++;
      resolve();
    });
  });
}

const pubDir = path.join(__dirname, 'public');

// ===== 1. PWA Files =====
console.log('\n=== 1. PWA Manifest & Icons ===');

test('manifest.json exists and valid', () => {
  const m = JSON.parse(fs.readFileSync(path.join(pubDir, 'manifest.json'), 'utf8'));
  if (!m.name) throw new Error('missing name');
  if (!m.start_url) throw new Error('missing start_url');
  if (!m.icons || m.icons.length < 2) throw new Error('need at least 2 icons');
  if (m.display !== 'standalone') throw new Error('display should be standalone');
  if (!m.icons.find(i => i.sizes === '192x192')) throw new Error('missing 192x192 icon');
  if (!m.icons.find(i => i.sizes === '512x512')) throw new Error('missing 512x512 icon');
});

test('icon-192.png exists and valid', () => {
  const stat = fs.statSync(path.join(pubDir, 'icon-192.png'));
  if (stat.size < 1000) throw new Error('icon too small');
});

test('icon-512.png exists and valid', () => {
  const stat = fs.statSync(path.join(pubDir, 'icon-512.png'));
  if (stat.size < 5000) throw new Error('icon too small');
});

test('sw.js (service worker) exists', () => {
  const sw = fs.readFileSync(path.join(pubDir, 'sw.js'), 'utf8');
  if (!sw.includes('CACHE_NAME')) throw new Error('sw.js missing CACHE_NAME');
  if (!sw.includes('install')) throw new Error('sw.js missing install handler');
  if (!sw.includes('fetch')) throw new Error('sw.js missing fetch handler');
});

// ===== 2. HTML Meta Tags =====
console.log('\n=== 2. HTML Meta Tags (PWA) ===');

test('index.html has manifest link', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  if (!html.includes('rel="manifest"')) throw new Error('missing manifest link');
  if (!html.includes('rel="apple-touch-icon"')) throw new Error('missing apple-touch-icon');
});

test('index.html has mobile meta tags', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  if (!html.includes('viewport-fit=cover')) throw new Error('missing viewport-fit=cover');
  if (!html.includes('apple-mobile-web-app-capable')) throw new Error('missing apple-mobile-web-app-capable');
  if (!html.includes('theme-color')) throw new Error('missing theme-color');
});

test('service worker registered in app.js', () => {
  const js = fs.readFileSync(path.join(pubDir, 'app.js'), 'utf8');
  if (!js.includes("serviceWorker.register")) throw new Error('service worker not registered in app.js');
});

// ===== 3. CSS Responsive =====
console.log('\n=== 3. CSS Responsive Design ===');

test('Safe area insets in CSS', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  if (!html.includes('safe-area-inset')) throw new Error('missing safe area insets');
});

test('Touch-friendly scrolling', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  if (!html.includes('-webkit-overflow-scrolling')) throw new Error('missing touch scrolling');
  if (!html.includes('overscroll-behavior')) throw new Error('missing overscroll-behavior');
});

test('Mobile breakpoint at 600px', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  if (!html.includes('@media(max-width:600px)')) throw new Error('missing 600px breakpoint');
});

test('Session panel mobile: fixed + transform', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  if (!html.includes('position:fixed')) throw new Error('missing position:fixed for mobile panel');
  if (!html.includes('translateX(-100%)')) throw new Error('missing translateX for mobile panel');
});

test('Input area safe area bottom padding', () => {
  const html = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  // Check for input-area padding with safe-area-inset-bottom
  if (!html.includes('env(safe-area-inset-bottom)')) throw new Error('missing safe area bottom for input');
});

// ===== 4. JavaScript Features =====
console.log('\n=== 4. JavaScript Features ===');

test('Virtual keyboard handler', () => {
  const js = fs.readFileSync(path.join(pubDir, 'app.js'), 'utf8');
  if (!js.includes('visualViewport')) throw new Error('missing visualViewport handler');
});

test('Double-tap zoom prevention', () => {
  const js = fs.readFileSync(path.join(pubDir, 'app.js'), 'utf8');
  if (!js.includes('_lastTouchEnd')) throw new Error('missing double-tap prevention');
});

test('Service worker registration', () => {
  const js = fs.readFileSync(path.join(pubDir, 'app.js'), 'utf8');
  if (!js.includes("serviceWorker.register")) throw new Error('missing SW registration');
});

// ===== 5. Electron Main =====
console.log('\n=== 5. Electron App (Windows) ===');

test('electron-main.js exists', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes("require('electron')")) throw new Error('not an electron main');
});

test('Single instance lock', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('requestSingleInstanceLock')) throw new Error('missing single instance lock');
});

test('Window state persistence', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('window-state.json')) throw new Error('missing window state persistence');
  if (!main.includes('saveWindowState')) throw new Error('missing saveWindowState');
  if (!main.includes('loadWindowState')) throw new Error('missing loadWindowState');
});

test('Tray support', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('createTray')) throw new Error('missing createTray');
  if (!main.includes('contextMenu')) throw new Error('missing tray context menu');
});

test('Auto-hide menu bar', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('autoHideMenuBar')) throw new Error('missing autoHideMenuBar');
});

test('Second instance handler', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('second-instance')) throw new Error('missing second-instance handler');
});

test('Navigation security (will-navigate)', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('will-navigate')) throw new Error('missing navigation security');
});

test('Server auto-restart on crash', () => {
  const main = fs.readFileSync(path.join(__dirname, 'electron-main.js'), 'utf8');
  if (!main.includes('startServer().catch')) throw new Error('missing server auto-restart');
});

// ===== 6. HTTP Routes =====
console.log('\n=== 6. HTTP Route Tests ===');

(async () => {
  await httpTest('GET / (index.html)', '/', (res, body) => {
    if (!body.includes('OpenClaw Panel')) throw new Error('missing title');
    if (!body.includes('manifest')) throw new Error('missing manifest link');
  });

  await httpTest('GET /manifest.json', '/manifest.json', (res, body) => {
    const m = JSON.parse(body);
    if (!m.name) throw new Error('manifest missing name');
  });

  await httpTest('GET /sw.js', '/sw.js', (res, body) => {
    if (!body.includes('CACHE_NAME')) throw new Error('sw missing CACHE_NAME');
  });

  await httpTest('GET /app.js', '/app.js', (res, body) => {
    if (!body.includes('sendMessage')) throw new Error('app.js missing sendMessage');
  });

  await httpTest('GET /icon-192.png', '/icon-192.png', (res, body) => {
    if (res.headers['content-type'] !== 'image/png') throw new Error('wrong content-type');
  });

  await httpTest('GET /icon-512.png', '/icon-512.png', (res, body) => {
    if (res.headers['content-type'] !== 'image/png') throw new Error('wrong content-type');
  });

  await httpTest('GET /panel-ws (WebSocket endpoint exists)', '/panel-ws', (res) => {
    // WebSocket endpoint: HTTP GET may return 404 (needs upgrade) or handled differently
    // As long as the server doesn't crash, the endpoint exists
    if (res.statusCode >= 500) throw new Error('server error on panel-ws');
  });

  // ===== 7. build.js (no longer overwrites) =====
  console.log('\n=== 7. Build Script Safety ===');

  test('build.js does not overwrite index.html', () => {
    const buildJs = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
    if (buildJs.includes('fs.writeFileSync') && buildJs.includes('index.html')) {
      // Check if it writes to public/index.html
      if (buildJs.includes("path.join(__dirname, 'public', 'index.html')")) {
        throw new Error('build.js still writes to index.html!');
      }
    }
  });

  test('build.js reports file info only', () => {
    const buildJs = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
    if (!buildJs.includes('Build Info')) throw new Error('build.js should be info-only');
  });

  // ===== Summary =====
  console.log('\n=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:  ${passed + failed + skipped}`);
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
})();
