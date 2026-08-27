/* 共有機能（Googleマップ / QR）の検証。
 * 画面に出たQRを実際にスクリーンショットして OpenCV で読み取り、
 * 表示しているURLと一致するかまで確かめる。
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const N = 46, SP = 90, LAT0 = 35.7100, LON0 = 139.7900;
const dLat = SP / 111320, dLon = SP / (111320 * Math.cos(LAT0 * Math.PI / 180));

function fakeOverpass() {
  const els = [];
  const nid = (r, c) => 1000000 + r * 1000 + c;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
    els.push({ type: 'node', id: nid(r, c), lat: LAT0 + r * dLat, lon: LON0 + c * dLon });
  let wid = 5000000;
  for (let r = 0; r < N; r++) els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: N }, (_, c) => nid(r, c)) });
  for (let c = 0; c < N; c++) els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: N }, (_, r) => nid(r, c)) });
  let pid = 9000000;
  const poi = (r, c, tags) => els.push({ type: 'node', id: pid++, lat: LAT0 + r * dLat, lon: LON0 + c * dLon, tags });
  for (let r = 2; r < N; r += 3) poi(r, 12, { natural: 'water', name: `川辺${r}` });
  for (let r = 30; r < 40; r += 2) poi(r, 30, { leisure: 'park', name: `公園${r}` });
  poi(12, 8, { amenity: 'public_bath', name: '日の出湯' });
  poi(9, 14, { amenity: 'public_bath', name: '大黒湯' });
  return { elements: els };
}

const STUB = `const chain=()=>{const o={addTo:()=>o,on:()=>o,bindTooltip:()=>o,setView:()=>o,clearLayers:()=>o,removeLayer:()=>o,fitBounds:()=>o,getZoom:()=>14};return o};
window.L={map:()=>{const m=chain();m.on=(e,f)=>{if(e==='click')window.__mapClick=f;return m};return m},tileLayer:()=>chain(),layerGroup:()=>chain(),polyline:()=>chain(),circleMarker:()=>chain(),latLngBounds:()=>({})};`;

function decodePng(file) {
  const py = `
import cv2, sys
img = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
d = cv2.QRCodeDetector()
txt, _, _ = d.detectAndDecode(img)
sys.stdout.write(txt if txt else '')
`;
  return execFileSync('python3', ['-c', py, file], { encoding: 'utf8', maxBuffer: 1 << 24 });
}

function checkUrl(url, expectWaypoints, label, ck) {
  const u = new URL(url);
  const p = u.searchParams;
  ck(u.origin + u.pathname === 'https://www.google.com/maps/dir/', `${label}: GoogleマップのルートURL`);
  ck(p.get('travelmode') === 'walking', `${label}: 徒歩モード`);
  ck(p.get('origin') === p.get('destination'), `${label}: 出発地とゴールが同じ（周回）`);
  const wps = (p.get('waypoints') || '').split('|').filter(Boolean);
  ck(wps.length === expectWaypoints, `${label}: 経由地${wps.length}か所（期待${expectWaypoints}）`);
  const inArea = [p.get('origin'), ...wps].every((s) => {
    const [la, lo] = s.split(',').map(Number);
    return la > LAT0 - 0.01 && la < LAT0 + 0.06 && lo > LON0 - 0.01 && lo < LON0 + 0.06;
  });
  ck(inArea, `${label}: 座標がすべて対象エリア内`);
  return wps;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await p.route('**/leaflet.js', (r) => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await p.route('**/leaflet.css', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await p.route('**/api/interpreter*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fakeOverpass()) }));
  await p.route('**/cyberjapandata.gsi.go.jp/**', (r) => r.abort());

  await p.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await p.waitForTimeout(300);
  await p.evaluate(([la, lo]) => window.__mapClick({ latlng: { lat: la, lng: lo } }),
    [LAT0 + 10 * dLat, LON0 + 10 * dLon]);
  await p.evaluate(() => { document.getElementById('dist').value = 5; });
  await p.click('#go');
  await p.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 60000 });

  let fail = 0;
  const ck = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };

  console.log('=== コース生成 ===');
  const cards = await p.$$('#cards .card');
  ck(cards.length >= 1, `コースが${cards.length}本生成された`);

  console.log('\n=== Googleマップのリンク（PC・経由地9） ===');
  const href = await p.getAttribute('#cards .card .act[href^="https"]', 'href');
  console.log('  ' + href);
  checkUrl(href, 9, 'PC用', ck);

  console.log('\n=== QRコード（スマホ・経由地3） ===');
  await p.click('[data-qr="0"]');
  await p.waitForTimeout(400);
  const visible = await p.isVisible('#qr0 svg');
  ck(visible, 'QRが表示される');

  const shownUrl = (await p.textContent('#qr0 .qrurl')).trim();
  console.log('  ' + shownUrl);
  checkUrl(shownUrl, 3, 'スマホ用', ck);

  // 画面のQRを撮って読み取る
  const png = path.join(tmp, 'qr.png');
  await p.locator('#qr0 svg').screenshot({ path: png });
  const decoded = decodePng(png);
  ck(decoded === shownUrl, `画面のQRを読み取ると同じURLになる${decoded === shownUrl ? '' : ` → "${decoded.slice(0, 70)}"`}`);

  // もう一度押すと閉じる
  await p.click('[data-qr="0"]');
  await p.waitForTimeout(200);
  ck(!(await p.isVisible('#qr0 svg')), 'もう一度押すと閉じる');

  // GPXも従来どおり動く
  const gpx = await p.evaluate(() => {
    let captured = null;
    const oc = URL.createObjectURL; URL.createObjectURL = (b) => { captured = b; return 'blob:stub'; };
    const ac = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    document.querySelector('[data-gpx]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ac;
    return captured ? captured.text() : null;
  });
  ck(!!gpx && gpx.includes('<trkpt'), `GPXも引き続き出力できる (${gpx ? gpx.length : 0}バイト)`);

  ck(errs.length === 0, 'JSエラーなし' + (errs.length ? ' → ' + errs.slice(0, 2).join(' | ') : ''));

  await p.screenshot({ path: '/tmp/share_ui.png' });
  await b.close();
  console.log(fail === 0 ? '\n*** 共有機能テスト 全通過 ***' : `\n*** ${fail}件 NG ***`);
  process.exit(fail === 0 ? 0 : 1);
})();
