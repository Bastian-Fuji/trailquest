#!/usr/bin/env node
/**
 * PWA用アイコンをPNGで生成する。npm依存なし（Node標準のzlibだけを使う）。
 * デザインは「クリーム色の枠 + ゴールドのダイヤ」。世界地図のスタート地点マーカーと
 * 同じモチーフを、ホーム画面アイコンとしても認識できるようにしている。
 *
 *   node tools/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG    = hex('#171226');
const CREAM = hex('#f0e6d2');
const GOLD  = hex('#e8c25f');

function hex(s){
  const n = parseInt(s.slice(1), 16);
  return [(n>>16)&255, (n>>8)&255, n&255, 255];
}

function pixelAt(x, y, W, H){
  const borderT = Math.round(W * 0.055);
  if (x < borderT || x >= W - borderT || y < borderT || y >= H - borderT) return CREAM;
  const cx = W / 2, cy = H / 2, r = W * 0.30;
  const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
  if (dx + dy <= r) return GOLD;
  return BG;
}

// ------------------------------------------------------------- PNG encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function makePng(W, H, pixelFn) {
  const raw = Buffer.alloc(H * (1 + W * 4));
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // フィルタ種別なし
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = pixelFn(x, y, W, H);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const buf = makePng(size, size, pixelAt);
  const dest = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(dest, buf);
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), dest)}  (${buf.length} bytes)`);
}
