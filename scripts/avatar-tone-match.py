#!/usr/bin/env python3
"""精灵表色差校正：整表白点对齐 + 逐帧闪烁平滑（可回滚）。

背景：22 个状态分批由 AI 生成再抠像入库，两处色差互不相同：

1. **整表偏色** —— 某批的曝光/白平衡和锚图不一致。切状态瞬间整体变色。
   实测只有少数表超出正常范围（sleep_start 偏亮、sleep_end 偏暗、drag_start 品红），
   其余在 ±3 级内，属正常批次噪声，不该硬拉平。

2. **表内逐帧闪烁** —— 同一段动画里每帧白点抖动，观感是"很多帧颜色不一样"。
   实测 excited 相邻帧白点跳 10.7 级、sleep_start 9.7 级、happy 6.7 级，
   而 idle 只有 1.3 级。这才是用户说的"很多帧"的主因。

处理策略
--------
用「白衬衫」作为天然灰卡：取每帧低饱和高亮像素的中位数作为该帧白点。
（角色是白衬衫+深色裙，白衬衫面积大、跨姿势稳定，比整像素分位数可靠得多。）

- 整表项：把整表白点中位数拉到锚图白点 → 修跨状态偏色。
- 逐帧项：把每帧白点向「整表中位数」平滑，用中值滤波保护真实的
  光照渐变（如入眠过程逐渐变暗），只削掉单帧抖动。

约束
----
- 只改 RGB，alpha 原样保留（抠像结果不能被动）。
- 每帧增益夹在 ±8%，不会把刻意的情绪色（腮红、生气泛红）抹平。
- 默认只读，--write 才落盘，落盘前把原图复制到 .avatar-backup/。

用法：
  python scripts/avatar-tone-match.py analyze
  python scripts/avatar-tone-match.py analyze --only sleep_end drag_start
  python scripts/avatar-tone-match.py apply --write
  python scripts/avatar-tone-match.py restore
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SKIN = ROOT / "resources" / "official-avatars" / "kirari"
DEFAULT_BACKUP = ROOT / ".avatar-backup"

ANCHOR_STATE = "idle"

# 白衬衫检测：低饱和 + 高亮度 + 不太暗，跨姿势稳定
WHITE_MIN_VALUE = 190.0
WHITE_MIN_MIN = 150.0
WHITE_MAX_SAT = 0.09
WHITE_MIN_PIXELS = 200

# 逐帧平滑：中值窗口取奇数帧，窗口外保持原值（保护真实渐变）
FLICKER_WINDOW = 5
# 单帧增益上限：足够压掉闪烁，又不会扭曲刻意的情绪色
MAX_FRAME_GAIN = 0.08
# 整表对齐的最大增益（超过说明是生成事故，不该靠调色硬凑）
MAX_SHEET_GAIN = 0.13

# 超过该值才认为整表偏色「值得修」，避免把正常批次噪声也拉平
SHEET_DELTA_TRIGGER = 6.0


def die(msg: str) -> "NoReturn":
    print(f"错误：{msg}", file=sys.stderr)
    raise SystemExit(1)


def load_manifest(skin: Path) -> dict:
    p = skin / "frames.json"
    if not p.exists():
        die(f"找不到 {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def clips_of(entry: dict) -> list[dict]:
    if "clips" in entry:
        return list(entry["clips"])
    return [entry]


def state_names(manifest: dict) -> list[str]:
    return [
        k
        for k, v in manifest.items()
        if isinstance(v, dict) and clips_of(v) and clips_of(v)[0].get("sheet")
    ]


def split_frames(arr: np.ndarray, clip: dict) -> np.ndarray:
    w, h, n = int(clip["frameW"]), int(clip["frameH"]), int(clip["frames"])
    return arr.reshape(h, w * n, 4).reshape(h, n, w, 4).transpose(1, 0, 2, 3)


def join_frames(frames: np.ndarray) -> np.ndarray:
    n, h, w, _ = frames.shape
    return frames.transpose(1, 0, 2, 3).reshape(h, n * w, 4)


def load_frames(skin: Path, clip: dict) -> np.ndarray:
    path = skin / clip["sheet"]
    if not path.exists():
        die(f"找不到精灵表 {path}")
    arr = np.asarray(Image.open(path).convert("RGBA"))
    return split_frames(arr, clip)


def white_point(frame: np.ndarray) -> np.ndarray | None:
    """该帧白衬衫像素的中位 RGB；样本不足返回 None。"""
    mask = frame[:, :, 3] > 250
    rgb = frame[:, :, :3]
    if mask.sum() < WHITE_MIN_PIXELS:
        return None
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1.0)
    sel = mask & (mx > WHITE_MIN_VALUE) & (sat < WHITE_MAX_SAT) & (mn > WHITE_MIN_MIN)
    if sel.sum() < WHITE_MIN_PIXELS:
        return None
    return np.median(rgb[sel], axis=0).astype(np.float32)


def white_series(frames: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """返回 (有效帧索引, 对应白点)，形状 (n,) 与 (n,3)。"""
    idx, pts = [], []
    for i, f in enumerate(frames):
        w = white_point(f)
        if w is not None:
            idx.append(i)
            pts.append(w)
    if not pts:
        return np.zeros(0, dtype=int), np.zeros((0, 3), dtype=np.float32)
    return np.array(idx), np.stack(pts)


def smooth_white(pts: np.ndarray, window: int = FLICKER_WINDOW) -> np.ndarray:
    """对白点序列做中值滤波。中值只吃离群单帧，保留连续渐变。"""
    n = len(pts)
    if n < 3 or window <= 1:
        return pts.copy()
    half = window // 2
    out = pts.copy()
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        out[i] = np.median(pts[lo:hi], axis=0)
    return out


def apply_gain(frames: np.ndarray, gains: dict[int, np.ndarray]) -> np.ndarray:
    out = frames.copy()
    for i, gain in gains.items():
        if i >= len(out):
            continue
        px = out[i]
        solid = px[:, :, 3] > 0
        for c in range(3):
            ch = px[:, :, c]
            ch[solid] = np.clip(ch[solid] * float(gain[c]), 0, 255)
            px[:, :, c] = ch
    return out


def analyse_state(frames: np.ndarray, anchor_white: np.ndarray) -> dict:
    idx, pts = white_series(frames)
    if not len(idx):
        return {"valid": False}
    sheet_med = np.median(pts, axis=0)
    smooth = smooth_white(pts)
    residual = np.abs(pts - sheet_med).max(axis=1)
    smooth_residual = np.abs(smooth - sheet_med).max(axis=1)
    return {
        "valid": True,
        "idx": idx,
        "pts": pts,
        "sheet_med": sheet_med,
        "smooth": smooth,
        "delta_anchor": sheet_med - anchor_white,
        "jump_before": float(np.abs(np.diff(pts.mean(axis=1))).max()) if len(pts) > 1 else 0.0,
        "jump_after": float(np.abs(np.diff(smooth.mean(axis=1))).max()) if len(pts) > 1 else 0.0,
        "std_before": float(pts.mean(axis=1).std()),
        "std_after": float(smooth.mean(axis=1).std()),
        "flicker_before": float(residual.max()),
        "flicker_after": float(smooth_residual.max()),
    }


def cmd_analyze(skin: Path, manifest: dict, only: list[str] | None) -> int:
    states = state_names(manifest)
    if ANCHOR_STATE not in states:
        die(f"锚状态 {ANCHOR_STATE} 缺失")
    anchor = analyse_state(load_frames(skin, clips_of(manifest[ANCHOR_STATE])[0]), np.zeros(3))
    if not anchor["valid"]:
        die("锚图取不到白点样本")
    anchor_white = anchor["sheet_med"]
    print(f"锚 {ANCHOR_STATE} 白点 = {anchor_white.round(1)}")
    print()
    print(f"{'state':13s} {'Δ锚(整表)':>22s} {'整表增益':>20s} {'抖动前':>7s} {'抖动后':>7s} {'标准差':>11s}")
    print("-" * 88)
    for s in states:
        if s == ANCHOR_STATE or (only and s not in only):
            continue
        r = analyse_state(load_frames(skin, clips_of(manifest[s])[0]), anchor_white)
        if not r["valid"]:
            print(f"{s:13s} 跳过（白衬衫样本不足）")
            continue
        delta = r["delta_anchor"]
        gain = np.median(r["pts"], axis=0) / np.maximum(anchor_white, 1)
        sheet_fix = np.max(np.abs(delta)) >= SHEET_DELTA_TRIGGER
        flag = "  ← 需整表校正" if sheet_fix else ""
        print(
            f"{s:13s} {str(delta.round(1)):>22s} "
            f"{str(np.round(gain, 3)):>20s} "
            f"{r['flicker_before']:7.1f} {r['flicker_after']:7.1f} "
            f"{r['std_before']:5.2f}→{r['std_after']:4.2f}{flag}"
        )
    return 0


def build_gains(r: dict, anchor_white: np.ndarray, fix_sheet: bool) -> dict[int, np.ndarray]:
    """算出每帧增益：整表对齐 × 逐帧平滑，逐帧增益夹在 MAX_FRAME_GAIN 内。"""
    idx, pts, smooth = r["idx"], r["pts"], r["smooth"]
    sheet_med = r["sheet_med"]
    gains: dict[int, np.ndarray] = {}
    # 整表项：只在超阈值时启用，且增益夹取
    sheet_gain = np.ones(3, dtype=np.float32)
    if fix_sheet:
        sheet_gain = np.clip(
            anchor_white / np.maximum(sheet_med, 1.0), 1 - MAX_SHEET_GAIN, 1 + MAX_SHEET_GAIN
        )
    for i, raw, sm in zip(idx, pts, smooth):
        # 逐帧项：把该帧白点拉向平滑后的值（如果整表不用校正，基准就是平滑值）
        target = sm * sheet_gain
        frame_gain = np.clip(
            target / np.maximum(raw, 1.0), 1 - MAX_FRAME_GAIN, 1 + MAX_FRAME_GAIN
        )
        gains[int(i)] = frame_gain.astype(np.float32)
    return gains


def iter_sheets(skin: Path, manifest: dict, only: list[str] | None):
    for s in state_names(manifest):
        if s == ANCHOR_STATE or (only and s not in only):
            continue
        for clip in clips_of(manifest[s]):
            yield s, clip, skin / clip["sheet"]


def cmd_apply(skin: Path, manifest: dict, only: list[str] | None, write: bool, backup: Path) -> int:
    anchor = analyse_state(load_frames(skin, clips_of(manifest[ANCHOR_STATE])[0]), np.zeros(3))
    anchor_white = anchor["sheet_med"]
    todo = []
    for s, clip, src in iter_sheets(skin, manifest, only):
        frames = load_frames(skin, clip)
        r = analyse_state(frames, anchor_white)
        if not r["valid"]:
            print(f"跳过 {clip['sheet']}（白衬衫样本不足）")
            continue
        fix_sheet = np.max(np.abs(r["delta_anchor"])) >= SHEET_DELTA_TRIGGER
        gains = build_gains(r, anchor_white, fix_sheet)
        todo.append((s, clip, src, frames, gains, fix_sheet, r))
    if not todo:
        print("没有可处理的状态。")
        return 0
    if not write:
        print(f"（只读）将处理 {len(todo)} 张精灵表：")
        for s, clip, src, frames, gains, fix_sheet, r in todo:
            tag = "整表+逐帧" if fix_sheet else "仅逐帧"
            print(
                f"  {s:13s} {clip['sheet']:22s} {tag}  "
                f"抖动 {r['flicker_before']:.1f}→{r['flicker_after']:.1f}"
            )
        print("加 --write 落盘。")
        return 0
    backup.mkdir(parents=True, exist_ok=True)
    for s, clip, src, frames, gains, fix_sheet, r in todo:
        dst = backup / clip["sheet"]
        if not dst.exists():
            shutil.copy2(src, dst)
        out = apply_gain(frames, gains)
        Image.fromarray(join_frames(out), mode="RGBA").save(src, optimize=True)
        tag = "整表+逐帧" if fix_sheet else "仅逐帧"
        print(
            f"已校正 {clip['sheet']:22s} {tag}  "
            f"抖动 {r['flicker_before']:.1f}→{r['flicker_after']:.1f}"
        )
    print(f"\n原图备份：{backup}（用 restore 还原）")
    return 0


def cmd_restore(skin: Path, backup: Path) -> int:
    if not backup.exists():
        die(f"没有备份目录 {backup}")
    n = 0
    for src in backup.glob("*.png"):
        shutil.copy2(src, skin / src.name)
        n += 1
    print(f"已还原 {n} 张精灵表。")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="精灵表色差校正（默认只读）")
    ap.add_argument("command", choices=["analyze", "apply", "restore"])
    ap.add_argument("--skin", default=str(DEFAULT_SKIN))
    ap.add_argument("--backup-dir", default=str(DEFAULT_BACKUP))
    ap.add_argument("--only", nargs="*", default=None, help="只处理指定状态")
    ap.add_argument("--write", action="store_true", help="真正写盘（apply）")
    args = ap.parse_args(argv)
    skin, backup = Path(args.skin), Path(args.backup_dir)
    manifest = load_manifest(skin)
    if args.command == "restore":
        return cmd_restore(skin, backup)
    if args.command == "analyze":
        return cmd_analyze(skin, manifest, args.only)
    return cmd_apply(skin, manifest, args.only, args.write, backup)


if __name__ == "__main__":
    raise SystemExit(main())
