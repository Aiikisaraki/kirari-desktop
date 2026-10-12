#!/usr/bin/env node
/**
 * 动作精灵表色彩校准脚本
 *
 * 问题背景：
 *   各动作精灵表与基础态(idle)的**整体色彩基调**不一致 —— 实测动作普遍比 idle
 *   亮 4~9 个单位、饱和度低 2~4 个单位（idle 自身帧间波动仅 2.5，属正常呼吸光照）。
 *   切换到待机时画面整体明暗/色调瞬变，视觉上就是"闪一下"，与姿势无关。
 *   注意：这类"全局偏移"用逐像素高阈值差异（Σ|ΔRGBA|>90）是**量不出来**的
 *   （均匀偏 7 个单位时每像素只差 21，远达不到阈值），必须用均值/饱和度来度量。
 *
 * 本脚本做的事：
 *   以基础态为基准，对每个动作表施加一个**全局**色彩变换：
 *     ① 加性平移，把状态的角色区 RGB 均值对齐到基准（修正亮度与色调偏移）
 *     ② 饱和度缩放（绕亮度轴），把饱和度均值对齐到基准
 *   变换对整张表统一施加 —— 保留动作内部固有的明暗变化，只拉平整体基调。
 *
 * ⚠️ 执行顺序：必须在 build-transition-frames.cjs **之前**运行。
 *    否则插入的过渡帧会基于未校准的颜色生成，校准后反而在入场处产生新的色阶。
 *      正确流程：恢复原始表 → color-match-frames.cjs → build-transition-frames.cjs
 *
 * 幂等保护：若某状态的 RGB 偏移已小于阈值（默认 0.5），判定为已校准并跳过。
 *
 * 用法：
 *   node scripts/color-match-frames.cjs --dry-run          # 只分析
 *   node scripts/color-match-frames.cjs                    # 正式写入
 *   node scripts/color-match-frames.cjs --no-saturation    # 只做亮度/色调对齐
 *   node scripts/color-match-frames.cjs --only=nod,excited
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const AVATAR_ROOT = path.join(REPO_ROOT, 'resources', 'official-avatars');

const DEFAULT_SKIN = 'kirari';
const DEFAULT_TARGET = 'idle';
const RESERVED_KEYS = new Set(['type', 'name', 'author', 'version', 'chatAvatar', 'personality']);
// 统计只用"实体像素"，避免抗锯齿边缘拉偏均值
const SOLID_ALPHA = 64;
// 幂等阈值：RGB 偏移小于它就认为已对齐
const IDEMPOTENT_EPS = 0.5;

function parseArgs(argv) {
    const opts = { dryRun: false, saturation: true, skin: DEFAULT_SKIN, target: DEFAULT_TARGET, only: null };
    for (const raw of argv) {
        if (raw === '--dry-run') opts.dryRun = true;
        else if (raw === '--no-saturation') opts.saturation = false;
        else if (raw.startsWith('--skin=')) opts.skin = raw.slice(7);
        else if (raw.startsWith('--target=')) opts.target = raw.slice(9);
        else if (raw.startsWith('--only=')) opts.only = raw.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    }
    return opts;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 统计一张表在"角色实心区"的 RGB 均值与饱和度均值（alpha > SOLID_ALPHA 的像素） */
function measure(png, frames, W, H) {
    let r = 0, g = 0, b = 0, n = 0, satSum = 0;
    for (let i = 0; i < frames; i++) {
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const o = (y * png.width + i * W + x) * 4;
                if (png.data[o + 3] <= SOLID_ALPHA) continue;
                const R = png.data[o], G = png.data[o + 1], B = png.data[o + 2];
                r += R; g += G; b += B; n++;
                const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
                satSum += mx ? ((mx - mn) / mx) * 100 : 0;
            }
        }
    }
    if (!n) return null;
    return { r: r / n, g: g / n, b: b / n, sat: satSum / n, luma: luma(r / n, g / n, b / n) };
}

/**
 * ① 逐帧加性平移：让**每一帧**的角色区 RGB 均值都对齐到基准。
 *
 * 为什么必须逐帧、而不是整表一个偏移量：各表的"帧间亮度起伏"与 idle 不同。
 * 实测 wave 整表平均偏亮 6.2，但它的**末帧只偏亮 1.7** —— 若整表统一减 6.2，
 * 会把本来已经对齐的末帧压暗成 -4.5，切换瞬间反而更闪（happy 同理）。
 * 逐帧对齐后，任何一帧切到 idle 都是零色差。
 * 代价是抹掉动作内部原本不大的整体明暗起伏（实测 1.7~4.5，与 idle 自身呼吸
 * 抖动 2.55 同级），肉眼不可辨，换来的是切换零跳变。
 */
function applyOffsetPerFrame(png, frames, W, H, target) {
    const MIN_PIXELS = 200; // 实体像素太少的帧均值不稳，跳过
    // 第一遍：算每帧的角色区 RGB 均值
    const means = [];
    for (let i = 0; i < frames; i++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const o = (y * png.width + i * W + x) * 4;
                if (png.data[o + 3] <= SOLID_ALPHA) continue;
                r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++;
            }
        }
        means.push(n >= MIN_PIXELS ? { r: r / n, g: g / n, b: b / n } : null);
    }
    // 第二遍：逐帧施加各自需要的偏移
    for (let i = 0; i < frames; i++) {
        const m = means[i];
        if (!m) continue;
        const dR = target.r - m.r, dG = target.g - m.g, dB = target.b - m.b;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const o = (y * png.width + i * W + x) * 4;
                if (png.data[o + 3] === 0) continue;
                png.data[o] = clamp255(png.data[o] + dR);
                png.data[o + 1] = clamp255(png.data[o + 1] + dG);
                png.data[o + 2] = clamp255(png.data[o + 2] + dB);
            }
        }
    }
}

