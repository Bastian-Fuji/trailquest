#!/usr/bin/env node
/**
 * ビルド：src/algo.js を src/app.template.html に埋め込んで、
 * 単体で動く index.html を作る。
 *
 *   node build.js
 *
 * 依存パッケージなし。生成物はブラウザで開くだけで動く1ファイル。
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const algo = fs.readFileSync(path.join(root, 'src', 'algo.js'), 'utf8');
const qr = fs.readFileSync(path.join(root, 'src', 'qr.js'), 'utf8');
const tpl = fs.readFileSync(path.join(root, 'src', 'app.template.html'), 'utf8');

for (const mark of ['/*__ALGO__*/', '/*__QR__*/']) {
  if (!tpl.includes(mark)) {
    console.error(`テンプレートに ${mark} が見つかりません`);
    process.exit(1);
  }
}

const out = tpl.replace('/*__ALGO__*/', algo).replace('/*__QR__*/', qr);
const dest = path.join(root, 'index.html');
fs.writeFileSync(dest, out);
console.log(`built ${path.relative(root, dest)}  (${(out.length / 1024).toFixed(1)} KB)`);
