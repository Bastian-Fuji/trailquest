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
- **名所図鑑**：地図のマーカーやタグをクリックして見たスポットを `localStorage` に記録し、
  種類ごと（神社・博物館・銭湯…）に集めていける。アカウント登録・サーバーは無し
- **クエスト記録（実走ログ）**：「このコースを走った！」ボタンで、日付・距離・獲得標高・
  ご褒美などを記録。自己申告制（実際に走ったかはアプリ側では確認できない）で、
  これも `localStorage` のみ。記録は経路・スポットも丸ごと保存しているので、
  一覧から「地図で見る」を押すとその時のルートを地図に再現できる
- **お気に入り**：ルート（★ボタンで丸ごと保存、後から「地図で見る」で再現できる）と、
  名所（マーカーのポップアップや図鑑の★）の両方を保存できる。ルートはいつでも追加できるが、
  外すのは「お気に入り」一覧の「削除」から
- **標高・高低差**：国土地理院の標高API（無料・APIキー不要）で、選択中のコースの獲得標高・
  下り・標高レンジを表示。経路を最大30点に間引いて問い合わせている
- **PWA対応**：`manifest.json` + Service Worker（`sw.js`）で、スマホのホーム画面に追加できる。
  Service Workerがキャッシュするのはアプリ本体だけで、Overpass・Wikipedia等の外部データ取得には
  一切手を出さない

アルゴリズム本体・データ取得まわりの設計判断は runcourse の `docs/architecture.md` と
`docs/roadmap.md` を参照（このリポジトリにはまだコピーしていません）。

## 構成

```
build.js                 src/ を1ファイルのindex.htmlに合成する（依存なし）
index.html               ビルド済みの成果物。これ単体で動く
src/algo.js              中核アルゴリズム（runcourseと同一 + POIにosmIdを付与）
src/qr.js                QRコード生成（runcourseと同一）
src/app.template.html    UI・地図表示・データ取得（8bit RPG風に作り直し）
manifest.json            PWAマニフェスト
sw.js                    Service Worker（アプリ本体だけをキャッシュ）
icons/                   PWAアイコン（tools/make-icons.js で生成、npm依存なし）
tools/make-icons.js      アイコンPNGを手書きPNGエンコーダで生成するスクリプト
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