/**
 * ② 逐帧饱和度缩放：绕亮度轴缩放色度，以 luma 为轴心保证亮度不被改动。
 * 同样逐帧计算系数，让每一帧的饱和度都对到基准。
 * k 限制在 [0.89, 1.12]，避免把刻意的高/低饱和表现抹平。
 * 返回平均系数（用于日志显示）。
 */
function applySaturationPerFrame(png, frames, W, H, targetSat) {
    const MIN_PIXELS = 200;
    let kSum = 0, kCnt = 0;
    for (let i = 0; i < frames; i++) {
        // 第一遍：算本帧饱和度
        let sat = 0, n = 0;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const o = (y * png.width + i * W + x) * 4;
                if (png.data[o + 3] <= SOLID_ALPHA) continue;
                const mx = Math.max(png.data[o], png.data[o + 1], png.data[o + 2]);
                const mn = Math.min(png.data[o], png.data[o + 1], png.data[o + 2]);
                sat += mx ? ((mx - mn) / mx) * 100 : 0;
                n++;
            }
        }
        if (n < MIN_PIXELS || sat / n <= 0.01) continue;
        let k = targetSat / (sat / n);
        if (k > 1.12) k = 1.12;
        if (k < 0.89) k = 0.89;
        if (Math.abs(k - 1) < 0.005) continue;
        kSum += k; kCnt++;
        // 第二遍：应用
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const o = (y * png.width + i * W + x) * 4;
                if (png.data[o + 3] === 0) continue;
                const R = png.data[o], G = png.data[o + 1], B = png.data[o + 2];
                const L = luma(R, G, B);
                png.data[o] = clamp255(L + (R - L) * k);
                png.data[o + 1] = clamp255(L + (G - L) * k);
                png.data[o + 2] = clamp255(L + (B - L) * k);
            }
        }
    }
    return kCnt ? kSum / kCnt : 1;
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

    const targetKey = opts.target;
    const tgtDef = manifest[targetKey];
    if (!tgtDef) {
        console.error(`[x] 找不到基准状态: ${targetKey}`);
        process.exit(1);
    }
    const W = tgtDef.frameW, H = tgtDef.frameH;

    // —— 基准态统计 ——
    const tgtPNG = PNG.sync.read(fs.readFileSync(path.join(skinDir, tgtDef.sheet)));
    const base = measure(tgtPNG, tgtDef.frames, W, H);
    console.log(`\n皮肤: ${opts.skin}    基准: ${targetKey}`);
    console.log(`  基准色  R${base.r.toFixed(1)} G${base.g.toFixed(1)} B${base.b.toFixed(1)}  亮度${base.luma.toFixed(2)}  饱和${base.sat.toFixed(2)}`);
    console.log(opts.dryRun ? '模式: DRY-RUN（不写文件）\n' : '模式: 正式写入\n');
    console.log('状态'.padEnd(12) + 'Δ亮度(前)'.padEnd(11) + 'Δ饱和(前)'.padEnd(11) + '色彩偏移(R,G,B)'.padEnd(20) + '饱和系数'.padEnd(10) + '动作');

    const keys = Object.keys(manifest).filter((k) => !RESERVED_KEYS.has(k) && k !== targetKey);
    const targets = opts.only ? keys.filter((k) => opts.only.includes(k)) : keys;

    let changed = 0;
    for (const key of targets) {
        const def = manifest[key];
        if (!def || !def.sheet) continue;
        const file = path.join(skinDir, def.sheet);
        if (!fs.existsSync(file)) { console.log(`${key.padEnd(12)}(跳过: 缺文件)`); continue; }

        const png = PNG.sync.read(fs.readFileSync(file));
        const st = measure(png, def.frames, W, H);
        if (!st) { console.log(`${key.padEnd(12)}(跳过: 无实体像素)`); continue; }

        const dR = base.r - st.r, dG = base.g - st.g, dB = base.b - st.b;
        const dL = base.luma - st.luma, dS = base.sat - st.sat;
        const mag = Math.abs(dR) + Math.abs(dG) + Math.abs(dB);

        if (mag < IDEMPOTENT_EPS * 3) {
            console.log(`${key.padEnd(12)}${'—'.padEnd(11)}${'—'.padEnd(11)}${'—'.padEnd(20)}${'—'.padEnd(10)}✅ 已对齐，跳过`);
            continue;
        }

        applyOffsetPerFrame(png, def.frames, W, H, base);
        const k = opts.saturation
            ? applySaturationPerFrame(png, def.frames, W, H, base.sat)
            : 1;

        if (!opts.dryRun) fs.writeFileSync(file, PNG.sync.write(png));
        changed++;
        const f = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
        console.log(
            key.padEnd(12)
            + f(dL).padEnd(11)
            + f(dS).padEnd(11)
            + `${f(dR)},${f(dG)},${f(dB)}`.padEnd(20)
            + k.toFixed(3).padEnd(10)
            + (opts.dryRun ? '(dry)' : 'ok'),
        );
    }
    console.log(`\n${opts.dryRun ? '[dry-run] 未改动文件' : `[ok] 已校准 ${changed} 张表`}`);
    if (!opts.dryRun && changed) {
        console.log('→ 下一步请执行: node scripts/build-transition-frames.cjs');
    }
}

main();
