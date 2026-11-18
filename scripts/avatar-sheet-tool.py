#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""avatar-sheet-tool.py —— 桌宠精灵表的体检 / 重剪 / 质检 / 入库工具。

设计前提
--------
1. **默认只读**。不加 --write 一个字节都不写；加 --write 先整目录备份再动。
2. **数据驱动**。所有时长、裁剪帧号都在 scripts/avatar-spec.json 里，改节奏不改脚本。
3. **不猜语义**。"这个动作演到第几帧" 必须人眼确认后写进 spec，脚本只负责执行。
   自动差异曲线不可靠：blink 的自动"活动区间"是 f3~f74（等于全片），因为站立微漂也产生差异。

五条命令
--------
    analyze                       体检：每状态帧数/fps/时长/首尾锚定/活动区间/占位
    plan                          预演：如果 --write 会改成什么样（前后对照），不写盘
    apply --write                 落盘：备份 → 重剪 PNG → 回写 frames.json → 自动 verify
    verify                        质检：硬失败退出码 1，可挂 CI
    restore <备份目录>             整目录还原到某次备份
    pack --from DIR --state NAME  入库：按锚图身高统一缩放 + 脚底对齐 + 切末尾静止帧 + 拼表 + 登记

依赖：Python 3.8+ / Pillow / numpy。本机 python 可能指向没有 Pillow 的解释器，
WorkBuddy 环境用 C:/Users/Aki/.workbuddy/binaries/python/envs/default/Scripts/python。

关于 pad（过渡帧）
------------------
scripts/build-transition-frames.cjs（2026-10-11）给 9 个动作各插了 4 帧入场 + 4 帧退场
过渡（bow/excited/nod/sad/shake/shy/stretch/surprised/thinking），所以这三张表比原始
动作多 8 帧。**这 8 帧是为了消除硬切闪入，不是动作本体**：算 fps 时必须扣掉，
否则整段动作会被多提快 16%。spec 里用 `pad` 显式标注，不靠脚本猜。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SKIN = "resources/official-avatars/kirari"
DEFAULT_SPEC = "scripts/avatar-spec.json"
BACKUP_ROOT = ".avatar-backup"

# fps 上限：rAF 是 60fps，再高就会出现"一帧内跳过多帧"的丢帧感。
FPS_MAX = 60.0
FPS_MIN = 1.0

# 判定"实心"的 alpha 阈值，与渲染端逐像素点穿的 hitTest 保持一致（>=16 视为实心）。
ALPHA_SOLID = 16

# 非状态键（皮肤元信息），analyze/verify 要跳过。
RESERVED_KEYS = {"type", "name", "author", "version", "chatAvatar", "personality", "pool"}


# ──────────────────────────── 基础工具 ────────────────────────────


def die(msg: str, code: int = 2):
    """显式失败。不静默、不兜底 —— 让人一眼看出是哪一步不满足前提。"""
    print(f"\n[错误] {msg}", file=sys.stderr)
    sys.exit(code)


def load_json(path: Path) -> dict:
    if not path.exists():
        die(f"找不到文件：{path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"{path} 不是合法 JSON：{e}")


def save_json(path: Path, obj: dict):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def bump_version(v) -> str:
    """frames.json 每次落盘 patch +1。解析不了就原样返回，不编造版本号。"""
    try:
        parts = str(v).split(".")
        parts[-1] = str(int(parts[-1]) + 1)
        return ".".join(parts)
    except (ValueError, IndexError):
        return str(v)


def open_sheet(path: Path) -> Image.Image:
    if not path.exists():
        die(f"找不到精灵表：{path}")
    return Image.open(path).convert("RGBA")


def crop_frame(sheet: Image.Image, i: int, fw: int, fh: int) -> Image.Image:
    return sheet.crop((i * fw, 0, (i + 1) * fw, fh))


def is_state_def(v) -> bool:
    """frames.json 里只有状态项才有 sheet 或 clips；其余是元信息。"""
    return isinstance(v, dict) and ("sheet" in v or "clips" in v)


def norm_clips(state: str, defn: dict, fw_default=(360, 480)) -> list[dict]:
    """把旧扁平格式与 v2 clips 统一成 [{sheet,frameW,frameH,frames,fps,loop,weight}]。"""
    loop = defn.get("loop") is True
    if isinstance(defn.get("clips"), list) and defn["clips"]:
        out = []
        for c in defn["clips"]:
            out.append(
                {
                    "sheet": str(c.get("sheet", "")),
                    "frameW": int(c.get("frameW") or fw_default[0]),
                    "frameH": int(c.get("frameH") or fw_default[1]),
                    "frames": int(c.get("frames") or 0),
                    "fps": float(c.get("fps") or 0),
                    "weight": c.get("weight"),
                    "rate": c.get("rate"),
                    "loop": loop,
                }
            )
        return out
    if isinstance(defn.get("sheet"), str):
        return [
            {
                "sheet": defn["sheet"],
                "frameW": int(defn.get("frameW") or fw_default[0]),
                "frameH": int(defn.get("frameH") or fw_default[1]),
                "frames": int(defn.get("frames") or 0),
                "fps": float(defn.get("fps") or 0),
                "weight": defn.get("weight"),
                "rate": defn.get("rate"),
                "loop": loop,
            }
        ]
    return []


# ──────────────────────────── 帧度量 ────────────────────────────


def frame_metrics(img: Image.Image) -> dict:
    """一帧的全部度量：alpha 极值、包围盒、绿幕残留、灰度图（供 SSIM/RMS）。"""
    a = np.asarray(img).astype(np.int16)  # H×W×4，int16 够用且比 float 省内存
    alpha = a[..., 3]
    solid = alpha >= ALPHA_SOLID
    rows = solid.sum(axis=1)
    cols = solid.sum(axis=0)
    if not solid.any():
        return {
            "empty": True,
            "alpha_max": int(alpha.max()),
            "h": 0,
            "w": 0,
            "bottom": 0,
            "cx": 0,
            "green_ratio": 0.0,
            "gray": np.zeros(img.size[::-1], dtype=np.float32),
        }
    # 包围盒用"行列覆盖率 > 3 像素"判定，避免被零星半透明像素拉满整幅。
    ys = np.where(rows > 3)[0]
    xs = np.where(cols > 3)[0]
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1

    rgb = a[..., :3]
    # 绿度：G 明显高于 R/B 才算"近纯绿"。白/冰蓝/深蓝/黑的绿度都很低。
    greenness = rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2])
    near_green = (greenness > 40) & (rgb[..., 1] > 120)
    green_ratio = float((near_green & solid).sum()) / max(1, int(solid.sum()))

    gray = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.float32)
    return {
        "empty": False,
        "alpha_max": int(alpha.max()),
        "h": y1 - y0,
        "w": x1 - x0,
        "bottom": y1,
        "cx": (x0 + x1) / 2.0,
        "green_ratio": green_ratio,
        "gray": gray,
    }


