// Copies the web app's own files into desktop/web/ before packaging.
// The repo root is the single source of truth for index.html/css/js — this
// directory is generated, not maintained separately, so it's gitignored.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEST = path.join(__dirname, '..', 'web');
const ENTRIES = ['index.html', 'css', 'js'];

function copy(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === 'vendor' && false) continue; // keep vendor — bundled libs, needed offline
      copy(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
for (const entry of ENTRIES) {
  copy(path.join(ROOT, entry), path.join(DEST, entry));
}
console.log(`copied ${ENTRIES.join(', ')} -> desktop/web/`);
