/* スマホ画面での検証。
 * 390x844（iPhone相当）で、横スクロールが出ないこと、
 * コース生成から「Googleマップで開く」までが指で完結することを確かめる。
 */
const { chromium, devices } = require('playwright');
const path = require('path');
const N = 60, SP = 100, LAT0 = 35.6800, LON0 = 139.7600;
const dLat = SP / 111320, dLon = SP / (111320 * Math.cos(LAT0 * Math.PI / 180));

function city() {
  const els = [];
  const nid = (r, c) => 1000000 + r * 1000 + c;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
    els.push({ type: 'node', id: nid(r, c), lat: LAT0 + r * dLat, lon: LON0 + c * dLon });
  let wid = 5000000;
  for (let r = 0; r < N; r++) els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: N }, (_, c) => nid(r, c)) });
  for (let c = 0; c < N; c++) els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: N }, (_, r) => nid(r, c)) });
  let pid = 9000000;
  const poi = (r, c, t) => els.push({ type: 'node', id: pid++, lat: LAT0 + r * dLat, lon: LON0 + c * dLon, tags: t });
  for (let r = 3; r < N; r += 5) for (let c = 3; c < N; c += 5) poi(r, c, { leisure: 'park', name: `公園${r}_${c}` });
  poi(33, 32, { amenity: 'public_bath', name: 'みどり湯' });
  poi(27, 28, { amenity: 'public_bath', name: '朝日湯' });
  return { elements: els };
}
const STUB = `const chain=()=>{const o={addTo:()=>o,on:()=>o,bindTooltip:()=>o,setView:()=>o,clearLayers:()=>o,removeLayer:()=>o,fitBounds:()=>o,getZoom:()=>14};return o};
window.L={map:()=>{const m=chain();m.on=(e,f)=>{if(e==='click')window.__mapClick=f;return m};return m},tileLayer:()=>chain(),layerGroup:()=>chain(),polyline:()=>chain(),circleMarker:()=>chain(),latLngBounds:()=>({})};`;

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage({ ...devices['iPhone 13'], isMobile: true, hasTouch: true });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route('**/leaflet.js', (r) => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await p.route('**/leaflet.css', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await p.route('**/api/interpreter*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(city()) }));
  await p.route('**/cyberjapandata.gsi.go.jp/**', (r) => r.abort());
  await p.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await p.waitForTimeout(300);

  let fail = 0;
  const ck = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
  const overflow = () => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

  console.log('=== iPhone 13 (390x844) ===');
  ck(!(await overflow()), '初期表示で横スクロールが出ない');
  ck(!(await p.isVisible('#jswarn')), '正常に起動していれば警告は出ない');
  ck(await p.isVisible('#tiles'), '地図の種類切り替えが見える');
  ck(await p.isVisible('#here'), '現在地ボタンが見える');
  ck(await p.isVisible('#go'), '生成ボタンが見える');

  await p.evaluate(([la, lo]) => window.__mapClick({ latlng: { lat: la, lng: lo } }),
    [LAT0 + 30 * dLat, LON0 + 30 * dLon]);
  await p.evaluate(() => { document.getElementById('dist').value = 5; });
  await p.tap('#rewards button[data-r="onsen"]');
  await p.tap('#go');
  await p.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 90000 });

  const cards = await p.$$('#cards .card');
  ck(cards.length >= 1, `コースが${cards.length}本生成される`);
  ck(!(await overflow()), 'コース表示後も横スクロールが出ない');

  const mainBtn = await p.textContent('#cards .card .act.main');
  ck(/Googleマップで開く/.test(mainBtn), `スマホでは主ボタンがGoogleマップ（"${mainBtn.trim()}"）`);
  const href = await p.getAttribute('#cards .card .act.main', 'href');
  const wps = new URL(href).searchParams.get('waypoints').split('|');
  ck(wps.length === 3, `スマホ向けに経由地3か所（${wps.length}か所）`);

  ck(await p.isVisible('#cards .card .act[data-qr]'), 'QRも残っている');
  await p.tap('#cards .card .act[data-qr]');
  await p.waitForTimeout(300);
  ck(await p.isVisible('#qr0 svg'), 'QRが開く');
  ck(!(await overflow()), 'QRを開いても横スクロールが出ない');

  const box = await p.evaluate(() => {
    const b = document.querySelector('#qr0 svg').getBoundingClientRect();
    return { w: Math.round(b.width), fits: b.width <= window.innerWidth };
  });
  ck(box.fits, `QRが画面幅に収まる（${box.w}px / 画面390px）`);

  // 現在地ボタン：file:// では使えない旨を案内する
  await p.tap('#here');
  await p.waitForFunction(() => /現在地|https/.test(document.getElementById('log').innerText.slice(-400)), null, { timeout: 20000 }).catch(()=>{});
  const log = await p.textContent('#log');
  ck(/現在地/.test(log) && /(https|地図をタップ)/.test(log), '現在地が使えないときに代わりの手段を案内する');

  ck(errs.length === 0, 'JSエラーなし' + (errs.length ? ' → ' + errs[0] : ''));
  await p.screenshot({ path: '/tmp/mobile.png', fullPage: false });

  // JavaScriptが無効な環境（メールやファイルアプリのプレビュー）を再現する
  console.log('\n=== JavaScriptが動かない環境 ===');
  const p2 = await b.newPage({ ...devices['iPhone 13'], javaScriptEnabled: false });
  await p2.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await p2.waitForTimeout(200);
  const warn = await p2.isVisible('#jswarn');
  const text = warn ? (await p2.textContent('#jswarn')).replace(/\s+/g, ' ').trim() : '';
  ck(warn, 'JSが動かないとき、起動していないことが画面に出る');
  ck(/ブラウザで開き直して/.test(text), '対処法（ブラウザで開き直す）が書かれている');
  await p2.screenshot({ path: '/tmp/mobile_nojs.png' });
  await p2.close();
  await b.close();
  console.log(fail === 0 ? '\n*** スマホ表示テスト 全通過 ***' : `\n*** ${fail}件 NG ***`);
  process.exit(fail === 0 ? 0 : 1);
})();