def _box_mean(x: np.ndarray, win: int) -> np.ndarray:
    """win×win 均值滤波（积分图实现，避免依赖 scipy）。边界按 edge 填充后归一化。"""
    pad = win // 2
    xp = np.pad(x, pad, mode="edge")
    c = np.pad(xp.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    h, w = x.shape
    s = c[win : win + h, win : win + w] - c[0:h, win : win + w] - c[win : win + h, 0:w] + c[0:h, 0:w]
    return s / float(win * win)


def ssim(a: np.ndarray, b: np.ndarray, win: int = 8) -> float:
    """全局 SSIM（8×8 均匀窗）。够用来判"首尾是否回锚"，不追求论文级精度。"""
    if a.shape != b.shape:
        return 0.0
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    with np.errstate(invalid="ignore", divide="ignore"):
        mu_a, mu_b = _box_mean(a, win), _box_mean(b, win)
        va = _box_mean(a * a, win) - mu_a * mu_a
        vb = _box_mean(b * b, win) - mu_b * mu_b
        cov = _box_mean(a * b, win) - mu_a * mu_b
        num = (2 * mu_a * mu_b + c1) * (2 * cov + c2)
        den = (mu_a * mu_a + mu_b * mu_b + c1) * (va + vb + c2)
        m = num / den
    m = np.nan_to_num(m, nan=0.0, posinf=0.0, neginf=0.0)
    return float(np.clip(m.mean(), 0.0, 1.0))


def rms(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        return 999.0
    return float(np.sqrt(((a - b) ** 2).mean()))


def blend_pm(a: Image.Image, b: Image.Image, t: float) -> Image.Image:
    """按预乘 alpha 线性插值两帧。

    直接 source-over 叠加会让中间帧忽明忽暗（半透明边缘重复混合），premultiplied 插值
    能保证亮度守恒 —— 与 scripts/build-transition-frames.cjs 的做法一致。
    """
    aa = np.asarray(a).astype(np.float32)
    bb = np.asarray(b).astype(np.float32)
    a_a = aa[..., 3:4] / 255.0
    b_a = bb[..., 3:4] / 255.0
    out_a = a_a * (1 - t) + b_a * t
    num = aa[..., :3] * a_a * (1 - t) + bb[..., :3] * b_a * t
    out_rgb = np.where(out_a > 1e-6, num / np.maximum(out_a, 1e-6), 0.0)
    out = np.concatenate([out_rgb, out_a * 255.0], axis=2)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


# ──────────────────────────── 上下文装配 ────────────────────────────


class Ctx:
    def __init__(self, skin: Path, spec: dict):
        self.skin = skin
        self.spec = spec
        self.backup_root = REPO_ROOT / BACKUP_ROOT  # 可用 --backup-dir 覆盖
        self.manifest_path = skin / "frames.json"
        self.manifest = load_json(self.manifest_path)
        t = spec.get("targets", {})
        self.height_tol = float(t.get("heightTolerance", 0.08))
        self.bottom_tol = float(t.get("bottomTolerance", 4))
        self.ssim_th = float(t.get("ssim", 0.95))
        self.jump_rms = float(t.get("jumpRms", 40))
        self.green_th = float(t.get("greenRatio", 0.01))
        self.max_width = int(t.get("maxWidth", 330))
        self.static_rms = float(t.get("staticRms", 4.0))
        self.static_min = int(t.get("staticMinFrames", 3))
        # 坐/躺/悬空姿势的身高天然比站姿矮，别拿站姿的 390px 去卡它们
        self.height_exempt = set(t.get("heightExempt", []))
        # 同理：被拎起来 / 悬空 / 坐着的姿势脚底不在同一水平面，底部对齐也无意义
        self.bottom_exempt = set(t.get("bottomExempt", []))
        self.anchor_state = spec["anchor"]["state"]
        self.anchor_frame = int(spec["anchor"].get("frame", 0))
        self._anchor = None

    def states(self) -> list[str]:
        return [k for k, v in self.manifest.items() if k not in RESERVED_KEYS and is_state_def(v)]

    def clips(self, state: str) -> list[dict]:
        return norm_clips(state, self.manifest[state])

    def anchor(self) -> dict:
        """锚图 = 某个状态的第 0 帧。所有一次性动作的首尾都应对齐它。"""
        if self._anchor is not None:
            return self._anchor
        if self.anchor_state not in self.manifest:
            die(f"锚图状态 {self.anchor_state} 不在 frames.json 里")
        clip = self.clips(self.anchor_state)[0]
        sheet = open_sheet(self.skin / clip["sheet"])
        n = sheet.size[0] // clip["frameW"]
        if not (0 <= self.anchor_frame < n):
            die(f"锚图帧号 {self.anchor_frame} 超出 {self.anchor_state} 的范围（共 {n} 帧）")
        img = crop_frame(sheet, self.anchor_frame, clip["frameW"], clip["frameH"])
        m = frame_metrics(img)
        m["img"] = img
        m["frameW"] = clip["frameW"]
        m["frameH"] = clip["frameH"]
        m["fps"] = clip["fps"]
        self._anchor = m
        return m


def resolve_skin(arg: str | None, spec: dict) -> Path:
    raw = arg or spec.get("skin") or DEFAULT_SKIN
    p = Path(raw)
    return p if p.is_absolute() else (REPO_ROOT / p)


def spec_state(spec: dict, state: str) -> dict | None:
    return spec.get("states", {}).get(state)


# ──────────────────────────── analyze ────────────────────────────


def cmd_analyze(ctx: Ctx):
    an = ctx.anchor()
    print(f"皮肤：{ctx.skin}")
    print(
        f"锚图：{ctx.anchor_state}#{ctx.anchor_frame}  高 {an['h']}px  脚底 y={an['bottom']}  "
        f"中心 x={an['cx']:.0f}  画幅 {an['frameW']}×{an['frameH']}"
    )
    print()
    hdr = (
        f"{'状态':<12}{'变体':>4}{'帧数':>6}{'实际':>6}{'fps':>7}{'时长':>8}"
        f"{'loop':>6}{'高':>6}{'脚底':>6}{'首↔锚':>7}{'尾↔锚':>7}{'活动区间':>12}"
    )
    print(hdr)
    print("-" * len(hdr))
    total_frames = 0
    for state in ctx.states():
        clips = ctx.clips(state)
        for ci, clip in enumerate(clips):
            sheet = open_sheet(ctx.skin / clip["sheet"])
            fw, fh = clip["frameW"], clip["frameH"]
            actual = sheet.size[0] // fw
            declared = clip["frames"]
            fps = clip["fps"]
            dur = (declared / fps) if fps > 0 else 0.0
            total_frames += actual

            heights, bottoms, grays = [], [], []
            for i in range(actual):
                m = frame_metrics(crop_frame(sheet, i, fw, fh))
                heights.append(m["h"])
                bottoms.append(m["bottom"])
                grays.append(m["gray"])
            if not grays:
                continue
            s_first = ssim(grays[0], an["gray"])
            s_last = ssim(grays[-1], grays[0]) if clip["loop"] else ssim(grays[-1], an["gray"])
            # 活动区间：与首帧差异 > 6 的第一帧/最后一帧。只作参考，不能当语义用。
            act = [i for i, g in enumerate(grays) if i > 0 and rms(g, grays[0]) > 6]
            act_s = f"f{act[0]}~f{act[-1]}" if act else "静止"
            label = state if ci == 0 else ""
            print(
                f"{label:<12}{('#' + str(ci)) if len(clips) > 1 else '':>4}"
                f"{declared:>6}{actual:>6}{fps:>7.2f}{dur:>7.2f}s"
                f"{('是' if clip['loop'] else '否'):>6}"
                f"{int(np.median(heights)):>6}{int(np.median(bottoms)):>6}"
                f"{s_first:>7.3f}{s_last:>7.3f}{act_s:>12}"
            )
    print("-" * len(hdr))
    print(f"合计 {total_frames} 帧")
    disk = sum(f.stat().st_size for f in ctx.skin.glob("*.png")) / 1024 / 1024
    print(f"磁盘 {disk:.1f} MB（仅 PNG；preview_* 与 .bak 已于 2026-11 清理）")
    one_shot = [s for s in ctx.states() if not ctx.clips(s)[0]["loop"]]
    if one_shot:
        worst = max(one_shot, key=lambda s: ctx.clips(s)[0]["frames"] / max(1.0, ctx.clips(s)[0]["fps"]))
        c = ctx.clips(worst)[0]
        print(f"最长一次性动作：{worst} {c['frames'] / c['fps']:.2f}s")


# ──────────────────────────── plan / apply ────────────────────────────


def build_plan(ctx: Ctx) -> list[dict]:
    """把 spec 翻译成可执行动作。plan 与 apply 共用同一份，保证"预演=结果"。"""
    plan = []
    for state in ctx.states():
        entry = spec_state(ctx.spec, state)
        if not entry or entry.get("mode", "keep") == "keep":
            continue
        mode = entry["mode"]
        clips = ctx.clips(state)
        if mode == "retime":
            target = float(entry.get("targetSec") or 0)
            if target <= 0:
                die(f"{state}: mode=retime 必须给 targetSec")
            pad = int(entry.get("pad", 0))
            anchor_tail = int(entry.get("anchorTail", 0))
            # 已经补过的回锚帧要扣掉，否则重跑一次就会把动作再提快一档、还重复追加帧（不可幂等）
            applied_tail = int(ctx.manifest.get(state, {}).get("_anchorTail", 0) or 0)
            to_tail = max(0, anchor_tail - applied_tail)
            for clip in clips:
                declared = clip["frames"]
                effective = max(1, declared - pad - applied_tail)
                fps = effective / target
                clamped = min(FPS_MAX, max(FPS_MIN, fps))
                plan.append(
                    {
                        "state": state,
                        "mode": "retime",
                        "sheet": clip["sheet"],
                        "old_frames": declared,
                        "new_frames": declared + to_tail,  # 变速不动帧数，只可能追加回锚帧
                        "old_fps": clip["fps"],
                        "new_fps": round(clamped, 2),
                        "old_dur": declared / clip["fps"] if clip["fps"] else 0,
                        "new_dur": (declared + to_tail) / clamped,
                        "pad": pad,
                        "anchor_tail": to_tail,
                        "clamped": abs(clamped - fps) > 1e-6,
                        "raw_fps": fps,
                        "skip": abs(clip["fps"] - clamped) < 0.005 and to_tail == 0,
                    }
                )
        elif mode == "trim":
            for spec_clip in entry.get("clips", []):
                src = int(spec_clip.get("src", 0))
                if src >= len(clips):
                    die(f"{state}: clip.src={src} 超出范围（当前只有 {len(clips)} 个变体）")
                src_clip = clips[src]
                picks = [int(x) for x in spec_clip.get("pick", [])]
                if not picks:
                    die(f"{state}/{spec_clip.get('sheet')}: 没有给 pick 帧号")
                fps = float(spec_clip.get("fps") or src_clip["fps"])
                # 幂等：输出表已经正好是 len(picks) 帧 → 上一次 apply 的产物，跳过即可
                out_path = ctx.skin / spec_clip["sheet"]
                already = (
                    out_path.exists()
                    and Image.open(out_path).size[0] // src_clip["frameW"] == len(picks)
                )
                if already:
                    plan.append(
                        {
                            "state": state,
                            "mode": "trim",
                            "sheet": spec_clip["sheet"],
                            "src_sheet": src_clip["sheet"],
                            "src_frameW": src_clip["frameW"],
                            "src_frameH": src_clip["frameH"],
                            "picks": picks,
                            "weight": spec_clip.get("weight"),
                            "old_frames": len(picks),
                            "new_frames": len(picks),
                            "old_fps": fps,
                            "new_fps": fps,
                            "old_dur": len(picks) / fps,
                            "new_dur": len(picks) / fps,
                            "anchor_tail": 0,
                            "clamped": False,
                            "skip": True,
                        }
                    )
                    continue
                sheet = open_sheet(ctx.skin / src_clip["sheet"])
                n = sheet.size[0] // src_clip["frameW"]
                bad = [p for p in picks if not (0 <= p < n)]
                if bad:
                    die(
                        f"{state}/{spec_clip.get('sheet')}: pick {bad} 超出源表范围（源 {src_clip['sheet']} 只有 {n} 帧）。"
                        f"\n       说明源表已被裁过但输出表不匹配（可能改过 pick）；先 restore 回备份再跑 apply。"
                    )
                plan.append(
                    {
                        "state": state,
                        "mode": "trim",
                        "sheet": spec_clip["sheet"],
                        "src_sheet": src_clip["sheet"],
                        "src_frameW": src_clip["frameW"],
                        "src_frameH": src_clip["frameH"],
                        "picks": picks,
                        "weight": spec_clip.get("weight"),
                        "old_frames": src_clip["frames"],
                        "new_frames": len(picks),
                        "old_fps": src_clip["fps"],
                        "new_fps": fps,
                        "old_dur": src_clip["frames"] / src_clip["fps"] if src_clip["fps"] else 0,
                        "new_dur": len(picks) / fps,
                        "anchor_tail": 0,
                        "clamped": False,
                        "skip": False,
                    }
                )
        else:
            die(f"{state}: 未知 mode={mode}（只支持 keep / retime / trim）")
    return plan


def head_width(mask) -> int:
    """用"包围盒顶部 18% 高度区间内最宽的一行"近似头宽。

    为什么要这个东西：按包围盒高度归一化只对站姿有效。坐下/悬空/蹲下这类姿势，
    包围盒高度和站姿差不多（Q 版睡姿 252px vs 站姿 388px，高/头宽 1.98 vs 2.18），
    按高度缩会把头放大 10%，同一个角色前后就不是一个尺寸了。
    头宽是跨姿势稳定的量 —— 换了姿势，头还是那个头。
    """
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return 0
    y0, y1 = ys.min(), ys.max()
    band = mask[y0:y0 + max(1, int((y1 - y0) * 0.18)) + 1]
    rows = band.sum(axis=1)
    return int(rows.max()) if len(rows) else 0


def face_width(img: Image.Image) -> int:
    """脸部（肤色连通域）宽度。跨姿势最稳的基准。

    头宽（顶部 18% 带最大行宽）会被"散开的头发"带偏：睡姿头发铺开在两侧，
    实测量出 332px，但真正的头只有脸那么宽。脸宽不会被头发影响，所以坐/躺/悬空用它。
    """
    a = np.asarray(img.convert("RGBA"))
    m = a[..., 3] >= ALPHA_SOLID
    if not m.any():
        return 0
    ys, xs = np.where(m)
    y0, y1 = ys.min(), ys.max()
    region = np.zeros_like(m)
    region[y0:y0 + int((y1 - y0) * 0.55)] = True   # 只在上半身找脸，避开手和腿
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    skin = (r > 190) & (g > 140) & (b > 115) & (r - b > 25) & (r - g > 10) & (g - b > 5) & region
    if not skin.any():
        return 0
    lab, n = ndimage.label(skin, structure=np.ones((3, 3)))
    areas = ndimage.sum(skin, lab, range(1, n + 1))
    main = int(np.argmax(areas)) + 1
    ys2, xs2 = np.where(lab == main)
    return int(xs2.max() - xs2.min() + 1)


def cadence_note(fps: float) -> str:
    """fps 不整除 60 时给提示。

    SpriteRenderer 是 dt 累加 + while(acc >= 1000/fps) 推进帧：fps 除不尽 60 时，
    每帧的驻留时间会在 2 个和 3 个刷新周期之间摇摆（28.5fps ≈ 2.105），肉眼看就是
    「又抖又急」。取 60 的整数分之一（12/15/20/30）驻留时间恒定，同样的时长会平顺得多。
    """
    if fps <= 0:
        return ""
    ticks = 60.0 / fps
    near = min((12.0, 15.0, 20.0, 30.0), key=lambda f: abs(f - fps))
    if abs(ticks - round(ticks)) > 0.02:
        return f"（提示：{fps:g}fps 除不尽 60Hz，每帧驻留会在 {int(ticks)}/{int(ticks) + 1} 个刷新周期间摆动；改 {near:g}fps 更稳）"
    return ""


def _dw(s: str) -> int:
    """显示宽度：CJK/全角算 2，其余算 1。表头对不齐纯粹是它造成的。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(s))


def _pad(s, width: int, align: str = ">") -> str:
    s = str(s)
    gap = max(0, width - _dw(s))
    if align == ">":
        return " " * gap + s
    if align == "^":
        left = gap // 2
        return " " * left + s + " " * (gap - left)
    return s + " " * gap


def print_plan(plan: list[dict]):
    if not plan:
        print("spec 里没有要改的状态（全部 mode=keep）。")
        return
    cols = [("状态", 12, "<"), ("动作", 7, ">"), ("帧数 前→后", 13, ">"),
            ("fps 前→后", 15, ">"), ("时长 前→后", 17, ">"), ("备注", 0, "<")]
    def row(vals):
        return "".join(_pad(v, w, a) if w else f"  {v}" for v, (_, w, a) in zip(vals, cols))
    print(row([c[0] for c in cols]))
    print("-" * 96)
    for p in plan:
        note = []
        if p.get("skip"):
            note.append("已是最新，跳过")
        elif p["mode"] == "trim":
            note.append("取" + ",".join(str(x) for x in p["picks"]))
        if p.get("pad"):
            note.append(f"扣过渡{p['pad']}帧")
        if p["clamped"]:
            note.append(f"已夹到{p['new_fps']}fps")
        if p.get("anchor_tail"):
            note.append(f"补尾{p['anchor_tail']}帧")
        print(row([
            p["state"],
            p["mode"],
            f"{p['old_frames']} → {p['new_frames']}",
            f"{p['old_fps']:.1f} → {p['new_fps']:.1f}",
            f"{p['old_dur']:.2f}s → {p['new_dur']:.2f}s",
            "，".join(note),
        ]))
    before = sum(p["old_dur"] for p in plan)
    after = sum(p["new_dur"] for p in plan)
    print("-" * 96)
    print(f"这 {len(plan)} 段总时长 {before:.2f}s → {after:.2f}s")
    if any(p.get("pad") for p in plan):
        print("注：'时长' 是整张表的播放长度（含入场/退场过渡帧）；动作本体只按扣掉 pad 后的帧数计速。")


def do_backup(ctx: Ctx, reason: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = ctx.backup_root / ts / ctx.skin.name
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ctx.skin, dst)
    save_json(
        dst.parent / "backup.json",
        {
            "time": ts,
            "skin": str(ctx.skin),
            "reason": reason,
            "files": sorted(p.name for p in dst.iterdir()),
        },
    )
    return dst.parent


def write_sheet(ctx: Ctx, plan_item: dict, src: Image.Image) -> int:
    """执行 trim：从源表挑帧拼新表。返回写出帧数。

    src 由调用方预先加载并传入 —— 多个输出变体常常共用同一张源表（blink 的单眨/连眨），
    如果在循环里各自从磁盘读，第一个变体写回同名文件后，第二个变体读到的就是被裁过的表。
    """
    fw, fh = plan_item["src_frameW"], plan_item["src_frameH"]
    picks = plan_item["picks"]
    canvas = Image.new("RGBA", (fw * len(picks), fh), (0, 0, 0, 0))
    for i, p in enumerate(picks):
        canvas.paste(crop_frame(src, p, fw, fh), (i * fw, 0))
    out = ctx.skin / plan_item["sheet"]
    canvas.save(out, "PNG", optimize=True)
    return len(picks)


def append_anchor_tail(ctx: Ctx, state: str, clip: dict, n: int) -> int:
    """末尾追加 n 帧，从原末帧溶解到锚图；最后一帧就是锚图本身。返回新帧数。"""
    sheet = open_sheet(ctx.skin / clip["sheet"])
    fw, fh = clip["frameW"], clip["frameH"]
    total = sheet.size[0] // fw
    an = ctx.anchor()
    anchor_img = an["img"].resize((fw, fh), Image.LANCZOS) if an["img"].size != (fw, fh) else an["img"]
    last = crop_frame(sheet, total - 1, fw, fh)
    canvas = Image.new("RGBA", (fw * (total + n), fh), (0, 0, 0, 0))
    canvas.paste(sheet.crop((0, 0, fw * total, fh)), (0, 0))
    for k in range(n):
        t = (k + 1) / n
        canvas.paste(blend_pm(last, anchor_img, t), ((total + k) * fw, 0))
    canvas.save(ctx.skin / clip["sheet"], "PNG", optimize=True)
    return total + n


def cmd_apply(ctx: Ctx, write: bool):
    plan = build_plan(ctx)
    print_plan(plan)
    if not plan:
        return 0
    if not any(not p.get("skip") for p in plan):
        print("\n素材已是最新，没有要改的（未写盘、未备份）。")
        return 0
    if not write:
        print("\n未写盘。确认无误后加 --write 落盘（会先整目录备份）。")
        return 0

    backup = do_backup(ctx, reason="avatar-sheet-tool apply")
    print(f"\n已备份到 {backup}")

    # 按状态聚合：trim 需要整体替换成 v2 clips，retime 只改 fps。
    by_state: dict[str, list[dict]] = {}
    for p in plan:
        by_state.setdefault(p["state"], []).append(p)

    for state, items in by_state.items():
        defn = ctx.manifest[state]
        if all(i["mode"] == "retime" for i in items):
            clips = ctx.clips(state)
            for i in items:
                # 同一状态多变体时按 sheet 名匹配，避免错改
                for c in clips:
                    if c["sheet"] == i["sheet"]:
                        c["fps"] = i["new_fps"]
            if len(clips) == 1:
                defn["fps"] = clips[0]["fps"]
            else:
                rebuilt = []
                for c in clips:
                    item = {"sheet": c["sheet"], "frameW": c["frameW"], "frameH": c["frameH"],
                            "frames": c["frames"], "fps": c["fps"]}
                    if c.get("weight") is not None:
                        item["weight"] = c["weight"]
                    rebuilt.append(item)
                defn["clips"] = rebuilt
            # anchorTail 会追加帧，帧数变了要同步登记
            tail = int(items[0].get("anchor_tail") or 0)
            if tail:
                c = clips[0]
                new_n = append_anchor_tail(ctx, state, c, tail)
                # 追加的溶解帧按原 fps 播放：动作本体速度不变，只是多出 0.1~0.25s 的收尾过渡
                if len(clips) == 1:
                    defn["frames"] = new_n
                else:
                    defn["clips"][0]["frames"] = new_n
                # 记一笔已补帧数，保证 apply 可重复执行（渲染端只读 sheet/loop/clips，忽略下划线字段）
                defn["_anchorTail"] = int(defn.get("_anchorTail", 0) or 0) + tail
                print(f"  {state}: 追加 {tail} 帧回锚过渡 → {new_n} 帧（fps 不变）")
            print(f"  {state}: fps → {items[0]['new_fps']}")
        else:
            # trim：逐个变体写表，然后整体改写成 v2 clips（保留 weight）
            # 先把所有源表读进内存：多个输出可能共用同一张源表，边写边读会读到被裁过的表。
            src_cache: dict[str, Image.Image] = {}
            for i in items:
                if i["src_sheet"] not in src_cache:
                    src_cache[i["src_sheet"]] = open_sheet(ctx.skin / i["src_sheet"])
            new_clips = []
            for i in items:
                if i.get("skip"):
                    n = i["new_frames"]
                    print(f"  {state}: {i['sheet']} 已是最新（{n} 帧），跳过")
                else:
                    n = write_sheet(ctx, i, src_cache[i["src_sheet"]])
                    print(f"  {state}: 裁出 {i['sheet']} {i['old_frames']} → {n} 帧（{i['new_fps']}fps）")
                clip = {
                    "sheet": i["sheet"],
                    "frameW": i["src_frameW"],
                    "frameH": i["src_frameH"],
                    "frames": n,
                    "fps": i["new_fps"],
                }
                if i.get("weight") is not None:
                    clip["weight"] = i["weight"]
                new_clips.append(clip)
            # 保底：spec 没覆盖到的原变体原样保留，避免"改一个变体顺手删了另一个"
            covered = {i["sheet"] for i in items}
            for c in ctx.clips(state):
                if c["sheet"] in covered:
                    continue
                keep = {"sheet": c["sheet"], "frameW": c["frameW"], "frameH": c["frameH"],
                        "frames": c["frames"], "fps": c["fps"]}
                if c.get("weight") is not None:
                    keep["weight"] = c["weight"]
                new_clips.append(keep)
            # 只清掉扁平格式的旧键，其余字段（weight / rate / 未来新增属性）原样保留 ——
            # 整体 clear 会把别人写进去的配置一起删掉。
            for k in ("sheet", "frameW", "frameH", "frames", "fps"):
                defn.pop(k, None)
            defn["loop"] = False
            defn["clips"] = new_clips

    ctx.manifest["version"] = bump_version(ctx.manifest.get("version", "0.0.0"))
    save_json(ctx.manifest_path, ctx.manifest)
    print(f"frames.json 已更新（version → {ctx.manifest['version']}）")

    print("\n自动质检：")
    code = cmd_verify(Ctx(ctx.skin, ctx.spec))
    if code == 0:
        print("\n完成。本地验证前记得删掉 userData/avatars/<皮肤名> 再启动，否则看到的还是旧素材。")
    return code


# ──────────────────────────── verify ────────────────────────────


def cmd_verify(ctx: Ctx, only: str | None = None) -> int:
    an = ctx.anchor()
    hard, soft = [], []
    states = [only] if only else ctx.states()

    for state in states:
        for clip in ctx.clips(state):
            path = ctx.skin / clip["sheet"]
            if not path.exists():
                hard.append(f"{state}/{clip['sheet']}: 文件不存在")
                continue
            sheet = open_sheet(path)
            fw, fh = clip["frameW"], clip["frameH"]
            if sheet.size[1] != fh:
                hard.append(f"{state}/{clip['sheet']}: 高度 {sheet.size[1]} ≠ 声明 {fh}")
                continue
            if sheet.size[0] % fw:
                hard.append(f"{state}/{clip['sheet']}: 宽度 {sheet.size[0]} 不是 {fw} 的整数倍")
                continue
            actual = sheet.size[0] // fw
            if actual != clip["frames"]:
                hard.append(f"{state}/{clip['sheet']}: 实际 {actual} 帧 ≠ 声明 {clip['frames']} 帧")

            grays, heights, bottoms = [], [], []
            empty_frames, green_frames = [], []
            for i in range(actual):
                m = frame_metrics(crop_frame(sheet, i, fw, fh))
                if m["empty"]:
                    empty_frames.append(i)
                    continue
                if m["green_ratio"] > ctx.green_th:
                    green_frames.append((i, m["green_ratio"]))
                grays.append(m["gray"])
                heights.append(m["h"])
                bottoms.append(m["bottom"])
            if empty_frames:
                hard.append(f"{state}/{clip['sheet']}: {len(empty_frames)} 帧全透明（{empty_frames[:6]}）")
            if green_frames:
                worst = max(green_frames, key=lambda x: x[1])
                hard.append(
                    f"{state}/{clip['sheet']}: 绿幕残留 {len(green_frames)} 帧超 {ctx.green_th:.0%}"
                    f"（最差 f{worst[0]} {worst[1]:.1%}）"
                )
            if not grays:
                continue

            h_med = float(np.median(heights))
            b_med = float(np.median(bottoms))
            exempt = state in ctx.height_exempt
            if an["h"] and not exempt and abs(h_med - an["h"]) / an["h"] > ctx.height_tol:
                soft.append(
                    f"{state}/{clip['sheet']}: 角色高 {h_med:.0f}px 与锚图 {an['h']}px 差 "
                    f"{abs(h_med - an['h']) / an['h']:.0%} > {ctx.height_tol:.0%}"
                )
            if abs(b_med - an["bottom"]) > ctx.bottom_tol and state not in ctx.bottom_exempt:
                soft.append(
                    f"{state}/{clip['sheet']}: 脚底 y={b_med:.0f} 偏离锚图 {an['bottom']}px 超过 {ctx.bottom_tol}px"
                )

            if clip["loop"]:
                s = ssim(grays[0], grays[-1])
                if s < ctx.ssim_th:
                    soft.append(f"{state}/{clip['sheet']}: 循环接缝 SSIM {s:.3f} < {ctx.ssim_th}")
            else:
                s0, s1 = ssim(grays[0], an["gray"]), ssim(grays[-1], an["gray"])
                if s0 < ctx.ssim_th:
                    soft.append(f"{state}/{clip['sheet']}: 首帧回锚 SSIM {s0:.3f} < {ctx.ssim_th}")
                if s1 < ctx.ssim_th:
                    soft.append(f"{state}/{clip['sheet']}: 尾帧回锚 SSIM {s1:.3f} < {ctx.ssim_th}")

            jumps = [i for i in range(1, len(grays)) if rms(grays[i], grays[i - 1]) > ctx.jump_rms]
            if jumps:
                soft.append(
                    f"{state}/{clip['sheet']}: {len(jumps)} 处相邻帧跳变 RMS > {ctx.jump_rms}"
                    f"（f{jumps[:5]}）"
                )

    if hard:
        print(f"硬失败 {len(hard)} 条（会让桌宠真的出问题，必须修）：")
        for h in hard:
            print(f"  ✗ {h}")
    if soft:
        print(f"警告 {len(soft)} 条（素材不够理想，不阻塞）：")
        for s in soft:
            print(f"  ! {s}")
    if not hard and not soft:
        print("全部通过，无警告。")
    elif not hard:
        print("\n无硬失败。")
    return 1 if hard else 0


# ──────────────────────────── restore ────────────────────────────


def cmd_restore(ctx: Ctx, backup_dir: Path, prune: bool) -> int:
    d = backup_dir if backup_dir.is_absolute() else (REPO_ROOT / backup_dir)
    if not d.exists():
        die(f"备份目录不存在：{d}")
    meta = d / "backup.json"
    src_dir = d / ctx.skin.name
    if not src_dir.exists():
        # 备份时皮肤目录名可能不同，退一步找唯一含 frames.json 的子目录
        cands = [p for p in d.iterdir() if p.is_dir() and (p / "frames.json").exists()]
        if len(cands) != 1:
            die(f"{d} 里找不到唯一的皮肤目录（含 frames.json 的子目录）")
        src_dir = cands[0]
    if meta.exists():
        try:
            print(f"备份信息：{json.loads(meta.read_text(encoding='utf-8'))}")
        except json.JSONDecodeError:
            pass
    n = 0
    for f in src_dir.iterdir():
        if f.is_file():
            shutil.copy2(f, ctx.skin / f.name)
            n += 1
    extra = [p.name for p in ctx.skin.iterdir() if p.is_file() and not (src_dir / p.name).exists()]
    print(f"已还原 {n} 个文件到 {ctx.skin}")
    if extra:
        if prune:
            for name in extra:
                (ctx.skin / name).unlink()
            print(f"已删除备份里没有的 {len(extra)} 个文件：{extra}")
        else:
            print(f"注意：备份里没有这 {len(extra)} 个文件，默认保留未删（要删加 --prune）：{extra}")
    return 0


# ──────────────────────────── smooth ────────────────────────────


def cmd_smooth(src_dir: Path, dst_dir: Path, radius: int, write: bool) -> int:
    """时间轴去闪：对每一帧取「相邻 2r+1 帧的中位数」。

    AI 视频的通病是**每帧把明暗重新画一遍**，轮廓还在原地，但花色/阴影/高光在逐帧变。
    这种高频抖动换什么抠像参数都治不了 —— 它不在 alpha 上，在颜色上。

    中位数滤波（而不是平均）：中位数会把"某帧才出现的一笔偏差"直接投掉，
    而平均会把它糊成半透明拖影。呼吸/待机这类动作位移只有 1~2px，取 3~5 帧中位数
    几乎不损失动作，却能消掉绝大部分闪烁。

    实现按预乘 alpha 处理：透明像素不参与拉低颜色，避免边缘出现黑边。
    """
    src = src_dir if src_dir.is_absolute() else (REPO_ROOT / src_dir)
    dst = dst_dir if dst_dir.is_absolute() else (REPO_ROOT / dst_dir)
    if not src.is_dir():
        die(f"找不到帧目录：{src}")
    files = sorted(p for p in src.iterdir() if p.suffix.lower() == ".png")
    if len(files) < 3:
        die(f"{src} 帧数太少（{len(files)}），时间轴滤波没意义")
    if radius < 1:
        die("--radius 至少 1（3 帧窗口）")
    if write:
        dst.mkdir(parents=True, exist_ok=True)

    # 全部读进内存：5 帧窗口 × 720×960 RGBA 约 70MB，可接受
    stack = []
    for p in files:
        a = np.asarray(Image.open(p).convert("RGBA")).astype(np.float32)
        stack.append(a)
    n = len(stack)
    print(f"时间轴中位数滤波：{n} 帧，窗口 {2 * radius + 1}")

    for i in range(n):
        idx = [j for j in range(i - radius, i + radius + 1) if 0 <= j < n]
        # 循环态首尾要相接：把窗口绕回去取样，避免首尾几帧被静音
        if len(idx) < 2 * radius + 1:
            extra = [j % n for j in range(i - radius, i + radius + 1)]
            idx = sorted(set(extra))
        win = np.stack([stack[j] for j in idx])
        a_win = win[..., 3:4] / 255.0
        pm = win[..., :3] * a_win                       # 预乘
        med_a = np.median(win[..., 3], axis=0)
        med_pm = np.median(pm, axis=0)
        alpha = med_a[..., None] / 255.0
        rgb = np.where(alpha > 1e-4, med_pm / np.maximum(alpha, 1e-4), 0.0)
        out = np.concatenate([np.clip(rgb, 0, 255), med_a[..., None]], axis=2)
        if write:
            Image.fromarray(out.astype(np.uint8), "RGBA").save(dst / files[i].name, "PNG", optimize=True)

    if not write:
        print("未写盘。加 --write 落盘。")
        return 0
    print(f"已写出到 {dst}")
    return 0


# ──────────────────────────── key ────────────────────────────


def cmd_key(src_dir: Path, dst_dir: Path, lo: float, hi: float, write: bool) -> int:
    """绿幕抠像：按「绿度」做软 alpha，而不是按固定颜色距离。

    为什么不用 ffmpeg 的 chromakey：它算的是"到某个绿的距离"，参数一紧，抗锯齿边缘就
    在"算前景/算背景"之间逐帧翻面 —— 实测打包后整条轮廓上 9180 个像素的 alpha 时序标准差
    > 40（最大 127），放到桌面上就是轮廓/阴影在沸腾。

    这个项目的绿幕素材有极好的可分性（实测一帧）：
        纯背景   E = 223      绿幕上的软阴影  E = 226   ← 阴影也是绿的，天然被吃掉
        头发     E = −19      白衬衫          E = −11
    其中 E = G − max(R,B)（绿度）。默认 lo=60 / hi=140：E ≤ lo 全不透明、E ≥ hi 全透明、
    中间线性过渡。alpha 完全由像素自身颜色决定，同一块颜色在相邻帧算出的 alpha 一样 → 不闪。

    顺带做去绿溢（despill）：把偏绿的像素的 G 压到 max(R,B) 附近，避免边缘发绿。
    """
    src = src_dir if src_dir.is_absolute() else (REPO_ROOT / src_dir)
    dst = dst_dir if dst_dir.is_absolute() else (REPO_ROOT / dst_dir)
    if not src.is_dir():
        die(f"找不到帧目录：{src}")
    files = sorted(p for p in src.iterdir() if p.suffix.lower() == ".png")
    if not files:
        die(f"{src} 里没有 PNG")
    if lo >= hi:
        die(f"--lo 必须小于 --hi（当前 {lo} / {hi}）")
    if write:
        dst.mkdir(parents=True, exist_ok=True)

    for p in files:
        a = np.asarray(Image.open(p).convert("RGB")).astype(np.float32)
        r, g, b = a[..., 0], a[..., 1], a[..., 2]
        e = g - np.maximum(r, b)                                   # 绿度
        alpha = np.clip((hi - e) / (hi - lo), 0.0, 1.0)
        # 去绿溢：只动"偏绿"的像素，把 G 压回 max(R,B)，避免半透明边缘发绿光
        spill = e > 0
        g2 = np.where(spill, np.minimum(g, np.maximum(r, b) + 8.0), g)
        rgb = np.stack([r, g2, b], axis=2)
        out = np.dstack([np.clip(rgb, 0, 255), (alpha * 255.0)])
        if write:
            Image.fromarray(out.astype(np.uint8), "RGBA").save(dst / p.name, "PNG", optimize=True)

    if not write:
        print(f"抠像参数 lo={lo:g} hi={hi:g}（未写盘，加 --write 落盘）")
        return 0
    print(f"抠像 {len(files)} 帧 → {dst}（绿度阈值 {lo:g}~{hi:g}，已去绿溢）")
    return 0


# ──────────────────────────── clean ────────────────────────────


def _dilate(mask, k: int):
    """方形膨胀（用滑窗 max 实现，无需 scipy）。"""
    from numpy.lib.stride_tricks import sliding_window_view
    pad = k // 2
    padded = np.pad(mask, pad, mode="constant")
    return sliding_window_view(padded, (k, k)).max(axis=(2, 3))


def cmd_clean(src_dir: Path, dst_dir: Path, keep_shadow: bool, write: bool) -> int:
    """清掉抠像残留：绿幕上的投影/软阴影、角落水印、零散噪点。

    做法：以「alpha >= 250 的不透明主体」为核心，只保留**贴着核心 1px**、且 alpha >= 120 的
    像素（那是角色的抗锯齿边）。离主体较远的半透明像素（软阴影、水印被抠掉一半的残字、
    边缘噪点）一律清成全透明。

    两步各治一种残留，缺一不可：
    1) **连通域**治水印/杂物：豆包的水印是半透明小字，经常散成 3~4 个独立小块，
       位置还会在帧间跳（实测有的帧在右下角、有的帧在左上角）。只保留面积最大的连通域即可。
    2) **贴不贴核心**治软阴影：阴影和鞋是连着的，连通域分不开它，但它不是"贴着轮廓 1px"的细边，
       而是散开一大片，所以用「必须贴着 alpha>=250 的主体」这个判据能干净地切掉。
    """
    src = src_dir if src_dir.is_absolute() else (REPO_ROOT / src_dir)
    dst = dst_dir if dst_dir.is_absolute() else (REPO_ROOT / dst_dir)
    if not src.is_dir():
        die(f"找不到帧目录：{src}")
    files = sorted(p for p in src.iterdir() if p.suffix.lower() == ".png")
    if not files:
        die(f"{src} 里没有 PNG")

    if write:
        dst.mkdir(parents=True, exist_ok=True)

    dropped_total = 0
    shadow_total = 0
    for p in files:
        im = Image.open(p).convert("RGBA")
        a = np.asarray(im).astype(np.int16)
        al = a[..., 3]
        lum = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
        core = al >= 250
        if keep_shadow:
            keep = al > 20
        else:
            # 1) 只留面积最大的连通域（= 角色本体），水印/杂块全部丢掉
            raw = al >= 16
            if raw.any():
                lab, n = ndimage.label(raw, structure=np.ones((3, 3)))
                if n > 1:
                    areas = ndimage.sum(raw, lab, range(1, n + 1))
                    main = int(np.argmax(areas)) + 1
                    raw = lab == main
            # 2) 在角色本体内，只保留不透明核心 + 贴着核心的抗锯齿边（软阴影被切掉）
            keep = raw & (core | (_dilate(core, 3) & (al >= 120)))
            if not keep.any():   # 兜底：万一核心判定失败，至少留下主连通域
                keep = raw
        dropped_total += int(((al > 20) & ~keep).sum())
        shadow_total += int(((al > 20) & (al < 250) & (lum < 120) & ~keep).sum())
        if write:
            out = np.dstack([a[..., :3].astype(np.uint8), (keep * 255).astype(np.uint8)])
            Image.fromarray(out, "RGBA").save(dst / p.name, "PNG", optimize=True)

    print(f"清理 {len(files)} 帧：丢掉了 {dropped_total} 个残留像素"
          f"（其中半透明暗像素/软阴影 {shadow_total} 个）")
    if not write:
        print("未写盘。确认后加 --write --to <输出目录>。")
        return 0
    print(f"已写出到 {dst}")
    return 0


# ──────────────────────────── pack ────────────────────────────


def cmd_pack(ctx: Ctx, src_dir: Path, state: str, fps: float, auto_trim: bool,
             loop: bool, sheet_name: str | None, write: bool,
             loop_crossfade: int = 0, align: str = "clip", scale_by: str = "height",
             explicit_scale: float = 0.0, tail_anchor: int = 0,
             lift: int = 0) -> int:
    src = src_dir if src_dir.is_absolute() else (REPO_ROOT / src_dir)
    if not src.is_dir():
        die(f"找不到抠像后的帧目录：{src}")
    files = sorted([p for p in src.iterdir() if p.suffix.lower() == ".png"])
    if not files:
        die(f"{src} 里没有 PNG")
    an = ctx.anchor()
    fw, fh = an["frameW"], an["frameH"]
    sheet_name = sheet_name or f"{state}.png"

    print(f"入库 {state}：{len(files)} 帧 → {sheet_name}（{fw}×{fh} / {fps}fps）")
    print(f"锚图基准：高 {an['h']}px  脚底 y={an['bottom']}  中心 x={an['cx']:.0f}")
    if lift:
        print(f"  整体上移 {lift}px（悬空姿态，底边不落地）")

    placed, scaled_w, width_capped = [], [], []
    # 参考帧：整段只认它一个。一次性动作的第 0 帧就是"锚图姿势"，
    # 用它算出唯一的缩放与偏移，后面每一帧都套同一套变换。
    metrics_first = None

    for p in files:
        im = Image.open(p).convert("RGBA")
        m = frame_metrics(im)
        if m["empty"]:
            die(f"{p.name}: 整帧全透明（源素材废了），先修源再入库")
        if metrics_first is None:
            metrics_first = m
    ref = metrics_first

    # 缩放只按参考帧算。逐帧按"本帧包围盒高"缩放会让角色在动作中忽大忽小；
    # 逐帧按"本帧包围盒中心"摆放更糟 —— 手臂伸出时包围盒中心偏了，身体会被推着反向滑
    # （Q 版 wave 实测：包围盒宽 362~390、左缘 160~184 漂移，而脚底 y 恒定，说明身体没动）。
    # 归一化基准：height=按包围盒高度对齐锚图角色高（站姿动作的默认值）；
    # head=按头宽对齐（坐下/悬空/蹲下这类"包围盒高度不可比"的姿势必须用它）。
    if explicit_scale and explicit_scale > 0:
        scale = float(explicit_scale)
        print(f"  使用显式缩放系数 {scale:.3f}")
    elif scale_by == "face":
        ref_face = face_width(Image.open(files[0]).convert("RGBA"))
        an_face = face_width(an["img"])
        if ref_face <= 0 or an_face <= 0:
            die(f"{files[0].name} 或锚图测不出脸（可能侧脸/背身），改用 --scale-by head 或 --scale <系数>")
        scale = an_face / ref_face
        print(f"  按脸宽归一化：锚图脸宽 {an_face}px / 本素材 {ref_face}px → 缩放 {scale:.3f}")
    elif scale_by == "head":
        a0m = np.asarray(Image.open(files[0]).convert("RGBA"))
        ref_head = head_width(a0m[..., 3] >= ALPHA_SOLID)
        an_head = head_width(np.asarray(an["img"])[..., 3] >= ALPHA_SOLID)
        if ref_head <= 0 or an_head <= 0:
            die(f"{files[0].name} 或锚图测不出头宽，改用 --scale-by height")
        scale = an_head / ref_head
        print(f"  按头宽归一化：锚图头宽 {an_head}px / 本素材 {ref_head}px → 缩放 {scale:.3f}")
    else:
        scale = an["h"] / ref["h"]
    scale_by_w = ctx.max_width / ref["w"]
    if scale_by_w < scale:
        width_capped.append(files[0].name)
        scale = scale_by_w
    # 参考帧的包围盒中心/脚底落到锚图的中心/脚底上；其余帧沿用这一偏移
    a0 = np.asarray(Image.open(files[0]).convert("RGBA"))
    m0 = a0[..., 3] >= ALPHA_SOLID
    ys0, xs0 = np.where(m0)
    ref_cx, ref_bottom = (xs0.min() + xs0.max() + 1) / 2.0, ys0.max() + 1
    px = round(an["cx"] - ref_cx * scale)
    # --lift：整体上移。悬空素材（drag）必须用，否则底边会被按回锚图的脚底线，
    # "被拎起来"就变成"踮脚站着"。抬高量直接减在 y 上，不影响缩放。
    py = round(an["bottom"] - ref_bottom * scale) - lift

    for p in files:
        im = Image.open(p).convert("RGBA")
        if align == "frame":
            # 旧行为（逃生阀）：逐帧按自己的包围盒裁切并对齐。只适合"身体会整体位移"的素材。
            m = frame_metrics(im)
            nw, nh = max(1, round(m["w"] * scale)), max(1, round(m["h"] * scale))
            a = np.asarray(im)
            mask = a[..., 3] >= ALPHA_SOLID
            ys, xs = np.where(mask)
            crop = im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
            r = crop.resize((nw, nh), Image.LANCZOS)
            canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
            canvas.paste(r, (round(an["cx"] - nw / 2), round(an["bottom"] - nh) - lift), r)
            placed.append(canvas)
            scaled_w.append(nw)
            continue
        # 统一变换：整帧按同一系数缩放，再按同一偏移贴到画布（paste 自带裁切）
        nw, nh = max(1, round(im.width * scale)), max(1, round(im.height * scale))
        r = im.resize((nw, nh), Image.LANCZOS)
        canvas = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
        canvas.paste(r, (px, py), r)
        placed.append(canvas)
        scaled_w.append(nw)

    if width_capped:
        print(f"  注意：{len(width_capped)} 帧因宽度上限 {ctx.max_width}px 被压缩（身高会低于锚图），"
              f"首次出现于 {width_capped[0]}")

    if auto_trim and len(placed) > 4:
        grays = [np.asarray(f.convert("L"), dtype=np.float32) for f in placed]
        # 判据用「与末帧的相似度」而不是逐帧差分：逐帧差分会被打包时的重采样抖动打断
        # （wave 实测末段有个 1.71 的噪声尖峰，导致 13 帧尾巴只切掉 5 帧）。
        # 与末帧比只看"还动不动"，静止尾巴里再小的呼吸抖动都在阈值内。
        end = grays[-1]
        k = len(placed) - 1
        while k > 0 and rms(grays[k - 1], end) < ctx.static_rms:
            k -= 1
        trailing = len(placed) - k
        if trailing >= ctx.static_min:
            cut = k + 1  # 保留到最后一个"还跟末帧不一样"的帧，再多留一帧收尾
            print(f"  --auto-trim：切掉末尾 {len(placed) - cut} 帧静止尾巴 → {cut} 帧")
            placed = placed[:cut]

    # 杂物检测：整帧粘贴会把"角色包围盒之外"的东西也带进来（逐帧裁切时代会被裁掉）。
    # AI 视频偶尔会在边角冒出一块孤立残片（wave 实测末 4 帧左上角有个小蓝块），
    # 这里按"参考帧包围盒外 60px 之外还有成片实心像素"判定，命中就丢掉末尾这几帧。
    if len(placed) >= 6:
        a0 = np.asarray(placed[0])
        m0 = a0[..., 3] >= ALPHA_SOLID
        ys0, xs0 = np.where(m0)
        y0, y1, x0, x1 = ys0.min(), ys0.max(), xs0.min(), xs0.max()
        margin = 60
        # 只在**四个角**找残片：水印/杂块都在角上，而跳跃、举手这些动作会让角色
        # 合法地冲出参考帧包围盒（happy 起跳时头顶比站姿高 111px），按"全幅越界"判会误报。
        corner = np.zeros((fh, fw), dtype=bool)
        cw, ch = int(fw * 0.28), int(fh * 0.22)
        corner[:ch, :cw] = corner[:ch, -cw:] = corner[-ch:, :cw] = corner[-ch:, -cw:] = True
        flagged = []
        for i, f in enumerate(placed):
            m = (np.asarray(f)[..., 3] >= ALPHA_SOLID) & corner
            outside = np.zeros_like(m)
            outside[max(0, y0 - margin):min(fh, y1 + margin + 1),
                    max(0, x0 - margin):min(fw, x1 + margin + 1)] = True
            stray = int((m & ~outside).sum())
            if stray > 30:
                flagged.append(i)
        if flagged:
            # 只处理"连到末尾"的那一段：中间的孤立残片没法靠切尾巴解决，留给人工
            tail = len(placed) - 1
            cut_from = None
            while tail >= 0 and tail in flagged:
                cut_from = tail
                tail -= 1
            if cut_from is not None and cut_from >= 4:
                print(f"  杂物检测：末尾 {len(placed) - cut_from} 帧有角色包围盒之外的残片（f{cut_from} 起），已丢弃")
                placed = placed[:cut_from]
            elif flagged:
                print(f"  警告：f{flagged[0]} 等 {len(flagged)} 帧有画幅边角的残片，建议重抽素材或手工处理")

    # 尾部回锚：一次性动作播完要能接回 idle，但 AI 几乎从不把最后几帧画回标准站姿
    # （happy 实测：跳完双手一直捧在胸前，到 2.5 秒后才放下，整段 4.4 秒太长）。
    # 这里追加 N 帧，从原末帧渐变到锚图，最后一帧就是锚图本身 —— 切换回 idle 时不再跳姿势。
    if tail_anchor > 0 and len(placed) >= 2:
        target = an["img"]
        if target.size != (fw, fh):
            target = target.resize((fw, fh), Image.LANCZOS)
        last = placed[-1]
        extra = [blend_pm(last, target, (k + 1) / tail_anchor) for k in range(tail_anchor)]
        placed = placed + extra
        print(f"  尾部回锚：追加 {tail_anchor} 帧 末帧→锚图 渐变 → {len(placed)} 帧")

    # 循环收尾：AI 生成的"首尾相同"从来做不到逐帧一致（speak 实测接缝 SSIM 0.853），
    # 直接循环会在每一圈的接缝处看到一次嘴型/姿势跳变。追加 N 帧从末帧渐变回首帧，
    # 让最后一步与"回到第 0 帧"的步子一样小，接缝就消失了（旧的 Q 版包是 61→63，就是这个做法）。
    if loop_crossfade > 0 and len(placed) >= 2:
        first, last = placed[0], placed[-1]
        extra = [blend_pm(last, first, (k + 1) / (loop_crossfade + 1)) for k in range(loop_crossfade)]
        placed = placed + extra
        print(f"  循环收尾：追加 {loop_crossfade} 帧 末帧→首帧 渐变 → {len(placed)} 帧")
    elif loop and loop_crossfade == 0:
        print("  提示：循环态建议加 --loop-crossfade 2，否则接缝会有一下跳（AI 视频首尾做不到逐帧一致）")

    out_path = ctx.skin / sheet_name
    if not write:
        print(f"未写盘（预览 {len(placed)} 帧）。确认后加 --write。")
        return 0

    if out_path.exists():
        do_backup(ctx, reason=f"pack {state} 覆盖 {sheet_name}")
    canvas = Image.new("RGBA", (fw * len(placed), fh), (0, 0, 0, 0))
    for i, f in enumerate(placed):
        canvas.paste(f, (i * fw, 0))
    canvas.save(out_path, "PNG", optimize=True)

    # 登记：已有状态按原格式改，新状态写扁平单变体（与现有皮肤一致，最易读）
    defn = ctx.manifest.get(state)
    entry = {"sheet": sheet_name, "frameW": fw, "frameH": fh, "frames": len(placed), "fps": fps, "loop": loop}
    if isinstance(defn, dict) and isinstance(defn.get("clips"), list):
        defn["loop"] = loop
        replaced = False
        for c in defn["clips"]:
            if c.get("sheet") == sheet_name:
                c.update({k: entry[k] for k in ("frameW", "frameH", "frames", "fps")})
                replaced = True
        if not replaced:
            defn["clips"].append(dict(entry, weight=1))
    elif isinstance(defn, dict) and defn.get("sheet"):
        # 已有单变体：如果写的是另一个 sheet，升级成 v2 免得把原变体冲掉
        if defn["sheet"] == sheet_name:
            defn.update(entry)
        else:
            ctx.manifest[state] = {"loop": loop, "clips": [dict(defn), dict(entry, weight=1)]}
    else:
        ctx.manifest[state] = entry
    ctx.manifest["version"] = bump_version(ctx.manifest.get("version", "0.0.0"))
    save_json(ctx.manifest_path, ctx.manifest)
    print(f"已写出 {out_path}（{len(placed)} 帧 / {fps}fps / {len(placed) / fps:.2f}s），frames.json → {ctx.manifest['version']}")
    note = cadence_note(fps)
    if note:
        print(f"  {note}")
    print("\n对该状态单独质检：")
    return cmd_verify(Ctx(ctx.skin, ctx.spec), only=state)


# ──────────────────────────── 入口 ────────────────────────────


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="桌宠精灵表体检 / 重剪 / 质检 / 入库（默认只读，加 --write 才落盘）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    ap.add_argument("command",
                    choices=["analyze", "plan", "apply", "verify", "restore", "pack", "clean", "key", "smooth"])
    ap.add_argument("target", nargs="?", help="restore 的备份目录")
    ap.add_argument("--skin", help=f"皮肤目录（默认取 spec.skin，即 {DEFAULT_SKIN}）")
    ap.add_argument("--spec", help=f"规格文件（默认 {DEFAULT_SPEC}）")
    ap.add_argument("--write", action="store_true", help="真正写盘（会先整目录备份）")
    ap.add_argument("--prune", action="store_true", help="restore 时删掉备份里没有的文件")
    ap.add_argument("--backup-dir", help=f"备份根目录（默认 {BACKUP_ROOT}，相对仓库根）")
    ap.add_argument("--from", dest="src_dir", help="pack/clean：输入帧目录（透明 PNG）")
    ap.add_argument("--to", dest="dst_dir", help="clean：清理结果输出目录（默认 <from>_clean）")
    ap.add_argument("--keep-shadow", action="store_true", help="clean：保留软阴影（默认清掉）")
    ap.add_argument("--radius", type=int, default=1, help="smooth：时间轴窗口半径（1=3帧，2=5帧）")
    ap.add_argument("--lo", type=float, default=60.0, help="key：绿度低于此值全不透明（默认 60）")
    ap.add_argument("--hi", type=float, default=140.0, help="key：绿度高于此值全透明（默认 140）")
    ap.add_argument("--state", help="pack：要登记的状态名")
    ap.add_argument("--fps", type=float, default=12.0, help="pack：播放帧率（默认 12）")
    ap.add_argument("--auto-trim", action="store_true", help="pack：自动切掉末尾静止帧")
    ap.add_argument("--loop", action="store_true", help="pack：登记为循环态")
    ap.add_argument("--tail-anchor", type=int, default=0,
                    help="pack：一次性动作尾部追加 N 帧渐变回锚图（末帧=锚图），避免切回 idle 跳姿势")
    ap.add_argument("--loop-crossfade", type=int, default=0,
                    help="pack：循环态收尾，追加 N 帧 末帧→首帧 渐变（循环态建议 2）")
    ap.add_argument("--sheet", help="pack：输出精灵表文件名（默认 <state>.png）")
    ap.add_argument("--scale", type=float, default=0.0, help="pack：直接指定缩放系数（覆盖 --scale-by）")
    ap.add_argument("--lift", type=int, default=0,
                    help="pack：整体上移 N 像素（悬空/被拎起的素材必须用，默认 0=底边贴锚图脚底线）")
    ap.add_argument("--scale-by", choices=["height", "head", "face"], default="height",
                    help="pack：归一化基准。height=按角色包围盒高度（站姿动作）；"
                         "head=按头宽（会被散开的头发带偏）；"
                         "face=按脸宽（坐/躺/悬空首选，跨姿势最稳）")
    ap.add_argument("--align", choices=["clip", "frame"], default="clip",
                    help="pack：对齐方式。clip=整段共用一套缩放/偏移（默认，身体不会跟着手臂晃）；"
                         "frame=逐帧按各自包围盒居中（旧行为，仅适合身体整体位移的素材）")
    args = ap.parse_args(argv)

    spec_path = Path(args.spec) if args.spec else (REPO_ROOT / DEFAULT_SPEC)
    spec = load_json(spec_path if spec_path.is_absolute() else REPO_ROOT / spec_path)
    ctx = Ctx(resolve_skin(args.skin, spec), spec)
    if args.backup_dir:
        ctx.backup_root = Path(args.backup_dir) if Path(args.backup_dir).is_absolute() else REPO_ROOT / args.backup_dir

    if args.command == "analyze":
        return cmd_analyze(ctx)
    if args.command == "plan":
        print_plan(build_plan(ctx))
        return 0
    if args.command == "apply":
        return cmd_apply(ctx, args.write)
    if args.command == "verify":
        return cmd_verify(ctx)
    if args.command == "restore":
        if not args.target:
            die("restore 需要备份目录：restore .avatar-backup/20261102-012806")
        return cmd_restore(ctx, Path(args.target), args.prune)
    if args.command == "smooth":
        if not args.src_dir:
            die("smooth 需要 --from <RGBA 帧目录>")
        s_src = Path(args.src_dir)
        s_dst = Path(args.dst_dir) if args.dst_dir else Path(str(args.src_dir).rstrip("/\\") + "_smooth")
        return cmd_smooth(s_src, s_dst, args.radius, args.write)
    if args.command == "key":
        if not args.src_dir:
            die("key 需要 --from <RGB 帧目录>")
        d_src = Path(args.src_dir)
        d_dst = Path(args.dst_dir) if args.dst_dir else Path(str(args.src_dir).rstrip("/\\") + "_keyed")
        return cmd_key(d_src, d_dst, args.lo, args.hi, args.write)
    if args.command == "clean":
        if not args.src_dir:
            die("clean 需要 --from <帧目录>")
        src = Path(args.src_dir)
        dst = Path(args.dst_dir) if args.dst_dir else Path(str(args.src_dir).rstrip("/\\") + "_clean")
        return cmd_clean(src, dst, args.keep_shadow, args.write)
    if args.command == "pack":
        if not args.src_dir or not args.state:
            die("pack 需要 --from <目录> --state <状态名>")
        return cmd_pack(ctx, Path(args.src_dir), args.state, args.fps,
                        args.auto_trim, args.loop, args.sheet, args.write,
                        max(0, args.loop_crossfade), args.align, args.scale_by, args.scale,
                        max(0, args.tail_anchor), args.lift)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except BrokenPipeError:
        sys.exit(0)
    except ModuleNotFoundError as e:
        die(f"缺少依赖：{e.name}。先 pip install pillow numpy\n"
            f"       本机 python 可能指向没有 Pillow 的解释器，WorkBuddy 环境用：\n"
            f"       C:/Users/Aki/.workbuddy/binaries/python/envs/default/Scripts/python")
