#!/usr/bin/env node
/**
 * 动画衔接修复 · 过渡帧构建脚本
 *
 * 问题背景：
 *   一次性动作（nod/excited/shy/...）的首帧与末帧没有锚定到基础态(idle)的中立姿势，
 *   与 idle 的差异达 2.7%~6.0%（idle 自身呼吸抖动仅 1.79%~3.06%），硬切时肉眼可见"闪入"。
 *
 * 本脚本做的事：
 *   在每张动作精灵表的**头部插入 N 帧入场过渡**（idle 中立帧 → 原首帧 的线性渐变），
 *   在**尾部插入 M 帧退场过渡**（原末帧 → idle 中立帧 的线性渐变），
 *   并同步更新 frames.json 的 frames 计数。改完后首帧===idle 中立帧、末帧≈idle 中立帧，
 *   任何渲染路径（含 fade 时长设为 0）都不会再闪。
 *
 * 混色算法：预乘 alpha 线性插值
 *   out.a   = a.a*(1-t) + b.a*t
 *   out.rgb = (a.rgb*a.a*(1-t) + b.rgb*b.a*t) / out.a
 *   直接 source-over 叠加会导致中间帧忽明忽暗，预乘插值可保证亮度守恒。
 *
 * 用法：
 *   node scripts/build-transition-frames.cjs --dry-run        # 只分析、不写文件
 *   node scripts/build-transition-frames.cjs                  # 默认 IN=4 OUT=4 正式写入
 *   node scripts/build-transition-frames.cjs --in=3 --out=3
 *   node scripts/build-transition-frames.cjs --only=nod,excited
 *   node scripts/build-transition-frames.cjs --skin=kirari
 *
 * 注意：会**覆盖**原 sheet 文件。运行前请自行备份（本次已备份到仓库外的
 *       D:/personal-proj/_kirari-sprite-backup-20261011/）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const AVATAR_ROOT = path.join(REPO_ROOT, 'resources', 'official-avatars');

const DEFAULT_SKIN = 'kirari';
// 需要补过渡帧的状态：9 个新动作（差异 > 2.6%）。
// blink/happy/sleepy/speak/wave 与 idle 同批生成、首尾帧本就锚定（差异 0%~2.9%），不处理。
const DEFAULT_TARGETS = [
    'bow', 'excited', 'nod', 'sad', 'shake', 'shy', 'stretch', 'surprised', 'thinking',
];
const RESERVED_KEYS = new Set(['type', 'name', 'author', 'version', 'chatAvatar', 'personality']);

function parseArgs(argv) {
    const opts = { dryRun: false, inN: 4, outN: 4, skin: DEFAULT_SKIN, only: DEFAULT_TARGETS };
    for (const raw of argv) {
        if (raw === '--dry-run') opts.dryRun = true;
        else if (raw.startsWith('--in=')) opts.inN = Math.max(0, parseInt(raw.slice(5), 10) || 0);
        else if (raw.startsWith('--out=')) opts.outN = Math.max(0, parseInt(raw.slice(6), 10) || 0);
        else if (raw.startsWith('--skin=')) opts.skin = raw.slice(7);
        else if (raw.startsWith('--only=')) opts.only = raw.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    }
    return opts;
}

/** 从横向 sprite sheet 里裁出第 index 帧（w*h*4 的 RGBA buffer） */
function extractFrame(png, index, w, h) {
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        const src = (y * png.width + index * w) * 4;
        png.data.copy(out, y * w * 4, src, src + w * 4);
    }
    return out;
}

/** 预乘 alpha 线性插值：t=0 取 a，t=1 取 b */
function lerpFrame(a, b, t) {
    const n = a.length / 4;
    const out = Buffer.alloc(a.length);
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const aa = a[p + 3] / 255;
        const ba = b[p + 3] / 255;
        const oa = aa * (1 - t) + ba * t;
        if (oa <= 0.0001) {
            out[p] = 0; out[p + 1] = 0; out[p + 2] = 0; out[p + 3] = 0;
            continue;
        }
        const pr = a[p] * aa * (1 - t) + b[p] * ba * t;
        const pg = a[p + 1] * aa * (1 - t) + b[p + 1] * ba * t;
        const pb = a[p + 2] * aa * (1 - t) + b[p + 2] * ba * t;
        out[p] = Math.min(255, Math.round(pr / oa));
        out[p + 1] = Math.min(255, Math.round(pg / oa));
        out[p + 2] = Math.min(255, Math.round(pb / oa));
        out[p + 3] = Math.round(oa * 255);
    }
    return out;
}

/** 把若干帧横向拼成一张 PNG buffer */
function buildSheet(frames, w, h) {
    const total = w * frames.length;
    const png = new PNG({ width: total, height: h });
    for (let i = 0; i < frames.length; i++) {
        for (let y = 0; y < h; y++) {
            const src = (y * w) * 4;
            const dst = (y * total + i * w) * 4;
            frames[i].copy(png.data, dst, src, src + w * 4);
        }
    }
    return PNG.sync.write(png);
}

