/* 実データ規模の負荷テスト。
 * 東京23区の実際の道路密度に近い規模（交差点5万〜10万）の合成グラフを作り、
 * 生成が現実的な時間で終わるかを測る。ブラウザで動かす前提なので目標は5秒以内。
 */
const RC = require('../src/algo.js');

function makeCity(N, sp) {              // N x N の格子 + 路地
  const LAT0 = 35.68, LON0 = 139.70;
  const dLat = sp / 111320, dLon = sp / (111320 * Math.cos(LAT0 * Math.PI / 180));
  const els = [];
  const nid = (r, c) => 1000000 + r * 2000 + c;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
    els.push({ type: 'node', id: nid(r, c), lat: LAT0 + r * dLat, lon: LON0 + c * dLon });
  let wid = 8000000;
  for (let r = 0; r < N; r++) els.push({ type: 'way', id: wid++, tags: { highway: r % 10 === 0 ? 'secondary' : 'residential' }, nodes: Array.from({ length: N }, (_, c) => nid(r, c)) });
  for (let c = 0; c < N; c++) els.push({ type: 'way', id: wid++, tags: { highway: c % 10 === 0 ? 'secondary' : 'residential' }, nodes: Array.from({ length: N }, (_, r) => nid(r, c)) });
  let pid = 20000000;
  const poi = (r, c, tags) => els.push({ type: 'node', id: pid++, lat: LAT0 + r * dLat, lon: LON0 + c * dLon, tags });
  // 実データに近い密度でPOIをばらまく（23区は飲食店だけで数千件/数km四方）
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < N * 12; i++) {
    const r = Math.floor(rnd() * N), c = Math.floor(rnd() * N), t = rnd();
    if (t < 0.35) poi(r, c, { amenity: 'restaurant', name: `店${i}` });
    else if (t < 0.55) poi(r, c, { amenity: 'cafe', name: `喫茶${i}` });
    else if (t < 0.7) poi(r, c, { leisure: 'park', name: `公園${i}` });
    else if (t < 0.8) poi(r, c, { amenity: 'place_of_worship', name: `寺社${i}` });
    else if (t < 0.86) poi(r, c, { natural: 'water', name: `水辺${i}` });
    else if (t < 0.9) poi(r, c, { amenity: 'public_bath', name: `銭湯${i}` });
    else poi(r, c, { shop: 'bakery', name: `パン${i}` });
  }
  return { els, LAT0, LON0, dLat, dLon };
}

for (const [N, sp] of [[160, 55], [240, 45]]) {
  const { els, LAT0, LON0, dLat, dLon } = makeCity(N, sp);
  let t = Date.now();
  const g = RC.buildGraph(els);
  const tBuild = Date.now() - t;
  console.log(`\n=== ${N}x${N} 格子 (${(N * sp / 1000).toFixed(1)}km四方) ===`);
  console.log(`  グラフ構築: ${tBuild}ms  交差点=${g.n.toLocaleString()} 区間=${g.m.toLocaleString()} POI=${g.pois.length.toLocaleString()}`);
  for (const km of [5, 10]) {
    t = Date.now();
    const res = RC.generateCourses(g, {
      startLat: LAT0 + (N / 2) * dLat, startLon: LON0 + (N / 2) * dLon,
      targetKm: km, nature: 0.75, sight: 0.5, reward: 'onsen', count: 3,
    });
    const ms = Date.now() - t;
    if (res.error) { console.log(`  ${km}km: ERROR ${res.error} (${ms}ms)`); continue; }
    console.log(`  ${km}km: ${ms}ms  → ` + res.courses.map((c) => `${(c.total / 1000).toFixed(2)}km(誤差${(c.err * 100).toFixed(0)}%,重複${(c.overlap * 100).toFixed(0)}%)`).join(' '));
    if (ms > 5000) console.log(`    ※ 5秒を超過。ブラウザ実行では要改善`);
  }
}
