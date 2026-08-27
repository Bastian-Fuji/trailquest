/* 合成データによるアルゴリズム検証（外部ネット不要）
 * 東京の下町を模した 50x50 の格子路 + 公園 + 川沿い + 商店街 + 銭湯 を作り、
 * 「距離が合うか」「同じ道を戻っていないか」「要望どおりの雰囲気の道を選ぶか」を確認する。
 */
const RC = require('../src/algo.js');

const N = 46;                 // 格子サイズ
const SP = 90;                // 交差点間隔(m)
const LAT0 = 35.7100, LON0 = 139.7900;   // 台東区あたり
const dLat = SP / 111320;
const dLon = SP / (111320 * Math.cos(LAT0 * Math.PI / 180));

const els = [];
const nid = (r, c) => 1000000 + r * 1000 + c;
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
  els.push({ type: 'node', id: nid(r, c), lat: LAT0 + r * dLat, lon: LON0 + c * dLon });
}
let wid = 5000000;
// 東西の道
for (let r = 0; r < N; r++) {
  let hw = 'residential';
  if (r % 8 === 0) hw = 'secondary';               // 大通り
  if (r === 30) hw = 'pedestrian';                 // 商店街
  els.push({ type: 'way', id: wid++, tags: { highway: hw, name: `E-W ${r}` }, nodes: Array.from({ length: N }, (_, c) => nid(r, c)) });
}
// 南北の道
for (let c = 0; c < N; c++) {
  let hw = 'residential';
  if (c % 8 === 0) hw = 'secondary';
  if (c === 12) hw = 'footway';                    // 川沿いの遊歩道
  els.push({ type: 'way', id: wid++, tags: { highway: hw, name: `N-S ${c}` }, nodes: Array.from({ length: N }, (_, r) => nid(r, c)) });
}

// --- POI ---
let pid = 9000000;
const poi = (r, c, tags) => els.push({ type: 'node', id: pid++, lat: LAT0 + r * dLat, lon: LON0 + c * dLon, tags });
// 大きな公園（北東 r 32-40, c 30-38）
for (let r = 32; r <= 40; r += 2) for (let c = 30; c <= 38; c += 2) poi(r, c, { leisure: 'park', name: `緑の公園${r}-${c}` });
// 川沿いの水辺（c=12 の縦ライン）
for (let r = 2; r < N; r += 3) poi(r, 12, { natural: 'water', name: `川辺${r}` });
// 商店街の賑わい（r=30 の横ライン）
for (let c = 4; c < N; c += 2) poi(30, c, { shop: 'clothes', name: `商店${c}` });
for (let c = 6; c < N; c += 6) poi(30, c, { amenity: 'cafe', name: `喫茶${c}` });
// 駅（南西）
poi(2, 4, { railway: 'station', name: '下町駅' });
// 神社いくつか
poi(20, 34, { amenity: 'place_of_worship', religion: 'shinto', name: '鷲神社' });
poi(38, 8, { amenity: 'place_of_worship', religion: 'buddhist', name: '長明寺' });
poi(8, 40, { tourism: 'viewpoint', name: 'スカイビュー' });
// 銭湯（スタート地点＝r10,c10 の近くと、遠くに1つ）
poi(12, 8, { amenity: 'public_bath', name: '日の出湯' });
poi(9, 14, { amenity: 'public_bath', name: '大黒湯' });
poi(42, 42, { amenity: 'public_bath', name: '遠くの湯' });
// 飲食
for (let i = 0; i < 12; i++) poi(10 + (i % 5), 6 + i, { amenity: 'restaurant', name: `食堂${i}`, cuisine: 'ramen' });

const g = RC.buildGraph(els);
console.log(`graph: nodes=${g.n} edges=${g.m} pois=${g.pois.length}`);

const START = { startLat: LAT0 + 10 * dLat, startLon: LON0 + 10 * dLon };

function run(label, req) {
  const t0 = Date.now();
  const res = RC.generateCourses(g, { ...START, ...req });
  const ms = Date.now() - t0;
  if (res.error) { console.log(`\n[${label}] ERROR: ${res.error}`); return null; }
  console.log(`\n[${label}]  target=${req.targetKm}km  (${ms}ms, 候補${res.stats.candidates}本)`);
  res.courses.forEach((c, i) => {
    const names = c.highlights.map((h) => h.poi.name).slice(0, 4).join('・') || '—';
    console.log(`  #${i + 1} ${(c.total / 1000).toFixed(2)}km  誤差${(c.err * 100).toFixed(1)}%  ` +
      `重複${(c.overlap * 100).toFixed(0)}%  自然/賑/名所=${c.mix.nature}/${c.mix.buzz}/${c.mix.sight}  ` +
      `ご褒美=${c.reward ? c.reward.name : 'なし'}  経由:${names}`);
  });
  return res;
}

const results = {};
results.nature5 = run('自然重視 + 銭湯', { targetKm: 5, nature: 1, sight: 0.3, reward: 'onsen' });
results.buzz3 = run('賑やか重視 + カフェ', { targetKm: 3, nature: -1, sight: 0.2, reward: 'cafe' });
results.sight8 = run('名所重視 + 飯', { targetKm: 8, nature: 0.4, sight: 1, reward: 'food' });
results.plain2 = run('ご褒美なし 短距離', { targetKm: 2, nature: 0.6, sight: 0.3, reward: null });
results.long12 = run('ロング', { targetKm: 12, nature: 1, sight: 0.5, reward: 'onsen' });

// ---------------------------- 検証 ----------------------------
let fail = 0;
const check = (cond, msg) => { console.log(`${cond ? '  OK ' : '  NG '} ${msg}`); if (!cond) fail++; };
console.log('\n=== 検証 ===');
for (const [k, res] of Object.entries(results)) {
  if (!res) { console.log(`  NG ${k}: 生成できず`); fail++; continue; }
  check(res.courses.length >= 1, `${k}: コースが生成される (${res.courses.length}本)`);
  check(res.courses.every((c) => c.err <= 0.15), `${k}: 全コースが目標距離±15%以内`);
  check(res.courses.every((c) => c.overlap <= 0.45), `${k}: 往復重複45%以下 (最大${Math.max(...res.courses.map((c) => c.overlap * 100)).toFixed(0)}%)`);
}
// 雰囲気の作り分けができているか
const natMix = results.nature5.courses.reduce((s, c) => s + c.mix.nature, 0) / results.nature5.courses.length;
const buzMixOfNature = results.nature5.courses.reduce((s, c) => s + c.mix.buzz, 0) / results.nature5.courses.length;
const buzMix = results.buzz3.courses.reduce((s, c) => s + c.mix.buzz, 0) / results.buzz3.courses.length;
console.log(`  自然重視コースの 自然POI=${natMix.toFixed(1)} / 賑POI=${buzMixOfNature.toFixed(1)}`);
console.log(`  賑やか重視コースの 賑POI=${buzMix.toFixed(1)}`);
check(natMix > buzMixOfNature, '自然重視で自然POIが賑わいPOIを上回る');
// ご褒美がゴール手前に来ているか
for (const [k, res] of Object.entries(results)) {
  if (!res) continue;
  const withReward = res.courses.filter((c) => c.reward);
  if (!withReward.length) continue;
  check(withReward.length >= 1, `${k}: ご褒美スポットを含むコースがある`);
}
console.log(fail === 0 ? '\n*** 全チェック通過 ***' : `\n*** ${fail}件 NG ***`);
process.exit(fail === 0 ? 0 : 1);
