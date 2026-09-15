// Generates jio's Windows app icon and the NSIS installer's branded
// sidebar/header art — no image tooling required, just raw pixel buffers.
// Run via `npm run brand-assets` (also runs automatically before dist/release).
//
// The mark is jio's own face: a dark rounded panel with two pale pill "eyes",
// the same shapes js/eyes.js draws on the canvas — so the installer and the
// taskbar icon actually look like the app rather than Electron's default.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

const BG = [0x1f, 0x1e, 0x1d];   // --bg
const FG = [0xc2, 0xc0, 0xb6];   // --fg-2, the eye color
const ACCENT = [0x6c, 0x8c, 0xff]; // --accent, a small warm touch

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function roundedRectAlpha(px, py, x, y, w, h, r) {
  // Signed-distance-ish rounded-rect test with 1px antialiasing, so the
  // shapes have soft edges instead of a jagged pixel outline.
  const dx = Math.max(x - px, px - (x + w), 0);
  const dy = Math.max(y - py, py - (y + h), 0);
  if (dx === 0 && dy === 0) {
    // inside the core rect — check corner rounding only near corners
    const cx = clamp(px, x + r, x + w - r);
    const cy = clamp(py, y + r, y + h - r);
    const d = Math.hypot(px - cx, py - cy);
    return d <= r ? 1 : clamp(r + 1 - d, 0, 1);
  }
  const cx = clamp(px, x + r, x + w - r);
  const cy = clamp(py, y + r, y + h - r);
  const d = Math.hypot(px - cx, py - cy);
  return clamp(r + 1 - d, 0, 1);
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/* Renders the jio face into an RGBA buffer. `bgAlpha` < 1 lets the app icon's
   background be a rounded square (so it reads as an icon, not a sticker)
   while installer art fills the whole banner edge-to-edge. */
function drawFace(w, h, { panel = true } = {}) {
  const buf = Buffer.alloc(w * h * 4);
  const panelR = Math.round(Math.min(w, h) * 0.22);
  const eyeH = h * 0.30, eyeW = w * 0.20, gap = w * 0.12;
  const eyeY = h * 0.5 - eyeH / 2 - h * 0.02;
  const totalW = eyeW * 2 + gap;
  const leftX = w / 2 - totalW / 2;
  const rightX = leftX + eyeW + gap;
  // a proper rounded rect needs r <= half its shorter side, or the corner
  // math folds the shape into a wider blob than the rect itself
  const eyeR = Math.min(eyeH * 0.32, eyeW / 2, eyeH / 2);
  // a small accent dot, low-right, echoing the composer's send-button hue
  const dotR = Math.min(w, h) * 0.035;
  const dotX = w * 0.78, dotY = h * 0.82;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let panelA = panel ? roundedRectAlpha(px + 0.5, py + 0.5, 0, 0, w, h, panelR) : 1;
      const eL = roundedRectAlpha(px + 0.5, py + 0.5, leftX, eyeY, eyeW, eyeH, eyeR);
      const eR = roundedRectAlpha(px + 0.5, py + 0.5, rightX, eyeY, eyeW, eyeH, eyeR);
      const eye = Math.max(eL, eR);
      const dot = clamp(dotR + 1 - Math.hypot(px + 0.5 - dotX, py + 0.5 - dotY), 0, 1);

      let color = BG, alpha = panelA;
      if (panelA > 0.02) {
        color = mix(BG, FG, eye);
        color = mix(color, ACCENT, dot * (1 - eye));
      }
      const i = (py * w + px) * 4;
      buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2];
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

/* ---- 24-bit BMP writer (bottom-up, BGR, row-padded to 4 bytes) ---- */
function writeBMP(w, h, rgba, bg = BG) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelBytes = rowSize * h;
  const fileSize = 14 + 40 + pixelBytes;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  let off = 54;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      // flatten onto bg — BMP here has no alpha channel
      const r = Math.round(rgba[i] * a + bg[0] * (1 - a));
      const g = Math.round(rgba[i + 1] * a + bg[1] * (1 - a));
      const b = Math.round(rgba[i + 2] * a + bg[2] * (1 - a));
      buf[off++] = b; buf[off++] = g; buf[off++] = r;
    }
    off += rowSize - w * 3;
  }
  return buf;
}

/* ---- ICO writer: wraps one or more 32-bit BITMAPINFOHEADER images ---- */
function writeICO(sizes) {
  const n = sizes.length;
  const dir = Buffer.alloc(6 + 16 * n);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(n, 4);

  const images = sizes.map(({ size, rgba }) => {
    const rowSize = size * 4; // 32bpp, always a multiple of 4
    const andRowSize = Math.ceil(size / 8 / 4) * 4;
    const xorBytes = rowSize * size;
    const andBytes = andRowSize * size;
    const img = Buffer.alloc(40 + xorBytes + andBytes);
    img.writeUInt32LE(40, 0);
    img.writeInt32LE(size, 4);
    img.writeInt32LE(size * 2, 8); // height counts XOR+AND masks together
    img.writeUInt16LE(1, 12);
    img.writeUInt16LE(32, 14);
    img.writeUInt32LE(0, 16);
    img.writeUInt32LE(xorBytes + andBytes, 20);

    let off = 40;
    for (let y = size - 1; y >= 0; y--) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        img[off++] = rgba[i + 2]; img[off++] = rgba[i + 1]; img[off++] = rgba[i]; img[off++] = rgba[i + 3];
      }
    }
    // AND mask: all zero (fully opaque everywhere) — the alpha channel above
    // is what modern Windows actually uses for transparency.
    return img;
  });

  let offset = dir.length;
  const entries = [];
  images.forEach((img, idx) => {
    const size = sizes[idx].size;
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    e.copy(dir, 6 + 16 * idx);
  });
  return Buffer.concat([dir, ...images]);
}

// App icon: the panel + eyes, at every size Windows actually asks for.
const iconSizes = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, rgba: drawFace(size, size) }));
fs.writeFileSync(path.join(OUT, 'icon.ico'), writeICO(iconSizes));

// Installer banners: edge-to-edge (no rounded panel), NSIS's required sizes.
fs.writeFileSync(path.join(OUT, 'installerSidebar.bmp'), writeBMP(164, 314, drawFace(164, 314, { panel: false })));
fs.writeFileSync(path.join(OUT, 'uninstallerSidebar.bmp'), writeBMP(164, 314, drawFace(164, 314, { panel: false })));
fs.writeFileSync(path.join(OUT, 'installerHeader.bmp'), writeBMP(150, 57, drawFace(150, 57, { panel: false })));

console.log('brand assets written to desktop/build/');
