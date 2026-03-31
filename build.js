// build.js — Simple build info (does NOT regenerate index.html)
// The live public/index.html is the source of truth.

const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = ['index.html', 'app.js', 'icon.png', 'icon.ico'];

console.log('=== OpenClaw Panel Build Info ===');
for (const f of files) {
  const p = path.join(publicDir, f);
  try {
    const stat = fs.statSync(p);
    console.log(`${f}: ${(stat.size / 1024).toFixed(1)} KB`);
  } catch {
    console.log(`${f}: MISSING`);
  }
}

// Check if dist exists
const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  console.log('\n=== Dist ===');
  try {
    const entries = fs.readdirSync(distDir);
    entries.forEach(e => {
      const p = path.join(distDir, e);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        console.log(`  ${e}/ (${fs.readdirSync(p).length} files)`);
      } else {
        console.log(`  ${e}: ${(stat.size / 1024).toFixed(1)} KB`);
      }
    });
  } catch {}
}

console.log('\nBuild: use electron-builder directly (npm run build:win)');
