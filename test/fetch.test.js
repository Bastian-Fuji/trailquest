/* データ取得まわりの検証。
 * Overpassへのリクエストを横取りして中身を調べ、
 *  - 長い距離でも必要な範囲を取りに行くか（以前は4km上限で頭打ちになりエラーになった）
 *  - 要望に関係ないスポットを取りに行っていないか
 *  - 2回目以降が通信なしで済むか
 * を確かめる。返すデータは要求されたbboxに合わせて生成する。
 */
const { chromium } = require('playwright');
const path = require('path');

/** 要求されたbboxを覆う格子状の街を作って返す */
function cityFor(bbox, spacing = 110) {
  const [s, w, n, e] = bbox;
  const dLat = spacing / 111320;
  const dLon = spacing / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  const rows = Math.min(220, Math.floor((n - s) / dLat));
  const cols = Math.min(220, Math.floor((e - w) / dLon));
  const els = [];
  const nid = (r, c) => 1000000 + r * 1000 + c;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++)
    els.push({ type: 'node', id: nid(r, c), lat: s + r * dLat, lon: w + c * dLon });
  let wid = 5000000;
  for (let r = 0; r <= rows; r++)
    els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: cols + 1 }, (_, c) => nid(r, c)) });
  for (let c = 0; c <= cols; c++)
    els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: rows + 1 }, (_, r) => nid(r, c)) });
  // スポットを散らす
  let pid = 9000000;
  const poi = (r, c, tags) => els.push({ type: 'node', id: pid++, lat: s + r * dLat, lon: w + c * dLon, tags });
  for (let r = 2; r < rows; r += 6) for (let c = 2; c < cols; c += 6) poi(r, c, { leisure: 'park', name: `公園${r}_${c}` });
  for (let r = 4; r < rows; r += 9) poi(r, Math.floor(cols / 2), { natural: 'water', name: `川辺${r}` });
  const cr = Math.floor(rows / 2), cc = Math.floor(cols / 2);
  poi(cr + 3, cc + 2, { amenity: 'public_bath', name: '中央湯' });
  poi(cr - 4, cc - 3, { amenity: 'public_bath', name: '西の湯' });
  return { elements: els };
}

const STUB = `const chain=()=>{const o={addTo:()=>o,on:()=>o,bindTooltip:()=>o,setView:()=>o,clearLayers:()=>o,removeLayer:()=>o,fitBounds:()=>o,getZoom:()=>14};return o};
window.L={map:()=>{const m=chain();m.on=(e,f)=>{if(e==='click')window.__mapClick=f;return m};return m},tileLayer:()=>chain(),layerGroup:()=>chain(),polyline:()=>chain(),circleMarker:()=>chain(),latLngBounds:()=>({})};`;

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));

  const requests = [];       // 送られたクエリを記録する
  await p.route('**/leaflet.js', (r) => r.fulfill({ contentType: 'application/javascript', body: STUB }));
  await p.route('**/leaflet.css', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  await p.route('**/cyberjapandata.gsi.go.jp/**', (r) => r.abort());
  await p.route('**/api/interpreter*', (route) => {
    const req = route.request();
    const raw = req.method() === 'POST' ? req.postData() : new URL(req.url()).search.slice(1);
    const q = decodeURIComponent((raw || '').replace(/^data=/, '').replace(/\+/g, ' '));
    const boxes = [...q.matchAll(/\(\s*(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\s*\)/g)]
      .map((m) => m.slice(1).map(Number));
    const outer = boxes.reduce((a, x) => [Math.min(a[0], x[0]), Math.min(a[1], x[1]), Math.max(a[2], x[2]), Math.max(a[3], x[3])],
      [90, 180, -90, -180]);
    requests.push({ query: q, outer, spanKm: (outer[2] - outer[0]) * 111.32 });
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(cityFor(outer)) });
  });

  await p.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__mapClick({ latlng: { lat: 35.6800, lng: 139.7600 } }));

  const run = async (km, reward, nature) => {
    await p.evaluate(([k, r, n]) => {
      document.getElementById('dist').value = k;
      document.getElementById('nat').value = n;
      document.querySelector(`#rewards button[data-r="${r}"]`).click();
    }, [km, reward, nature]);
    await p.click('#go');
    await p.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 180000 });
    return p.evaluate(() => ({
      cards: document.querySelectorAll('#cards .card').length,
      km: [...document.querySelectorAll('#cards .km')].map((e) => parseFloat(e.textContent)),
      log: document.getElementById('log').innerText,
    }));
  };

  let fail = 0;
  const ck = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };

  console.log('=== 5km ===');
  const r5 = await run(5, 'onsen', 0.5);
  console.log(`  取得範囲 ${requests.at(-1).spanKm.toFixed(1)}km四方 / カード${r5.cards}枚 / ${r5.km.join(', ')}km`);
  ck(r5.cards >= 1, '5kmでコースが生成される');
  ck(r5.km.every((k) => Math.abs(k - 5) / 5 <= 0.15), '5kmが±15%以内');

  console.log('\n=== スポットの絞り込み ===');
  const q5 = requests.at(-1).query;
  ck(/public_bath/.test(q5), '銭湯を選んだので public_bath を取りに行っている');
  ck(!/restaurant/.test(q5), '関係ない restaurant は取りに行っていない（取得量の削減）');
  ck(/leisure.*park/.test(q5), '景観スポット（公園）は常に取りに行く');

  console.log('\n=== 2回目は通信しない ===');
  const before = requests.length;
  const r5b = await run(5, 'onsen', 0.5);
  ck(requests.length === before, `同じ条件の再実行で通信が発生しない（リクエスト数 ${before} のまま）`);
  ck(/再利用/.test(r5b.log), 'ログに再利用と表示される');

  const before2 = requests.length;
  await run(4, 'onsen', 0.5);
  ck(requests.length === before2, '距離を少し短くしても取得済みデータで足りる');

  console.log('\n=== 長距離（以前はここでエラーになった） ===');
  const r15 = await run(15, 'onsen', 0.5);
  const last = requests.at(-1);
  console.log(`  取得範囲 ${last.spanKm.toFixed(1)}km四方 / カード${r15.cards}枚 / ${r15.km.join(', ')}km`);
  ck(last.spanKm >= 14, `15km走に必要な範囲を取りに行く（${last.spanKm.toFixed(1)}km四方）`);
  ck(r15.cards >= 1, '15kmでもコースが生成される');
  ck(r15.km.every((k) => Math.abs(k - 15) / 15 <= 0.15), `15kmが±15%以内（${r15.km.join(', ')}）`);
  ck(!/エラー|×\s/.test(r15.log), 'エラーが出ていない');

  console.log('\n=== 遠い場所ほど細い道を省く ===');
  const zones = (last.query.match(/way\["highway"/g) || []).length;
  ck(zones === 3, `道路の取得が3段階に分かれている（${zones}段階）`);
  ck(/steps\|/.test(last.query.split('way["highway"')[1]), '内側は階段まで含む詳細な取得');
  ck(!/steps/.test(last.query.split('way["highway"').at(-1)), '外側は細い道を省いている');

  ck(errs.length === 0, 'JSエラーなし' + (errs.length ? ' → ' + errs[0] : ''));
  await b.close();
  console.log(fail === 0 ? '\n*** データ取得テスト 全通過 ***' : `\n*** ${fail}件 NG ***`);
  process.exit(fail === 0 ? 0 : 1);
})();
