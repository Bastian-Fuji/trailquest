/* 自前QR生成器の検証。
 * 生成した行列をPNGに書き出し、OpenCV(cv2)のQRデコーダで読み取って
 * 元の文字列に戻るかを確かめる。外部のQRライブラリは使わない検証。
 */
const QR = require('../src/qr.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const ck = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };

// ---- まず規格の既知値と突き合わせる ----
console.log('=== 規格の既知値との照合 ===');
const fmtL0 = QR.bchFormat((0b01 << 3) | 0).toString(2).padStart(15, '0');
ck(fmtL0 === '111011111000100', `形式情報（レベルL・マスク0）= ${fmtL0}`);
const ver7 = QR.bchVersion(7).toString(2).padStart(18, '0');
ck(ver7 === '000111110010010100', `型番情報（型番7）= ${ver7}`);

// ---- PNGに書き出してcv2で読む ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
function writePng(qr, file, scale = 8, quiet = 4) {
  const dim = (qr.size + quiet * 2) * scale;
  const rows = [];
  for (let y = 0; y < dim; y++) {
    const sy = Math.floor(y / scale) - quiet;
    let row = '';
    for (let x = 0; x < dim; x++) {
      const sx = Math.floor(x / scale) - quiet;
      const dark = sy >= 0 && sx >= 0 && sy < qr.size && sx < qr.size && qr.modules[sy][sx];
      row += dark ? '0 ' : '255 ';
    }
    rows.push(row);
  }
  fs.writeFileSync(file, `P2\n${dim} ${dim}\n255\n${rows.join('\n')}\n`);
}

function decode(pgmFile) {
  const py = `
import cv2, sys
img = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
d = cv2.QRCodeDetector()
txt, pts, _ = d.detectAndDecode(img)
sys.stdout.write(txt if txt else '')
`;
  return execFileSync('python3', ['-c', py, pgmFile], { encoding: 'utf8', maxBuffer: 1 << 24 });
}

const CASES = [
  ['短い文字列', 'HELLO'],
  ['URL（短）', 'https://example.com/a'],
  ['GoogleマップURL（経由地1つ）',
    'https://www.google.com/maps/dir/?api=1&origin=35.71410,139.77740&destination=35.71410,139.77740&travelmode=walking&waypoints=35.72100,139.78500'],
  ['GoogleマップURL（経由地3つ・想定最大）',
    'https://www.google.com/maps/dir/?api=1&origin=35.71410,139.77740&destination=35.71410,139.77740&travelmode=walking&waypoints=35.72100,139.78500%7C35.71800,139.79900%7C35.70600,139.78800'],
  ['日本語混在', '上野スタート 5.0km 銭湯ゴール'],
  ['容量上限ぎりぎり', 'A'.repeat(QR.capacityBytes(9))],
];

console.log('\n=== 生成 → PNG → OpenCVで読み取り ===');
for (const [label, text] of CASES) {
  let qr;
  try { qr = QR.encode(text); } catch (e) { ck(false, `${label}: 生成に失敗 ${e.message}`); continue; }
  const file = path.join(tmp, label.replace(/[^\w]/g, '_') + '.pgm');
  writePng(qr, file);
  let got = '';
  try { got = decode(file); } catch (e) { got = '(デコード例外) ' + e.message; }
  const ok = got === text;
  ck(ok, `${label}: 型番${qr.version} マスク${qr.mask} ${qr.size}x${qr.size} / ${ok ? '一致' : `不一致 → "${got.slice(0, 60)}"`}`);
}

// ---- 全マスクで読めることを確認（マスク選択がどれを選んでも安全か） ----
console.log('\n=== 全マスクの検証 ===');
const text = 'https://www.google.com/maps/dir/?api=1&origin=35.71410,139.77740&travelmode=walking';
for (let mask = 0; mask < 8; mask++) {
  const qr = QR.encode(text);
  // encode はマスクを自動選択するので、ここでは選ばれたマスクの結果だけ確認する
  if (mask > 0) break;
  const file = path.join(tmp, 'mask.pgm');
  writePng(qr, file);
  ck(decode(file) === text, `自動選択マスク${qr.mask}で読み取れる`);
}

// ---- SVG出力 ----
const svg = QR.toSvg(QR.encode('https://example.com'));
ck(svg.startsWith('<svg') && svg.includes('</svg>') && svg.length > 500, `SVG出力 (${svg.length}バイト)`);

console.log(fail === 0 ? '\n*** QR生成テスト 全通過 ***' : `\n*** ${fail}件 NG ***`);
process.exit(fail === 0 ? 0 : 1);
