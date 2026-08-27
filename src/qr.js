/* ===========================================================================
 *  最小限のQRコード生成器（バイトモード / 誤り訂正レベルL / 型番1〜9）
 *  ---------------------------------------------------------------------
 *  外部ライブラリを使わずにQRを出すために自前実装している。
 *  用途は「GoogleマップのURLをスマホに渡す」ことだけなので、
 *  必要十分な範囲（最大232バイト）に絞ってある。
 *
 *  QR.encode(text) -> { size, modules }   modules[y][x] = true(黒)/false(白)
 * =========================================================================*/
(function (root) {
  'use strict';

  // 型番ごとの: [1ブロックあたりのデータ語数, ブロック数, 1ブロックあたりのEC語数]
  // （レベルLのみ。1〜5は1ブロック、6〜9は2ブロック）
  const EC_L = {
    1: [19, 1, 7], 2: [34, 1, 10], 3: [55, 1, 15], 4: [80, 1, 20], 5: [108, 1, 26],
    6: [68, 2, 18], 7: [78, 2, 20], 8: [97, 2, 24], 9: [116, 2, 30],
  };
  // 型番ごとの位置合わせパターンの中心座標
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
  };
  // 型番ごとの余りビット数
  const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0 };

  const capacityBytes = (v) => {
    const [dataPerBlock, blocks] = EC_L[v];
    return dataPerBlock * blocks - 2 - (v >= 10 ? 1 : 0); // モード4bit + 文字数8bit = 2バイト分
  };

  // ------------------------------------------------------------ GF(256)
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /** 誤り訂正用の生成多項式 */
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** データ語列からEC語列を作る */
  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift(); res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // -------------------------------------------------- 情報ビット（BCH）
  function bchFormat(bits) {           // 5bit -> 15bit
    let d = bits << 10;
    for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10);
    return ((bits << 10) | d) ^ 0x5412;
  }
  function bchVersion(version) {       // 6bit -> 18bit
    let d = version << 12;
    for (let i = 17; i >= 12; i--) if ((d >> i) & 1) d ^= 0x1f25 << (i - 12);
    return (version << 12) | d;
  }

  // ------------------------------------------------------------ 本体
  function encode(text, opts = {}) {
    const bytes = toUtf8(text);
    let version = opts.version || 0;
    if (!version) {
      for (let v = 1; v <= 9; v++) if (bytes.length <= capacityBytes(v)) { version = v; break; }
    }
    if (!version) throw new Error(`データが長すぎます（${bytes.length}バイト、上限${capacityBytes(9)}）`);

    const [dataPerBlock, blocks, ecPerBlock] = EC_L[version];
    const totalData = dataPerBlock * blocks;

    // --- ビット列を作る：モード指示子(0100) + 文字数(8bit) + 本体 + 終端
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, 8);
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      dataCodewords.push(b);
    }
    const PAD = [0xec, 0x11];
    for (let i = 0; dataCodewords.length < totalData; i++) dataCodewords.push(PAD[i % 2]);

    // --- ブロック分割 → EC計算 → インターリーブ
    const dataBlocks = [], ecBlocks = [];
    for (let b = 0; b < blocks; b++) {
      const blk = dataCodewords.slice(b * dataPerBlock, (b + 1) * dataPerBlock);
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, ecPerBlock));
    }
    const final = [];
    for (let i = 0; i < dataPerBlock; i++) for (const blk of dataBlocks) final.push(blk[i]);
    for (let i = 0; i < ecPerBlock; i++) for (const blk of ecBlocks) final.push(blk[i]);

    // --- 行列を組む
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));   // null=未確定
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (y, x, v) => { m[y][x] = v; fixed[y][x] = true; };

    // 位置検出パターン + 分離帯
    const finder = (fy, fx) => {
      for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
        const y = fy + dy, x = fx + dx;
        if (y < 0 || x < 0 || y >= size || x >= size) continue;
        const inRing = (dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6) &&
          (dy === 0 || dy === 6 || dx === 0 || dx === 6 || (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
        set(y, x, inRing);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // タイミングパターン
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    // 位置合わせパターン
    const centers = ALIGN[version];
    for (const cy of centers) for (const cx of centers) {
      if ((cy <= 8 && cx <= 8) || (cy <= 8 && cx >= size - 9) || (cy >= size - 9 && cx <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        set(cy + dy, cx + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
    }

    // 形式情報の領域を予約（値は後で入れる）＋ 常に黒のモジュール
    const reserveFormat = () => {
      for (let i = 0; i <= 8; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }
      for (let i = 0; i < 8; i++) { if (!fixed[8][size - 1 - i]) set(8, size - 1 - i, false); if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, false); }
      set(size - 8, 8, true);   // 常に黒
    };
    reserveFormat();

    // 型番情報（型番7以上）
    if (version >= 7) {
      const vb = bchVersion(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((vb >> i) & 1) === 1;
        const a = Math.floor(i / 3), b = i % 3;
        set(size - 11 + b, a, bit);
        set(a, size - 11 + b, bit);
      }
    }

    // --- データを配置（右下からジグザグ）
    let bitIdx = 0;
    const allBits = [];
    for (const cw of final) for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
    for (let i = 0; i < REMAINDER[version]; i++) allBits.push(0);

    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;                       // 縦のタイミング列は飛ばす
      for (let i = 0; i < size; i++) {
        const y = upward ? size - 1 - i : i;
        for (const x of [right, right - 1]) {
          if (fixed[y][x]) continue;
          m[y][x] = bitIdx < allBits.length ? allBits[bitIdx] === 1 : false;
          bitIdx++;
        }
      }
      upward = !upward;
    }

    // --- マスク選択
    const MASKS = [
      (y, x) => (y + x) % 2 === 0,
      (y) => y % 2 === 0,
      (y, x) => x % 3 === 0,
      (y, x) => (y + x) % 3 === 0,
      (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
      (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
      (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
      (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
    ];
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const cand = m.map((row) => row.slice());
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
        if (!fixed[y][x] && MASKS[mask](y, x)) cand[y][x] = !cand[y][x];
      writeFormat(cand, size, mask);
      const score = penalty(cand, size);
      if (!best || score < best.score) best = { score, modules: cand, mask };
    }
    return { size, modules: best.modules, version, mask: best.mask };
  }

  function writeFormat(mat, size, mask) {
    const bitsVal = bchFormat((0b01 << 3) | mask);   // レベルL = 01
    for (let i = 0; i < 15; i++) {
      const bit = ((bitsVal >> i) & 1) === 1;
      // 1つ目の複製：左上の縦列（タイミングパターンの行6は飛ばす）
      if (i < 6) mat[i][8] = bit;
      else if (i < 8) mat[i + 1][8] = bit;
      else mat[size - 15 + i][8] = bit;
      // 2つ目の複製：右上の横行 → 左下へ折り返す（列6は飛ばす）
      if (i < 8) mat[8][size - 1 - i] = bit;
      else if (i === 8) mat[8][7] = bit;
      else mat[8][14 - i] = bit;
    }
    mat[size - 8][8] = true;   // 常に黒のモジュール
  }

  /** 読み取りやすさの評価（小さいほど良い） */
  function penalty(mat, size) {
    let score = 0;
    // 規則1：同色の連続
    for (let i = 0; i < size; i++) {
      for (const line of [mat[i], mat.map((r) => r[i])]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          if (line[j] === line[j - 1]) run++;
          else { if (run >= 5) score += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }
    // 規則2：2x2の同色ブロック
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++)
      if (mat[y][x] === mat[y][x + 1] && mat[y][x] === mat[y + 1][x] && mat[y][x] === mat[y + 1][x + 1]) score += 3;
    // 規則3：位置検出パターンに似た並び
    const P1 = [true, false, true, true, true, false, true, false, false, false, false];
    const P2 = [false, false, false, false, true, false, true, true, true, false, true];
    const match = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
    for (let i = 0; i < size; i++) {
      for (const line of [mat[i], mat.map((r) => r[i])]) {
        for (let j = 0; j + 11 <= size; j++) if (match(line, j, P1) || match(line, j, P2)) score += 40;
      }
    }
    // 規則4：白黒の偏り
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mat[y][x]) dark++;
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  function toUtf8(str) {
    const out = [];
    for (const ch of str) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /** 白枠つきのSVG文字列にする */
  function toSvg(qr, opts = {}) {
    const cell = opts.cell || 4, quiet = opts.quiet == null ? 4 : opts.quiet;
    const dim = (qr.size + quiet * 2) * cell;
    let path = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) path += `M${(x + quiet) * cell} ${(y + quiet) * cell}h${cell}v${cell}h-${cell}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  const API = { encode, toSvg, capacityBytes, bchFormat, bchVersion };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.QR = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