/** 差异像素占比（阈值 Σ|ΔRGBA| > 90），用于自检锚定效果 */
function diffPct(a, b) {
    let hit = 0;
    const n = a.length / 4;
    for (let i = 0; i < n; i++) {
        const p = i * 4;
        const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1])
            + Math.abs(a[p + 2] - b[p + 2]) + Math.abs(a[p + 3] - b[p + 3]);
        if (d > 90) hit++;
    }
    return (hit / n) * 100;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const skinDir = path.join(AVATAR_ROOT, opts.skin);
    const manifestPath = path.join(skinDir, 'frames.json');

    if (!fs.existsSync(manifestPath)) {
        console.error(`[x] 找不到 frames.json: ${manifestPath}`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // 基础态：优先 idle，缺失则取第一个非保留键
    const baseKey = manifest.idle ? 'idle' : Object.keys(manifest).find((k) => !RESERVED_KEYS.has(k));
    if (!baseKey) {
        console.error('[x] 找不到基础态（idle）');
        process.exit(1);
    }
    const baseDef = manifest[baseKey];
    const basePNG = PNG.sync.read(fs.readFileSync(path.join(skinDir, baseDef.sheet)));
    const W = baseDef.frameW;
    const H = baseDef.frameH;
    const anchor = extractFrame(basePNG, 0, W, H); // ← 中立姿势锚点 = idle 第 0 帧

    console.log(`\n皮肤: ${opts.skin}    基准帧: ${baseKey}#0 (${W}x${H})`);
    console.log(`计划: 每状态前插 ${opts.inN} 帧入场 + 后插 ${opts.outN} 帧退场`);
    console.log(opts.dryRun ? '模式: DRY-RUN（不写文件）\n' : '模式: 正式写入\n');
    console.log('状态'.padEnd(12) + '原帧数'.padEnd(9) + '新帧数'.padEnd(9) + '新首帧vs锚点'.padEnd(15) + '新末帧vs锚点');

    const updated = [];
    for (const key of opts.only) {
        const def = manifest[key];
        if (!def || !def.sheet) { console.log(`${key.padEnd(12)}(跳过: 未定义)`); continue; }

        const src = PNG.sync.read(fs.readFileSync(path.join(skinDir, def.sheet)));
        const M = def.frames;
        const avail = Math.floor(src.width / W);
        if (avail < M) { console.log(`${key.padEnd(12)}(跳过: 表宽不足 ${avail} < ${M})`); continue; }

        const getF = (i) => extractFrame(src, i, W, H);
        const first = getF(0);
        const last = getF(M - 1);

        // 幂等保护：首帧已等于锚点 → 这张表已经插过过渡帧了。
        // 若重复执行会把过渡帧再叠一层，动作越拉越长。
        if (diffPct(first, anchor) < 0.01) {
            console.log(`${key.padEnd(12)}(跳过: 首帧已锚定，疑似已处理过)`);
            continue;
        }

        const frames = [];
        // 入场：t = 0, 1/(IN+1), ..., (IN-1)/(IN+1) —— 首帧 t=0 即完全等于锚点
        for (let i = 0; i < opts.inN; i++) frames.push(lerpFrame(anchor, first, i / (opts.inN + 1)));
        // 原帧
        for (let i = 0; i < M; i++) frames.push(getF(i));
        // 退场：t = 1/(OUT+1) ... OUT/(OUT+1) —— 末帧 t=OUT/(OUT+1)，未到 1（1 就是锚点本身）
        for (let i = 0; i < opts.outN; i++) frames.push(lerpFrame(last, anchor, (i + 1) / (opts.outN + 1)));

        const pctIn = diffPct(frames[0], anchor);
        const pctOut = diffPct(frames[frames.length - 1], anchor);

        if (!opts.dryRun) {
            fs.writeFileSync(path.join(skinDir, def.sheet), buildSheet(frames, W, H));
            def.frames = frames.length;
            updated.push(key);
        }
        console.log(
            key.padEnd(12) + String(M).padEnd(9) + String(frames.length).padEnd(9)
            + (pctIn.toFixed(2) + '%').padEnd(15) + pctOut.toFixed(2) + '%'
            + `   (+${opts.inN + opts.outN} 帧 ≈ +${Math.round((opts.inN + opts.outN) / def.fps * 1000)}ms)`,
        );
    }

    if (!opts.dryRun && updated.length) {
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        console.log(`\n[ok] 已写入 ${updated.length} 张 sheet + frames.json`);
    } else if (opts.dryRun) {
        console.log('\n[dry-run] 未改动任何文件');
    }
}

main();
