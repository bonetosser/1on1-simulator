#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
1on1練習シミュレーター ビルドスクリプト

  game.dev.html + scenario.js + assets/*
    → index.html（配布用・単一ファイル）を生成します。

使い方:
  python3 build.py

日々の開発サイクル:
  1. scenario.js のテキストを編集して保存
  2. ブラウザで game.dev.html?scene=シーンID を開く（F5で再読込）
     ※ 分割構成のまま動くので、ビルド不要で即確認できます
  3. 仕上がったら python3 validate.py で整合チェック
  4. python3 build.py で index.html を再生成して配布

画像の差し替え・追加:
  - 差し替え: assets/ 内の同名ファイルを上書きするだけ
  - 追加:     assets/ にファイルを置き、game.dev.html の ASSETS に
              `キー名: "assets/ファイル名"` の行を足す（webp/png/jpg対応）
"""
import base64
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "public" / "index.html"
MIME = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}


def main():
    # 0) ビルド前にシナリオ検証を実行（エラーがあれば中断）
    r = subprocess.run([sys.executable, str(HERE / "validate.py")])
    if r.returncode != 0:
        sys.exit("✘ 検証エラーのためビルドを中断しました（--force で強行できます）") \
            if "--force" not in sys.argv else print("△ 検証エラーを無視して続行します")

    dev = (HERE / "game.dev.html").read_text(encoding="utf-8")
    scenario = (HERE / "scenario.js").read_text(encoding="utf-8")

    # 1) scenario.js の読み込みタグを除去し、マーカー位置へ本文を注入
    tag = '<script src="scenario.js"></script>\n'
    assert dev.count(tag) == 1, "scenario.js の読み込みタグが見つかりません"
    dev = dev.replace(tag, "")
    marker = "// @SCENARIO_INLINE@"
    assert dev.count(marker) == 1, "インライン化マーカーが見つかりません"
    dev = dev.replace(marker, scenario)

    # 2) ASSETS の外部参照をすべて base64 でインライン化（件数・形式は動的）
    refs = re.findall(r'\w+: "assets/([\w.\-]+)"', dev)
    missing_files = [f for f in refs if not (HERE / "assets" / f).exists()]
    if missing_files:
        sys.exit(f"✘ assets/ に存在しないファイルが参照されています: {missing_files}")

    def inline_img(m):
        fname = m.group(2)
        ext = Path(fname).suffix.lower()
        if ext not in MIME:
            sys.exit(f"✘ 未対応の画像形式です: {fname}（webp/png/jpg のみ）")
        data = (HERE / "assets" / fname).read_bytes()
        return f'{m.group(1)}: "data:{MIME[ext]};base64,{base64.b64encode(data).decode()}"'

    dev, n = re.subn(r'(\w+): "assets/([\w.\-]+)"', inline_img, dev)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(dev, encoding="utf-8")
    # OGP画像も公開ディレクトリへ同梱
    og = HERE / "og.png"
    if og.exists():
        (OUT.parent / "og.png").write_bytes(og.read_bytes())
    # 404ページも同梱（存在するとPagesのindex.htmlフォールバックが無効になり、正しい404が返る）
    p404 = HERE / "404.html"
    if p404.exists():
        (OUT.parent / "404.html").write_bytes(p404.read_bytes())
    print(f"✔ public/index.html を生成しました（{OUT.stat().st_size // 1024}KB / 画像{n}件インライン / og.png同梱）")
    unused = [p.name for p in (HERE / "assets").iterdir() if p.name not in refs]
    if unused:
        print(f"  参考: ASSETS未登録のファイルがassets/にあります: {unused}")
    print("  ブラウザで index.html を開いて最終確認してください。")


if __name__ == "__main__":
    main()
