# trailquest

走りたい距離・道の雰囲気・帰りのご褒美から、**周回ランニングコースを自動生成する**プロトタイプ。

[runcourse](../runcourse) の経路探索エンジン（OSMデータ取得・Dijkstraベースのコース生成・GPX/QR出力）はそのまま引き継ぎ、
UIを **8bit RPG風のワールドマップ画面** に作り直したフォークです。サーバー不要・APIキー不要。
`index.html` をブラウザで開くだけで動きます。

## 使い方

```bash
node build.js          # src/ から index.html を生成（依存なし）
open index.html        # ブラウザで開くだけ
```

```bash
npm run serve           # http://localhost:8080
```

## runcourse との違い

- コースを選ぶ画面を「サイドバーの候補一覧＋右に地図」から、**1枚のワールドマップ**に統合。
  各コースは地図上の旗（ステージ）として置かれ、選択中のコースだけ画面下に
  JRPG風のダイアログボックス（距離・スポット・ボタンをまとめた二重ピクセル枠）が開く
- 「自然度・賑わい度・名所度」を、RPGのHP/MPバーのような**ステータスバー**で表示
- フォントは `Press Start 2P`（英数字）＋ `DotGothic16`（日本語のドットフォント）、角丸は使わない
- 地図そのもの（地理院タイル／OpenStreetMap）は実データのまま。実際に走る道を確認する用途なので、
  そこだけは意図的にリアルに保っている

アルゴリズム本体・データ取得まわりの設計判断は runcourse の `docs/architecture.md` と
`docs/roadmap.md` を参照（このリポジトリにはまだコピーしていません）。

## 構成

```
build.js                 src/ を1ファイルのindex.htmlに合成する（依存なし）
index.html               ビルド済みの成果物。これ単体で動く
src/algo.js              中核アルゴリズム（runcourseと同一）
src/qr.js                QRコード生成（runcourseと同一）
src/app.template.html    UI・地図表示・データ取得（8bit RPG風に作り直し）
test/                    テスト一式（runcourseから流用）
```

## テスト

```bash
npm test               # アルゴリズムの中核（距離精度・重複・雰囲気の作り分け）
npm run test:perf      # 実データ規模での速度計測
npm run test:ui        # ヘッドレスChromeでUI結線を確認（Playwrightが必要）
```

`test:qr` は QR画像を OpenCV で読み戻す検証に Python + `opencv-python` が必要です。
入っていない環境では失敗しますが、`src/qr.js` 自体は runcourse から変更していません。

## データとライセンス

- 地図データ： © OpenStreetMap contributors（[ODbL](https://www.openstreetmap.org/copyright)）
- 地図タイル： [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（国土地理院）
- コード： MIT License
