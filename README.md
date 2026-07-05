# 1on1練習シミュレーター（仮）

AIが部下役を務める1on1の練習ソフト……のはずだった。
元気な新人・無口なエンジニア・怯える総務、3人の部下と選択式で対話する短編ノベルゲーム（プレイ時間 約15分）。

生成AIをフル活用し、大企業でのマネジメント実務経験をもとに制作。

## 遊ぶ

`public/index.html` をブラウザで開くだけ（単一ファイル・約860KB・依存なし）。

## リポジトリ構成

```
├── scenario.js       シナリオデータ（テキスト修正はここだけ）
├── game.dev.html     開発用ゲーム本体（scenario.js / assets を外部参照）
├── assets/           画像（WebP）
├── build.py          配布用 public/ を生成（検証つき）
├── validate.py       シナリオ整合チェック（リンク・全ルートスコア解析）
├── public/           ビルド産物（★公開・デプロイ対象はこのフォルダのみ）
│   ├── index.html    ゲーム本体（単一ファイル）
│   └── og.png        OGP画像（1200×630）
├── og.png            OGP画像の原本
├── test/             E2E自動テスト（Puppeteer）
└── docs/             公開整備レビュー報告など
```

## 開発サイクル

```
1. scenario.js を編集して保存
2. ブラウザで game.dev.html?scene=シーンID を開く（F5 で再読込）
   例: game.dev.html?scene=suzuki_009
3. python validate.py   … リンク切れ・全23,040ルートのスコア到達性を数秒で検証
4. python build.py      … 検証 → public/index.html を再生成
```

※ Windows では `python`（または `py -3`）、macOS/Linux では `python3` を使用。
　 標準ライブラリのみで動くため、追加の pip install は不要です。

### セリフ・シーンの増やし方 / 画像の差し替え方

`beats` 配列への追記、`assets/` の同名上書き、新キャラ立ち絵の追加手順などの
レシピは [docs/公開整備レビュー報告.md](docs/公開整備レビュー報告.md) と
このREADMEの元になった開発キットの手順に準じます。要点：

- セリフ追加: `scenario.js` の該当シーンの `beats` に
  `{ "k": "d", "s": "話者名", "t": "セリフ" }` を追加
  （`k`: `d`=会話 / `thought`=内心 / `stage`=ト書き / `system`=通知）
- 選択肢の `type` はスコア直結: `normal`(+2/+2), `weird`(+1/0), `crazy`(0/0)
- 画像差し替え: `assets/` の同名ファイルを上書きするだけ
- 画像追加: `assets/` に配置 → `game.dev.html` の `ASSETS` に1行 →
  立ち絵なら `SCENE_PRESENTATION` にシーン接頭辞を1行

## 自動テスト（E2E）

ヘッドレスブラウザで実際にゲームを起動・プレイして検証します。

```
cd test
npm install            # 初回のみ（Chromium が自動で入ります）
npm test               # 開発版を検証（約5分）
npm test -- --release  # ビルド産物 index.html を検証
```

| # | テスト | 検出できるもの |
|---|---|---|
| T1 | スモーク | 起動時のJSエラー、リソース読込失敗 |
| T2 | シナリオlint | 括弧の不整合、連続重複セリフ、空セリフ、話者名の表記ゆれ |
| T3 | 全シーン巡回 | 全シーン・全ビートを実描画し、JSエラー／テキストあふれ／画像未読込を検出 |
| T4 | 通しプレイ×4戦略 | 各戦略でエンディングまで自動プレイし、想定どおりの診断・判定に到達するか |
| T5 | UI機能 | バックログ表示、オートモード進行 |

結果は `test/report/report.md` と `test/report/screenshots/`
（全選択肢＋全エンディングのスクショ）に出力されます。


## 公開（ホスティング）

**リポジトリはprivateのまま**、ビルド産物だけを公開する構成です。
公開ディレクトリには必ず `public/` を指定してください
（ルートを指定すると scenario.js や docs/ まで配信されてしまいます）。

### Cloudflare Pages（推奨・無料）
1. https://pages.cloudflare.com にGitHubアカウントで登録
2. 「Create a project」→「Connect to Git」→ このリポジトリ（private可）を選択
3. Build settings:
   - Framework preset: **None**
   - Build command: （空欄）
   - Build output directory: **public**
4. Deploy。以後は `python build.py` → `git push` するだけで自動公開

### Netlify（同等・無料）
- リポジトリ連携時に Publish directory へ **public** を指定
- もっと手軽に済ませるなら Netlify Drop（https://app.netlify.com/drop）に
  `public/` フォルダをドラッグ&ドロップするだけでも公開できます（連携不要）

### 公開URL確定後
`game.dev.html` 内の `REPLACE-WITH-YOUR-URL`（og:url / og:image の2箇所）を
実URLに書き換えて再ビルドしてください。

## 注意

- `public/` は生成物です。直接編集せず、`scenario.js` /
  `game.dev.html` を修正して `build.py` で再生成してください。
- OGPの `og:url` / `og:image` は公開URL確定後に書き換えてください
  （`game.dev.html` 内の `REPLACE-WITH-YOUR-URL` を検索）。
