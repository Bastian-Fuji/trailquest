/* ===========================================================================
 *  runcourse core algorithm  (v0.1 prototype)
 *  ---------------------------------------------------------------------
 *  Overpass(OSM) の生JSON  →  歩行ネットワーク  →  要望に沿った周回コース
 *
 *  ブラウザ / Node どちらでも動くように書いてある（末尾でexport切り替え）。
 * =========================================================================*/
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- utils
  const R_EARTH = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  function haversine(aLat, aLon, bLat, bLon) {
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const la1 = toRad(aLat), la2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(aLat, aLon, bLat, bLon) {
    const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
    const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
      Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  /** 単純な二分ヒープ（Dijkstra用） */
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(key, val) {
      const a = this.a; a.push([key, val]);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p][0] <= a[i][0]) break;
        const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
      }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
        }
      }
      return top;
    }
  }

  // ------------------------------------------------------- OSM tag rules
  // 歩ける道（motorway/trunk は除外）
  const WALKABLE = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street',
    'residential', 'unclassified', 'tertiary', 'tertiary_link', 'secondary',
    'secondary_link', 'primary', 'primary_link', 'service', 'track', 'cycleway', 'road']);
  // 交通量が多く走りにくい＝コスト増、かつ「賑やか」寄り
  const BIG_ROAD = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'trunk']);
  const QUIET_ROAD = new Set(['footway', 'path', 'pedestrian', 'living_street', 'track', 'cycleway']);

  /** POIカテゴリ判定。該当しなければ null */
  function classifyPoi(t) {
    if (!t) return null;
    const name = t.name || t['name:ja'] || '';
    // --- ご褒美（ゴール付近に置きたいもの）
    if (t.amenity === 'public_bath' || t['bath:type'] === 'onsen' || t.leisure === 'sauna')
      return { cat: 'onsen', label: t['bath:type'] === 'onsen' ? '温泉' : (t.leisure === 'sauna' ? 'サウナ' : '銭湯'), reward: true };
    if (t.amenity === 'cafe') return { cat: 'cafe', label: 'カフェ', reward: true, buzz: 1 };
    if (t.shop === 'bakery' || t.shop === 'confectionery' || t.amenity === 'ice_cream')
      return { cat: 'sweets', label: 'ベーカリー/甘味', reward: true, buzz: 0.6 };
    if (t.amenity === 'restaurant' || t.amenity === 'fast_food')
      return { cat: 'food', label: t.cuisine ? `飲食（${t.cuisine}）` : '飲食店', reward: true, buzz: 1 };
    if (t.amenity === 'bar' || t.amenity === 'pub')
      return { cat: 'drink', label: '一杯', reward: true, buzz: 1 };
    // --- 景観・自然
    if (t.tourism === 'viewpoint') return { cat: 'view', label: '展望スポット', nature: 1.0, sight: 1.0 };
    if (t.leisure === 'park' || t.leisure === 'garden')
      return { cat: 'park', label: t.leisure === 'garden' ? '庭園' : '公園', nature: 1.0 };
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.natural === 'beach')
      return { cat: 'water', label: '水辺', nature: 1.0 };
    if (t.landuse === 'forest' || t.natural === 'wood' || t.landuse === 'grass')
      return { cat: 'green', label: '緑地', nature: 0.8 };
    // --- 名所（神社・寺・史跡・記念碑・タワー・博物館などをまとめて「名所」1本にする。
    //     「その街のシンボル・綺麗な建物や風景・有名な物や場所」を広く拾う）
    if (t.amenity === 'place_of_worship'
      || t.tourism === 'attraction' || t.tourism === 'artwork' || t.tourism === 'museum' || t.tourism === 'gallery'
      || t.man_made === 'tower' || t.historic || t.heritage)
      return { cat: 'sight', label: '名所', sight: 1.0, nature: t.amenity === 'place_of_worship' ? 0.4 : 0 };
    // --- 賑わい
    if (t.railway === 'station' || t.public_transport === 'station')
      return { cat: 'station', label: '駅', buzz: 1.0 };
    if (t.shop && name) return { cat: 'shop', label: '商店', buzz: 0.5 };
    return null;
  }

  // ------------------------------------------------------------- グラフ構築
  /**
   * Overpass の JSON（node/way/relation の element配列）からグラフとPOIを作る。
   * @returns {lat:Float64Array, lon:Float64Array, head:Int32Array, ...} CSR風の隣接構造
   */
  function buildGraph(elements) {
    const coord = new Map();          // osm node id -> [lat, lon]
    const poiRaw = [];
    for (const el of elements) {
      if (el.type === 'node') {
        coord.set(el.id, [el.lat, el.lon]);
        const c = classifyPoi(el.tags);
        if (c && (el.tags.name || c.cat === 'water' || c.cat === 'green')) poiRaw.push({ ...c, lat: el.lat, lon: el.lon, name: el.tags.name || el.tags['name:ja'] || c.label, tags: el.tags });
      } else if ((el.type === 'way' || el.type === 'relation') && el.center) {
        const c = classifyPoi(el.tags);
        if (c) poiRaw.push({ ...c, lat: el.center.lat, lon: el.center.lon, name: (el.tags && (el.tags.name || el.tags['name:ja'])) || c.label, tags: el.tags || {} });
      }
    }

    // way -> エッジ
    const idx = new Map();            // osm id -> 連番
    const lats = [], lons = [];
    const edgesFrom = [], edgesTo = [], edgeLen = [], edgeKind = [];
    const nodeOf = (osmId) => {
      let i = idx.get(osmId);
      if (i === undefined) {
        const c = coord.get(osmId);
        if (!c) return -1;
        i = lats.length; idx.set(osmId, i); lats.push(c[0]); lons.push(c[1]);
      }
      return i;
    };

    for (const el of elements) {
      if (el.type !== 'way' || !el.tags || !el.nodes) continue;
      const hw = el.tags.highway;
      if (!hw || !WALKABLE.has(hw)) continue;
      if (el.tags.access === 'private' || el.tags.access === 'no') continue;
      if (el.tags.foot === 'no') continue;
      let kind = 0;                                  // 0=普通 1=静か 2=大通り 3=階段
      if (hw === 'steps') kind = 3;
      else if (QUIET_ROAD.has(hw)) kind = 1;
      else if (BIG_ROAD.has(hw)) kind = 2;
      const ns = el.nodes;
      for (let k = 0; k + 1 < ns.length; k++) {
        const a = nodeOf(ns[k]), b = nodeOf(ns[k + 1]);
        if (a < 0 || b < 0 || a === b) continue;
        const len = haversine(lats[a], lons[a], lats[b], lons[b]);
        if (len <= 0 || len > 3000) continue;
        edgesFrom.push(a); edgesTo.push(b); edgeLen.push(len); edgeKind.push(kind);
      }
    }

    const n = lats.length, m = edgesFrom.length;
    // CSR（双方向）
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) { deg[edgesFrom[e] + 1]++; deg[edgesTo[e] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const head = deg.slice();
    const adjTo = new Int32Array(m * 2), adjEdge = new Int32Array(m * 2);
    const fill = deg.slice();
    for (let e = 0; e < m; e++) {
      const a = edgesFrom[e], b = edgesTo[e];
      adjTo[fill[a]] = b; adjEdge[fill[a]++] = e;
      adjTo[fill[b]] = a; adjEdge[fill[b]++] = e;
    }

    return {
      n, m,
      lat: Float64Array.from(lats), lon: Float64Array.from(lons),
      head, adjTo, adjEdge,
      edgeFrom: Int32Array.from(edgesFrom), edgeTo: Int32Array.from(edgesTo),
      edgeLen: Float64Array.from(edgeLen), edgeKind: Int8Array.from(edgeKind),
      pois: poiRaw,
    };
  }

  // ------------------------------------------------- 空間インデックス&雰囲気
  /** 100m格子のグリッド索引 */
  function gridIndex(items, cell = 0.0012) {
    const map = new Map();
    items.forEach((p, i) => {
      const k = `${Math.floor(p.lat / cell)},${Math.floor(p.lon / cell)}`;
      let a = map.get(k); if (!a) map.set(k, a = []); a.push(i);
    });
    return {
      cell, map,
      near(lat, lon, radiusCells = 1) {
        const gy = Math.floor(lat / cell), gx = Math.floor(lon / cell), out = [];
        for (let dy = -radiusCells; dy <= radiusCells; dy++)
          for (let dx = -radiusCells; dx <= radiusCells; dx++) {
            const a = map.get(`${gy + dy},${gx + dx}`);
            if (a) out.push(...a);
          }
        return out;
      },
    };
  }

  /**
   * 各グラフノードに「自然度」「賑わい度」「名所度」を与える。
   * → これがコース生成の“雰囲気”を決める中核。POIを通るかどうかではなく、
   *   どんな道を選ぶかに効かせるのがポイント。
   */
  function scoreNodes(g, opts = {}) {
    const RAD = opts.radius || 180;                 // POI影響半径(m)
    const nature = new Float32Array(g.n);
    const buzz = new Float32Array(g.n);
    const sight = new Float32Array(g.n);
    const gi = gridIndex(g.pois);
    for (let i = 0; i < g.n; i++) {
      const la = g.lat[i], lo = g.lon[i];
      for (const pi of gi.near(la, lo, 2)) {
        const p = g.pois[pi];
        const d = haversine(la, lo, p.lat, p.lon);
        if (d > RAD * 2) continue;
        const w = Math.exp(-((d / RAD) ** 2));      // 距離減衰
        if (p.nature) nature[i] += p.nature * w;
        if (p.buzz) buzz[i] += p.buzz * w;
        if (p.sight) sight[i] += p.sight * w;
      }
    }
    // 0-1に正規化（上位を潰さないようsoftな上限）
    const norm = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = 1 - Math.exp(-arr[i] * 0.8); };
    norm(nature); norm(buzz); norm(sight);
    return { nature, buzz, sight };
  }

  /**
   * ユーザーの要望 → エッジコスト関数
   * pref.nature: -1(賑やか) .. +1(自然)   pref.sight: 0..1(名所を通りたい)
   */
  function makeCost(g, sc, pref) {
    const wNature = Math.max(0, pref.nature), wBuzz = Math.max(0, -pref.nature);
    const wSight = pref.sight || 0;
    const cost = new Float64Array(g.m);
    for (let e = 0; e < g.m; e++) {
      const a = g.edgeFrom[e], b = g.edgeTo[e];
      const nat = (sc.nature[a] + sc.nature[b]) / 2;
      const bz = (sc.buzz[a] + sc.buzz[b]) / 2;
      const si = (sc.sight[a] + sc.sight[b]) / 2;
      let mul = 1;
      mul -= 0.45 * wNature * nat;
      mul -= 0.45 * wBuzz * bz;
      mul -= 0.30 * wSight * si;
      const k = g.edgeKind[e];
      if (k === 2) mul += 0.35 * (0.5 + wNature);   // 大通りは走りにくい
      if (k === 1) mul -= 0.10;                     // 歩専用路はうれしい
      if (k === 3) mul += 2.0;                      // 階段は基本避ける
      const c0 = g.edgeLen[e] * Math.max(0.35, mul);
      cost[e] = isFinite(c0) && c0 > 0 ? c0 : Math.max(1, g.edgeLen[e]);   // 異常値でグラフを壊さない
    }
    return cost;
  }

  // ------------------------------------------------------------- Dijkstra
  /**
   * @param penal Float64Array|null  エッジ倍率（再通過ペナルティ）
   * @returns {dist(コスト), real(実距離), prevNode, prevEdge}
   */
  function dijkstra(g, cost, src, penal, maxCost = Infinity) {
    const dist = new Float64Array(g.n).fill(Infinity);
    const real = new Float64Array(g.n).fill(Infinity);
    const prevN = new Int32Array(g.n).fill(-1);
    const prevE = new Int32Array(g.n).fill(-1);
    const done = new Uint8Array(g.n);
    const h = new Heap();
    dist[src] = 0; real[src] = 0; h.push(0, src);
    while (h.size) {
      const [d, u] = h.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (d > maxCost) break;
      for (let k = g.head[u]; k < g.head[u + 1]; k++) {
        const v = g.adjTo[k], e = g.adjEdge[k];
        const w = cost[e] * (penal ? penal[e] : 1);
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd; real[v] = real[u] + g.edgeLen[e];
          prevN[v] = u; prevE[v] = e;
          h.push(nd, v);
        }
      }
    }
    return { dist, real, prevN, prevE };
  }

  function tracePath(res, src, dst) {
    if (!isFinite(res.dist[dst])) return null;
    const nodes = [], edges = [];
    let cur = dst;
    while (cur !== src) {
      const e = res.prevE[cur];
      if (e < 0) return null;
      nodes.push(cur); edges.push(e);
      cur = res.prevN[cur];
    }
    nodes.push(src);
    nodes.reverse(); edges.reverse();
    return { nodes, edges, length: res.real[dst] };
  }

  /** ノードの格子索引（初回だけ構築してグラフに載せる） */
  function nodeGrid(g) {
    if (g._grid) return g._grid;
    const cell = 0.0025;                        // 約250m
    const map = new Map();
    for (let i = 0; i < g.n; i++) {
      const k = `${Math.floor(g.lat[i] / cell)},${Math.floor(g.lon[i] / cell)}`;
      let a = map.get(k); if (!a) map.set(k, a = []); a.push(i);
    }
    return (g._grid = { cell, map });
  }

  /** 連結成分を求める（道路網は橋・私道・データ欠損で分断されていることがある） */
  function components(g) {
    if (g._comp) return g._comp;
    const comp = new Int32Array(g.n).fill(-1);
    const stack = new Int32Array(g.n);
    const sizes = [];
    let c = 0;
    for (let s = 0; s < g.n; s++) {
      if (comp[s] !== -1) continue;
      let sp = 0, size = 0;
      stack[sp++] = s; comp[s] = c;
      while (sp) {
        const u = stack[--sp]; size++;
        for (let k = g.head[u]; k < g.head[u + 1]; k++) {
          const v = g.adjTo[k];
          if (comp[v] === -1) { comp[v] = c; stack[sp++] = v; }
        }
      }
      sizes.push(size); c++;
    }
    let main = 0, mx = -1;
    for (let i = 0; i < sizes.length; i++) if (sizes[i] > mx) { mx = sizes[i]; main = i; }
    return (g._comp = { comp, sizes, main, mainSize: mx, count: sizes.length });
  }

  /**
   * 最寄りのグラフノード。mainOnly=true なら「最大の連結道路網」の中から選ぶ。
   * ※ 駅構内の孤立した歩路などにスナップしてしまうと、そこから一歩も動けなくなる。
   */
  function nearestNode(g, lat, lon, mainOnly) {
    const gr = nodeGrid(g);
    const cp = mainOnly ? components(g) : null;
    const gy = Math.floor(lat / gr.cell), gx = Math.floor(lon / gr.cell);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= 40; ring++) {
      for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
        if (ring > 0 && Math.max(Math.abs(dy), Math.abs(dx)) !== ring) continue;  // 外周のみ
        const a = gr.map.get(`${gy + dy},${gx + dx}`);
        if (!a) continue;
        for (const i of a) {
          if (cp && cp.comp[i] !== cp.main) continue;
          const d = (g.lat[i] - lat) ** 2 + (g.lon[i] - lon) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && ring >= 1) break;        // 1リング余分に見てから確定
    }
    return best;
  }

  // ---------------------------------------------------------- コース生成本体
  /**
   * @param req {startLat,startLon,targetKm,nature(-1..1),sight(0..1),reward:'onsen'|'cafe'|...|null,count}
   */
  function generateCourses(g, req) {
    const target = req.targetKm * 1000;
    const sc = scoreNodes(g);
    const cost = makeCost(g, sc, { nature: req.nature ?? 0.5, sight: req.sight ?? 0.5 });

    const cp = components(g);
    const start = nearestNode(g, req.startLat, req.startLon, true);
    if (start < 0) return { error: 'no_graph' };

    const out0 = dijkstra(g, cost, start, null, target * 1.4);
    const reachable = [];
    for (let i = 0; i < g.n; i++) if (isFinite(out0.real[i])) reachable.push(i);
    if (reachable.length < 50) return {
      error: 'graph_too_small', reachable: reachable.length,
      mainSize: cp.mainSize, components: cp.count, nodes: g.n,
    };

    // --- ご褒美スポット候補（ゴール手前＝家の近くに置く）
    let rewardCands = [];
    if (req.reward) {
      const wanted = new Set(req.reward === 'food' ? ['food', 'drink'] :
        req.reward === 'onsen' ? ['onsen'] :
          req.reward === 'cafe' ? ['cafe', 'sweets'] : [req.reward]);
      const straightCap = Math.min(2000, target * 0.35);
      for (const p of g.pois) {
        if (!wanted.has(p.cat)) continue;
        if (haversine(p.lat, p.lon, req.startLat, req.startLon) > straightCap) continue;  // 直線距離で粗く足切り
        const nd = nearestNode(g, p.lat, p.lon, true);
        const dr = out0.real[nd];
        if (!isFinite(dr)) continue;
        if (dr > Math.min(2000, target * 0.35)) continue;   // 帰り道に寄れる範囲
        rewardCands.push({ poi: p, node: nd, distFromStart: dr });
      }
      rewardCands.sort((a, b) => a.distFromStart - b.distFromStart);
      rewardCands = rewardCands.slice(0, 8);
    }

    // --- 折り返しアンカー候補：目標距離の 1/3 前後で、雰囲気スコアが高いノード
    //     ※ 最短経路で結ぶと想定より短くなるので、1周目の実測から補正して2周目を回す
    let center = target * 0.36, span = 0.30;
    let best = null;
    for (let pass = 0; pass < 2; pass++) {
      const r = buildCandidates(center, span);
      if (!best || r.results.length) best = r;
      if (!r.results.length) break;
      // 実測比 ρ = 総距離 / アンカー距離 → 次のパスでアンカー距離を目標に合わせる
      const ratios = r.results.map((x) => x.total / x.anchorDist).sort((a, b) => a - b);
      const rho = ratios[Math.floor(ratios.length / 2)];
      const nextCenter = target / rho;
      if (pass === 0 && isFinite(nextCenter) && nextCenter > 50) {
        const bestErr = Math.min(...r.results.map((x) => x.err));
        if (bestErr <= 0.05) break;                 // すでに十分な精度
        center = nextCenter; span = 0.22;
      } else break;
    }
    const results = best ? best.results : [];
    const pickedCount = best ? best.pickedCount : 0;

    function buildCandidates(centerDist, spanRatio) {
      const rMin = Math.max(120, centerDist * (1 - spanRatio)), rMax = centerDist * (1 + spanRatio);
      const multi = target > 6500;           // 長距離は折り返し点2つで“多角形”にする
      const anchors = [];
      for (const i of reachable) {
        const d = out0.real[i];
        if (d < rMin || d > rMax) continue;
        const s = (req.nature >= 0 ? sc.nature[i] * req.nature : sc.buzz[i] * -req.nature)
          + (req.sight ?? 0) * sc.sight[i];
        anchors.push({ node: i, d, score: s, bear: bearing(req.startLat, req.startLon, g.lat[i], g.lon[i]) });
      }
      if (!anchors.length) return { results: [], pickedCount: 0 };
      anchors.sort((a, b) => b.score - a.score);

      // 方位で散らして多様性を確保
      const picked = [];
      for (const a of anchors) {
        if (picked.length >= (multi ? 8 : 12)) break;
        if (picked.some((p) => angDiff(p.bear, a.bear) < 35)) continue;
        picked.push(a);
      }
      for (const a of anchors) {
        if (picked.length >= (multi ? 8 : 12)) break;
        if (!picked.includes(a)) picked.push(a);
      }

      const PEN = 6.0;                       // 同じ道を戻るときの倍率
      const results = [];
      let budget = req.budget || Math.max(20, Math.min(80, Math.round(1600000 / Math.max(1, g.n))));  // グラフが大きいほど探索回数を絞る
      const mark = (pen, leg) => { for (const e of leg.edges) pen[e] = Math.max(pen[e], PEN); };

      const secondAnchors = (a) => {
        if (!multi) return [null];
        const out = [];
        for (const b of anchors) {
          if (out.length >= 2) break;
          const ad = angDiff(a.bear, b.bear);
          if (ad < 55 || ad > 150) continue;
          if (b.d < a.d * 0.6 || b.d > a.d * 1.3) continue;
          if (out.some((o) => angDiff(o.bear, b.bear) < 30)) continue;
          out.push(b);
        }
        return out.length ? out : [null];
      };

      const bestRewards = (res, k) => {
        if (!rewardCands.length) return [null];
        const scored = [];
        for (const rc of rewardCands) {
          const d = res.real[rc.node];
          if (!isFinite(d)) continue;
          scored.push({ rc, key: d + haversine(g.lat[rc.node], g.lon[rc.node], req.startLat, req.startLon) });
        }
        scored.sort((x, y) => x.key - y.key);
        return scored.slice(0, k).map((x) => x.rc);
      };

      outer:
      for (const anc of picked) {
        const leg1 = tracePath(out0, start, anc.node);
        if (!leg1) continue;
        const penalA = new Float64Array(g.m).fill(1);
        mark(penalA, leg1);

        for (const b of secondAnchors(anc)) {
          if (budget <= 0) break outer;
          let legs = [leg1], total = leg1.length, cursor = anc.node;
          let penal = penalA;
          if (b) {
            budget--;
            const rB = dijkstra(g, cost, cursor, penal, target * 1.7);
            const l2 = tracePath(rB, cursor, b.node);
            if (!l2) continue;
            penal = penal.slice(); mark(penal, l2);
            legs = legs.concat([l2]); total += l2.length; cursor = b.node;
          }

          budget--;
          const rC = dijkstra(g, cost, cursor, penal, target * 1.7);

          for (const rc of bestRewards(rC, 2)) {
            let legs2 = legs.slice(), tot = total, cur = cursor, pen = penal;
            if (rc) {
              const l = tracePath(rC, cur, rc.node);
              if (!l) continue;
              pen = penal.slice(); mark(pen, l);
              legs2.push(l); tot += l.length; cur = rc.node;
              if (budget <= 0) break outer;
              budget--;
              const rD = dijkstra(g, cost, cur, pen, target * 1.7);
              const l3 = tracePath(rD, cur, start);
              if (!l3) continue;
              legs2.push(l3); tot += l3.length;
            } else {
              const l3 = tracePath(rC, cur, start);
              if (!l3) continue;
              legs2.push(l3); tot += l3.length;
            }

            const err = Math.abs(tot - target) / target;
            if (err > 0.30) continue;

            // 重複率
            const seen = new Map();
            let dup = 0;
            for (const lg of legs2) for (const e of lg.edges) {
              const c = (seen.get(e) || 0) + 1; seen.set(e, c);
              if (c > 1) dup += g.edgeLen[e];
            }
            const overlap = dup / tot;

            const nodes = [];
            for (const lg of legs2) nodes.push(...lg.nodes);
            const passed = collectPois(g, nodes, sc, req);
            let quality = 0;
            for (const nIdx of nodes) {
              quality += (req.nature >= 0 ? sc.nature[nIdx] * req.nature : sc.buzz[nIdx] * -req.nature)
                + (req.sight ?? 0) * sc.sight[nIdx];
            }
            quality /= nodes.length;

            const score = quality * 1.0 - overlap * 1.2 - err * 6.0
              + (rc ? 0.35 : 0) + Math.min(passed.highlights.length, 6) * 0.03;

            results.push({
              nodes, legs: legs2, total: tot, err, overlap, quality, score,
              bearing: anc.bear, anchorDist: anc.d,
              reward: rc ? rc.poi : null,
              anchorNode: anc.node,
              highlights: passed.highlights,
              mix: passed.mix,
              coords: nodes.map((i) => [g.lat[i], g.lon[i]]),
            });
          }
        }
        if (results.filter((r) => r.err <= 0.08).length >= 8) break;
      }
      return { results, pickedCount: picked.length };
    }

    if (!results.length) return { error: 'no_route' };
    results.sort((a, b) => b.score - a.score);

    // 距離が合わないものは出さない（±15%以内を厳守。無ければ±25%まで緩める）
    let pool = results.filter((r) => r.err <= 0.15);
    if (!pool.length) pool = results.filter((r) => r.err <= 0.25);
    if (!pool.length) return { error: 'distance_unreachable', closest: (results[0].total / 1000).toFixed(2) };

    // 方位＋経路の重なりで散らして上位を返す（似たコースを3本並べない）
    const want = req.count || 3;
    const edgeSetOf = (r) => { const s2 = new Set(); for (const lg of r.legs) for (const e of lg.edges) s2.add(e); return s2; };
    const jaccard = (A, B) => { let inter = 0; for (const e of A) if (B.has(e)) inter++; return inter / (A.size + B.size - inter); };
    const final = [];
    const sets = [];
    const tryAdd = (r, bearGate, simGate) => {
      if (final.length >= want) return;
      if (final.includes(r)) return;
      if (final.some((f) => angDiff(f.bearing, r.bearing) < bearGate)) return;
      const es = edgeSetOf(r);
      if (sets.some((s2) => jaccard(es, s2) > simGate)) return;
      final.push(r); sets.push(es);
    };
    for (const r of pool) tryAdd(r, 40, 0.5);
    for (const r of pool) tryAdd(r, 0, 0.6);
    for (const r of pool) tryAdd(r, 0, 0.75);   // それでも埋まらなければ本数を減らす
    return { courses: final, stats: { nodes: g.n, edges: g.m, pois: g.pois.length, anchors: pickedCount, candidates: results.length, mainSize: cp.mainSize, components: cp.count } };
  }

  /** ルート沿い120m以内のPOIを拾って見どころリストにする */
  function collectPois(g, nodeSeq, sc, req) {
    const gi = gridIndex(g.pois);
    const found = new Map();
    const step = Math.max(1, Math.floor(nodeSeq.length / 300));
    for (let k = 0; k < nodeSeq.length; k += step) {
      const i = nodeSeq[k];
      for (const pi of gi.near(g.lat[i], g.lon[i], 1)) {
        const p = g.pois[pi];
        const d = haversine(g.lat[i], g.lon[i], p.lat, p.lon);
        if (d > 120) continue;
        const prev = found.get(pi);
        if (!prev || prev.dist > d) found.set(pi, { poi: p, dist: d, at: k / nodeSeq.length });
      }
    }
    const all = [...found.values()];
    const mix = { nature: 0, buzz: 0, sight: 0 };
    for (const f of all) {
      if (f.poi.nature) mix.nature++;
      if (f.poi.buzz) mix.buzz++;
      if (f.poi.sight) mix.sight++;
    }
    const wantBuzz = req && (req.nature ?? 0) < 0;
    const hl = (p) => (p.sight || 0) * 1.2 + (wantBuzz ? (p.buzz || 0) : (p.nature || 0));
    const highlights = all
      .filter((f) => hl(f.poi) > 0 && f.poi.name && !f.poi.reward)
      .sort((a, b) => hl(b.poi) - hl(a.poi))
      .slice(0, 8)
      .sort((a, b) => a.at - b.at);
    return { highlights, mix, all };
  }

  const API = {
    haversine, bearing, buildGraph, scoreNodes, makeCost, dijkstra,
    tracePath, nearestNode, generateCourses, classifyPoi, WALKABLE, components,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.RC = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
