#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
シナリオ検証スクリプト

  python3 validate.py

scenario.js を解析して以下をチェックします：
  1. リンク切れ（next / choices.next が存在しないシーンを指していないか）
  2. 到達不能シーン（どこからも辿り着けないシーン）
  3. 行き止まり（next も choices もない非endシーン）
  4. 選択肢タイプの妥当性（normal / weird / crazy 以外がないか）
  5. 全ルートのスコア解析（4診断タイプ・3リスク判定すべてに到達可能か）
  6. 1プレイの通過シーン数（進捗バー定数 EXPECTED_PATH との乖離を警告）

セリフ・シーン・選択肢を追加したら、ビルド前にこれを回してください。
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
SCORE_MAP = {"normal": (2, 2), "weird": (1, 0), "crazy": (0, 0)}


def load_game():
    src = (HERE / "scenario.js").read_text(encoding="utf-8")
    s = src.index("const GAME = ") + len("const GAME = ")
    e = src.rindex("};") + 1
    body = src[s:e]
    # トップレベルの start: / scenes: のみ非クォートなので補正してJSONとして厳密に読む
    body = re.sub(r"^(\s*)(start|scenes):", r'\1"\2":', body, flags=re.M)
    try:
        return json.loads(body)
    except json.JSONDecodeError as ex:
        line = body.splitlines()[ex.lineno - 1] if ex.lineno <= len(body.splitlines()) else ""
        sys.exit(
            f"✘ scenario.js がJSONとして読めません: {ex.msg} (scenario.js内 概ね{ex.lineno}行目付近)\n"
            f"  該当行: {line.strip()[:80]}\n"
            f"  ※ カンマの過不足・閉じ括弧・引用符の閉じ忘れをご確認ください"
        )


def load_listening_bonus():
    src = (HERE / "game.dev.html").read_text(encoding="utf-8")
    m = re.search(r"const LISTENING_BONUS = \{(.*?)\};", src, re.S)
    bonus = {}
    if m:
        for k, v in re.findall(r"(\w+):\s*(\d+)", m.group(1)):
            bonus[k] = int(v)
    return bonus


def main():
    game = load_game()
    scenes = game["scenes"]
    bonus = load_listening_bonus()
    errors, warns = [], []

    # 1. リンク切れ / 3. 行き止まり / 4. 選択肢タイプ
    for sid, sc in scenes.items():
        if sc.get("next") and sc["next"] not in scenes:
            errors.append(f"リンク切れ: {sid} → next「{sc['next']}」が存在しません")
        for c in sc.get("choices", []):
            if c["next"] not in scenes:
                errors.append(f"リンク切れ: {sid} の選択肢「{c['label'][:20]}…」→「{c['next']}」が存在しません")
            if c.get("type") not in SCORE_MAP:
                errors.append(f"選択肢タイプ不正: {sid} の「{c['label'][:20]}…」type={c.get('type')}")
        if sc.get("type") != "end" and not sc.get("next") and not sc.get("choices"):
            errors.append(f"行き止まり: {sid}（next も choices もありません）")

    # LISTENING_BONUS のキー存在チェック
    for k in bonus:
        if k not in scenes:
            warns.append(f"LISTENING_BONUS のキー「{k}」に対応するシーンがありません（game.dev.html側）")

    # 2. 到達可能性
    seen = set()
    stack = [game["start"]]
    while stack:
        sid = stack.pop()
        if sid in seen or sid not in scenes:
            continue
        seen.add(sid)
        sc = scenes[sid]
        if sc.get("next"):
            stack.append(sc["next"])
        for c in sc.get("choices", []):
            stack.append(c["next"])
    unreachable = [s for s in scenes if s not in seen]
    for s in unreachable:
        warns.append(f"到達不能シーン: {s}")

    if errors:
        print("✘ エラー（ゲームが途中で止まる可能性があります）")
        for e in errors:
            print("   -", e)
        sys.exit(1)

    # 5. 全ルートのスコア解析（リンクが健全な場合のみ）
    results, path_lens = [], []

    def walk(sid, s, l, steps):
        sc = scenes.get(sid)
        if not sc or sc.get("type") == "end":
            results.append((s, l))
            path_lens.append(steps)
            return
        if sc.get("choices"):
            for c in sc["choices"]:
                ds, dl = SCORE_MAP[c["type"]]
                walk(c["next"], s + ds, l + dl + bonus.get(c["next"], 0), steps + 1)
        elif sc.get("next"):
            walk(sc["next"], s, l, steps + 1)

    walk(game["start"], 0, 0, 1)

    types = {"教科書": 0, "正論": 0, "乗っかる": 0, "フリー": 0}
    risks = {"高": 0, "中": 0, "低": 0}
    for s, l in results:
        if s > 7 and l > 7:
            types["教科書"] += 1
        elif s > 7:
            types["正論"] += 1
        elif l > 7:
            types["乗っかる"] += 1
        else:
            types["フリー"] += 1
        risks["高" if s <= 5 else ("中" if s <= 9 else "低")] += 1

    for name, cnt in {**types, **risks}.items():
        if cnt == 0:
            warns.append(f"診断・判定「{name}」に到達できるルートがありません（スコア閾値の見直しを推奨）")

    # 6. 進捗バー定数との乖離
    avg = sum(path_lens) / len(path_lens)
    src = (HERE / "game.dev.html").read_text(encoding="utf-8")
    m = re.search(r"const EXPECTED_PATH = (\d+);", src)
    expected = int(m.group(1)) if m else None
    if expected and abs(avg - expected) > 3:
        warns.append(
            f"通過シーン数の平均が {avg:.0f} に変化しています。"
            f"game.dev.html の EXPECTED_PATH（現在 {expected}）を {round(avg)} に更新推奨"
        )

    print(f"✔ リンク整合: OK（{len(scenes)}シーン / 全{len(results):,}ルート）")
    print(f"✔ 診断タイプ分布: " + " / ".join(f"{k} {v:,}" for k, v in types.items()))
    print(f"✔ リスク判定分布: " + " / ".join(f"{k} {v:,}" for k, v in risks.items()))
    print(f"✔ 通過シーン数: 最短{min(path_lens)} 〜 最長{max(path_lens)}（平均 {avg:.1f}）")
    if warns:
        print("△ 警告")
        for w in warns:
            print("   -", w)
    else:
        print("✔ 警告なし")


if __name__ == "__main__":
    main()
