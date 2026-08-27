/* ブラウザ版の結線テスト。
 * Leaflet と Overpass をスタブに差し替えて、file:// で開いたページが
 * 「生成ボタン → データ取得 → グラフ構築 → コース3本のカード描画 → GPX生成」
 * まで通ることを確認する。（この環境は外部ネット不可のため全てモック）
 */
const { chromium } = require('playwright');
const path = require('path');

// --- 合成 Overpass レスポンス（test_algo.js と同じ格子の街） ---
function fakeOverpass() {
  const N = 46, SP = 90, LAT0 = 35.7100, LON0 = 139.7900;
  const dLat = SP / 111320, dLon = SP / (111320 * Math.cos(LAT0 * Math.PI / 180));
  const els = [];
  const nid = (r, c) => 1000000 + r * 1000 + c;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
    els.push({ type: 'node', id: nid(r, c), lat: LAT0 + r * dLat, lon: LON0 + c * dLon });
  let wid = 5000000;
  for (let r = 0; r < N; r++) els.push({ type: 'way', id: wid++, tags: { highway: r % 8 === 0 ? 'secondary' : (r === 30 ? 'pedestrian' : 'residential') }, nodes: Array.from({ length: N }, (_, c) => nid(r, c)) });
  for (let c = 0; c < N; c++) els.push({ type: 'way', id: wid++, tags: { highway: c % 8 === 0 ? 'secondary' : (c === 12 ? 'footway' : 'residential') }, nodes: Array.from({ length: N }, (_, r) => nid(r, c)) });
  let pid = 9000000;
  const poi = (r, c, tags) => els.push({ type: 'node', id: pid++, lat: LAT0 + r * dLat, lon: LON0 + c * dLon, tags });
  for (let r = 32; r <= 40; r += 2) for (let c = 30; c <= 38; c += 2) poi(r, c, { leisure: 'park', name: `公園${r}-${c}` });
  for (let r = 2; r < N; r += 3) poi(r, 12, { natural: 'water', name: `川辺${r}` });
  for (let c = 4; c < N; c += 2) poi(30, c, { shop: 'bakery', name: `パン屋${c}` });
  poi(2, 4, { railway: 'station', name: '下町駅' });
  poi(20, 34, { amenity: 'place_of_worship', religion: 'shinto', name: '鷲神社' });
  poi(12, 8, { amenity: 'public_bath', name: '日の出湯' });
  poi(9, 14, { amenity: 'public_bath', name: '大黒湯' });
  for (let i = 0; i < 8; i++) poi(10 + (i % 4), 7 + i, { amenity: 'restaurant', name: `食堂${i}` });
  return { elements: els };
}

// --- Leaflet スタブ ---
const LEAFLET_STUB = `
window.__calls = {polyline:0, circleMarker:0, fitBounds:0, tooltip:[]};
const chain = () => { const o = {
  addTo(){return o}, on(){return o}, bindTooltip(t){window.__calls.tooltip.push(t);return o},
  setView(){return o}, clearLayers(){return o}, removeLayer(){return o},
  fitBounds(){window.__calls.fitBounds++;return o}, getZoom(){return 14}, remove(){return o}
}; return o; };
window.L = {
  map(){ const m = chain(); m.on = (ev, fn) => { if(ev==='click') window.__mapClick = fn; return m; }; return m; },
  tileLayer(){return chain()},
  layerGroup(){return chain()},
  polyline(coords){ window.__calls.polyline++; window.__lastCoords = coords; return chain(); },
  circleMarker(){ window.__calls.circleMarker++; return chain(); },
  latLngBounds(){ return {}; },
};
`;

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.route('**/leaflet.js', (r) => r.fulfill({ contentType: 'application/javascript', body: LEAFLET_STUB }));
  await page.route('**/leaflet.css', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/api/interpreter*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(fakeOverpass()) }));
  await page.route('**/cyberjapandata.gsi.go.jp/**', (r) => r.abort());

  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForTimeout(300);

  // 起点を合成データの中心付近に置く（地図クリック相当）
  await page.evaluate(() => window.__mapClick && window.__mapClick({ latlng: { lat: 35.7100 + 10 * (90 / 111320), lng: 139.7900 + 10 * (90 / (111320 * Math.cos(35.71 * Math.PI / 180))) } }));

  const results = [];
  const scenario = async (name, setup) => {
    await page.evaluate(setup);
    await page.click('#go');
    await page.waitForFunction(() => document.getElementById('go').disabled === false, null, { timeout: 60000 });
    const out = await page.evaluate(() => ({
      cards: document.querySelectorAll('#cards .card').length,
      log: document.getElementById('log').innerText,
      km: [...document.querySelectorAll('#cards .km')].map((e) => e.textContent),
      polylines: window.__calls.polyline,
    }));
    results.push({ name, ...out });
    console.log(`\n--- ${name} ---\n${out.log.trim()}\n  カード数=${out.cards}  距離=${out.km.join(', ')}`);
    return out;
  };

  await scenario('5km / 自然 / 銭湯', () => {
    document.getElementById('dist').value = 5;
    document.getElementById('nat').value = 1;
    document.querySelector('#rewards button[data-r="onsen"]').click();
  });
  await scenario('3km / 賑やか / カフェ', () => {
    document.getElementById('dist').value = 3;
    document.getElementById('nat').value = -1;
    document.querySelector('#rewards button[data-r="cafe"]').click();
  });
  await scenario('10km / 自然 / ご褒美なし', () => {
    document.getElementById('dist').value = 10;
    document.getElementById('nat').value = 0.75;
    document.querySelector('#rewards button[data-r=""]').click();
  });

  // カード選択とGPX生成
  await page.click('#cards .card:nth-child(2)');
  await page.waitForTimeout(200);
  const selOk = await page.evaluate(() => document.querySelectorAll('#cards .card')[1].classList.contains('sel'));
  // GPX の中身を直接検証
  const gpxText = await page.evaluate(() => {
    const el = document.querySelector('[data-gpx]');
    let captured = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};   // ダウンロード用aタグだけ無効化
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    URL.createObjectURL = origCreate; HTMLAnchorElement.prototype.click = origClick;
    return captured ? captured.text() : null;
  });

  console.log('\n=== 検証 ===');
  let fail = 0;
  const check = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
  results.forEach((r) => {
    check(r.cards >= 1, `${r.name}: コースカードが描画される (${r.cards}枚)`);
    check(!/エラー|×/.test(r.log), `${r.name}: エラーログが出ていない`);
  });
  check(results[0].km.every((k) => Math.abs(parseFloat(k) - 5) / 5 <= 0.15), '5km指定で全カードが±15%以内: ' + results[0].km.join(', '));
  check(results[2].km.every((k) => Math.abs(parseFloat(k) - 10) / 10 <= 0.15), '10km指定で全カードが±15%以内: ' + results[2].km.join(', '));
  check(selOk, 'カードをクリックすると選択状態になる');
  check(!!gpxText && gpxText.includes('<trkpt') && gpxText.includes('</gpx>'), 'GPXが生成される (' + (gpxText ? gpxText.length : 0) + ' bytes)');
  check(errors.length === 0, 'JSエラーなし' + (errors.length ? ' → ' + errors.slice(0, 3).join(' | ') : ''));

  await browser.close();
  console.log(fail === 0 ? '\n*** UI結線テスト 全通過 ***' : `\n*** ${fail}件 NG ***`);
  process.exit(fail === 0 ? 0 : 1);
})();
