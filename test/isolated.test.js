/* 実データで起きた「起点が孤立した歩路にスナップして一歩も動けない」問題の再現テスト。
 * 駅構内の独立した通路のように、街の道路網と繋がっていない小さな断片を
 * 起点のすぐ横に置き、それでもコースが生成できることを確認する。
 */
const RC = require('../src/algo.js');
const N = 40, SP = 90, LAT0 = 35.7100, LON0 = 139.7900;
const dLat = SP / 111320, dLon = SP / (111320 * Math.cos(LAT0 * Math.PI / 180));
const els = [];
const nid = (r, c) => 1000000 + r * 1000 + c;
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
  els.push({ type: 'node', id: nid(r, c), lat: LAT0 + r * dLat, lon: LON0 + c * dLon });
let wid = 5000000;
for (let r = 0; r < N; r++) els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: N }, (_, c) => nid(r, c)) });
for (let c = 0; c < N; c++) els.push({ type: 'way', id: wid++, tags: { highway: 'residential' }, nodes: Array.from({ length: N }, (_, r) => nid(r, c)) });
let pid = 9000000;
const poi = (r, c, tags) => els.push({ type: 'node', id: pid++, lat: LAT0 + r * dLat, lon: LON0 + c * dLon, tags });
for (let r = 4; r < N; r += 3) poi(r, 10, { natural: 'water', name: `川辺${r}` });
for (let r = 20; r < 30; r += 2) for (let c = 20; c < 30; c += 2) poi(r, c, { leisure: 'park', name: `公園${r}` });
poi(11, 11, { amenity: 'public_bath', name: '駅前湯' });
poi(9, 9, { amenity: 'public_bath', name: '横丁湯' });

// --- 起点の真上に、街と繋がっていない孤立した歩路（駅構内の通路を想定）---
const ISO = [];
for (let k = 0; k < 6; k++) {
  const id = 7770000 + k;
  ISO.push(id);
  els.push({ type: 'node', id, lat: LAT0 + 10 * dLat + k * 0.00004, lon: LON0 + 10 * dLon + 0.00002 });
}
els.push({ type: 'way', id: 7779999, tags: { highway: 'footway' }, nodes: ISO });

const g = RC.buildGraph(els);
const cp = RC.components(g);
console.log(`グラフ: 交差点=${g.n} 区間=${g.m} 連結成分=${cp.count}個 最大=${cp.mainSize}`);
// 起点は孤立通路のすぐ上（実際に駅の入口などを起点にしたときの状況）
const startLat = LAT0 + 10 * dLat + 0.00010, startLon = LON0 + 10 * dLon + 0.00002;
const naive = RC.nearestNode(g, startLat, startLon, false);
const fixed = RC.nearestNode(g, startLat, startLon, true);
console.log(`最寄りノード: 制限なし=#${naive}(成分${cp.comp[naive]}, サイズ${cp.sizes[cp.comp[naive]]})  最大成分限定=#${fixed}(成分${cp.comp[fixed]}, サイズ${cp.sizes[cp.comp[fixed]]})`);

const res = RC.generateCourses(g, { startLat, startLon, targetKm: 5, nature: 0.75, sight: 0.5, reward: 'onsen', count: 3 });
let fail = 0;
const ck = (c, m) => { console.log(`${c ? '  OK ' : '  NG '} ${m}`); if (!c) fail++; };
console.log('\n=== 検証 ===');
ck(cp.count > 1, `孤立した断片を含むグラフになっている（成分${cp.count}個）`);
ck(cp.sizes[cp.comp[naive]] < 50, '素朴な最寄り探索だと孤立断片にスナップしてしまう（＝実データで起きた不具合）');
ck(cp.comp[fixed] === cp.main, '修正後は最大の道路網にスナップする');
ck(!res.error, `コースが生成できる${res.error ? '（' + res.error + '）' : ''}`);
if (!res.error) {
  res.courses.forEach((c, i) => console.log(`    #${i + 1} ${(c.total / 1000).toFixed(2)}km 誤差${(c.err * 100).toFixed(0)}% ご褒美=${c.reward ? c.reward.name : 'なし'}`));
  ck(res.courses.every((c) => c.err <= 0.15), '距離が±15%以内');
}
console.log(fail === 0 ? '\n*** 孤立起点テスト 全通過 ***' : `\n*** ${fail}件 NG ***`);
process.exit(fail === 0 ? 0 : 1);
