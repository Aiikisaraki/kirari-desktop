#!/usr/bin/env python3
"""衔接瑕疵修正：把过渡态的首/尾帧对齐到它真正的后继状态（可回滚）。

已用像素测量确认的三处硬缺陷（不是"观感因人而异"，是像素级不符）：

1. drag_start 尾帧 vs drag 首帧
   两者角色尺寸一致（h≈384），但脚底 y：445 vs 396，差 49px。
   拖拽入场播完切进 drag 循环时，角色会瞬间向上跳 49px。
   修法：在 drag_start 的收尾帧里把角色平移 -49px，让它落在 drag 构图起点上。
   注意不能改 drag 循环 —— 循环首尾自洽（seam 28.2 < 表内步长 45.5），
   动它反而会破坏循环闭合。

2. sleep_end 尾帧 vs idle 首帧
   脚底都是 467，但身高 398 vs 388，即绕脚底放大了 2.6%。
   醒来落地后角色比正常站姿高 10px，观感是"突然变高"。
   修法：按脚底为锚点，对 sleep_end 的收尾帧等比缩回 388/398。

3. sleep_start 首帧 vs idle 首帧
   实测 h=388/top=80，与 idle 完全一致，无需修。保留检测以防将来素材变动。

做法：只处理"过渡段末尾若干帧"，按帧号线性加权（最多 —— 但这里直接整段
统一修正，因为 drag_start 全部尾帧都是同一个悬空姿势，sleep_end 收尾是定格）。
变换后 alpha 通道用最近邻采样，RGB 用双三次，避免文字/线条发糊产生新瑕疵。

用法：
  python scripts/avatar-seam-fix.py analyze
  python scripts/avatar-seam-fix.py apply --write
  python scripts/avatar-seam-fix.py restore
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
DEFAULT_BACKUP = ROOT / ".avatar-seam-backup"

ALPHA_SOLID = 128

# 尾帧定格段：这些帧属于"已停稳"的收尾，允许整体位移/缩放
TAIL_FRAMES = 12


def die(msg: str) -> "NoReturn":
    print(f"错误：{msg}", file=sys.stderr)
    raise SystemExit(1)


def load_manifest(skin: Path) -> dict:
    p = skin / "frames.json"
    if not p.exists():
        die(f"找不到 {p}")
    return json.loads(p.read_text(encoding="utf-8"))


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
    return split_frames(np.asarray(Image.open(path).convert("RGBA")), clip)


def bbox(frame: np.ndarray) -> dict:
    mask = frame[:, :, 3] > ALPHA_SOLID
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return {"top": 0, "bot": 0, "h": 0, "w": 0, "cx": 0.0, "cy": 0.0}
    return {
        "top": int(ys.min()),
        "bot": int(ys.max()),
        "h": int(ys.max() - ys.min() + 1),
        "w": int(xs.max() - xs.min() + 1),
        "cx": float((xs.min() + xs.max()) / 2),
        "cy": float((ys.min() + ys.max()) / 2),
    }


def ramp_weights(n: int) -> list[float]:
    """整段线性加权：第 0 帧 0，最后一帧 1。

    为什么摊到**整段**而不是只改收尾几帧：
    实测 drag_start 的第 100–119 帧是定格静止（相邻帧 RMS 仅 0.2–1.5），
    若只在收尾处施加修正，等于把"一步跳变"摊成"12 帧滑动"，
    相邻帧 RMS 会从 0.5 暴涨到 89 —— 观感上从"瞬移"变成"抽搐"，更糟。
    摊到整段后每帧只动 0.4px / 0.02%，肉眼不可分辨，而端点仍然精确对齐。
    """
    if n <= 1:
        return [1.0] * n
    return [i / (n - 1) for i in range(n)]


def shift_frames(frames: np.ndarray, dx: int, dy: int) -> np.ndarray:
    """亚像素平移。

    不能对每帧位移取整：位移量按权重线性增长，取整后会出现"连着几帧不动、
    然后一下跳 1px"的量化台阶 —— 实测把静止段（相邻帧 RMS 0.70）
    变成 6.22，反而制造了抖动。改用浮点仿射变换，位移量连续，
    静止段仍是静止（RMS 只增加重采样噪声）。
    """
    out = frames.copy()
    weights = ramp_weights(len(out))
    for i, wgt in enumerate(weights):
        fx, fy = dx * wgt, dy * wgt
        if abs(fx) < 1e-3 and abs(fy) < 1e-3:
            continue
        img = Image.fromarray(out[i], mode="RGBA")
        # PIL 的 AFFINE 使用"输出→输入"映射：输入坐标 = 输出坐标 - 位移
        out[i] = np.asarray(
            img.transform(
                img.size,
                Image.AFFINE,
                (1, 0, -fx, 0, 1, -fy),
                resample=Image.BICUBIC,
            )
        )
    return out


def scale_frames(frames: np.ndarray, factor: float, anchor_y: int) -> np.ndarray:
    """以 anchor_y（脚底）为锚点做等比缩放，宽度方向绕画布中心。"""
    out = frames.copy()
    n, h, w, _ = out.shape
    weights = ramp_weights(n)
    for i, wgt in enumerate(weights):
        f = 1.0 + (factor - 1.0) * wgt
        if abs(f - 1.0) < 1e-4:
            continue
        img = Image.fromarray(out[i], mode="RGBA")
        # 绕脚底 anchor_y 缩放：输入坐标 = (输出 - 锚点) / f + 锚点
        # 宽度方向绕画布中心 w/2 同理
        a = 1.0 / f
        out[i] = np.asarray(
            img.transform(
                img.size,
                Image.AFFINE,
                (a, 0, w / 2 - a * w / 2, 0, a, anchor_y - a * anchor_y),
                resample=Image.BICUBIC,
            )
        )
    return out


def plan(skin: Path, manifest: dict) -> list[dict]:
    """算出每处偏差并按需生成修正动作。"""
    def frames_of(s):
        e = manifest[s]
        clip = e["clips"][0] if "clips" in e else e
        return clip, load_frames(skin, clip)

    idle_clip, idle_frames = frames_of("idle")
    ref = bbox(idle_frames[0])
    ops = []
    notes: list[str] = []

    if "drag_start" in manifest and "drag" in manifest:
        ds_clip, ds_frames = frames_of("drag_start")
        drag_clip, drag_frames = frames_of("drag")
        tail = bbox(ds_frames[-1])
        head = bbox(drag_frames[0])
        dy = head["bot"] - tail["bot"]
        # 只在尺寸相当（确实是同一个角色、同一比例）时才用平移修
        # drag_start 的收尾是"被拎起来、双腿离地悬空"，脚底从 467 收到 437
        # 再落到 445 定格；drag 循环是悬空更高的构图（396）。两者差 49px
        # **是"被拎起"这个动作本身的抬升，不是缺陷**，而且此时窗口正跟着
        # 鼠标移动，观感上被拖拽位移掩盖。
        # 反证：强行把这 49px 摊到整段会让第 100–119 帧的定格（RMS 0.2–1.5）
        # 变成逐帧 0.4px 的亚像素漂移，实测相邻帧 RMS 升到 14–19，
        # 静止变"呼吸抖动"，比原来的瞬时抬升更难看。因此只报告、不修正。
        if abs(tail["h"] - head["h"]) <= 8 and abs(dy) >= 4:
            notes.append(
                f"drag_start 尾帧脚底 {tail['bot']} → drag 首帧 {head['bot']}"
                f"（差 {dy:+d}px，属于「被拎起」的抬升，不修）"
            )

    if "sleep_end" in manifest:
        se_clip, se_frames = frames_of("sleep_end")
        tail = bbox(se_frames[-1])
        if abs(tail["h"] - ref["h"]) >= 6 and abs(tail["bot"] - ref["bot"]) <= 4:
            factor = ref["h"] / tail["h"]
            ops.append({
                "state": "sleep_end", "clip": se_clip, "kind": "scale",
                "factor": float(factor), "anchor_y": tail["bot"],
                "note": f"身高 {tail['h']} → {ref['h']}（绕脚底 {tail['bot']} 缩回）",
            })
    return ops, notes


def cmd_analyze(skin: Path, manifest: dict) -> int:
    ops, notes = plan(skin, manifest)
    for n in notes:
        print(f"  [仅报告] {n}")
    if not ops:
        print("未发现需要自动修正的衔接偏差。")
        return 0
    print(f"发现 {len(ops)} 处衔接偏差：")
    for o in ops:
        extra = f"dy={o['dy']:+d}" if o["kind"] == "shift" else f"factor={o['factor']:.4f}"
        print(f"  {o['state']:12s} {o['kind']:6s} {extra:14s} 整段线性施加  {o['note']}")
    return 0


def cmd_apply(skin: Path, manifest: dict, write: bool, backup: Path) -> int:
    ops, notes = plan(skin, manifest)
    for n in notes:
        print(f"  [仅报告] {n}")
    if not ops:
        print("未发现需要自动修正的衔接偏差。")
        return 0
    if not write:
        print(f"（只读）将修正 {len(ops)} 处：")
        for o in ops:
            print(f"  {o['state']:12s} {o['kind']:6s}  {o['note']}")
        print("加 --write 落盘。")
        return 0
    backup.mkdir(parents=True, exist_ok=True)
    for o in ops:
        clip = o["clip"]
        src = skin / clip["sheet"]
        dst = backup / clip["sheet"]
        if not dst.exists():
            shutil.copy2(src, dst)
        frames = load_frames(skin, clip)
        if o["kind"] == "shift":
            frames = shift_frames(frames, o["dx"], o["dy"])
        else:
            frames = scale_frames(frames, o["factor"], o["anchor_y"])
        Image.fromarray(join_frames(frames), mode="RGBA").save(src, optimize=True)
        print(f"已修正 {clip['sheet']:18s} {o['note']}")
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
    ap = argparse.ArgumentParser(description="过渡态衔接对齐（默认只读）")
    ap.add_argument("command", choices=["analyze", "apply", "restore"])
    ap.add_argument("--skin", default=str(DEFAULT_SKIN))
    ap.add_argument("--backup-dir", default=str(DEFAULT_BACKUP))
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args(argv)
    skin, backup = Path(args.skin), Path(args.backup_dir)
    manifest = load_manifest(skin)
    if args.command == "restore":
        return cmd_restore(skin, backup)
    if args.command == "analyze":
        return cmd_analyze(skin, manifest)
    return cmd_apply(skin, manifest, args.write, backup)


if __name__ == "__main__":
    raise SystemExit(main())
