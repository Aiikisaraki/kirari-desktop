// electron/voice/voiceLibrary.ts
//
// 音色库下载与管理（桌宠端主进程）。
//
// 与扩展包的分工：sidecar 只负责「合成」，不管下载 —— 下载要写文件、要跑进度、
// 要能取消，放在宿主侧更合适。下载完成后 sidecar 的 listVoices 会自动发现新库
//（它每次都重新扫描 voices/ 目录，无缓存）。
//
// 下载细节（都是踩过坑的）：
//   · GitHub release 302 到 objects.githubusercontent.com，fetch 自动跟随
//   · 下载写 .tmp- 临时文件，校验 tar.bz2 魔数（BZh）后解压、原子改名 ——
//     断电/断网不会留半个坏库
//   · tar.bz2 用系统 bsdtar（Win10+ 自带），不引额外依赖

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { getExtensionHost } from "../extensions";

/** 与 kirari-ext-voice/voices.catalog.json 同一份清单。 */
const CATALOG: VoiceLibInfo[] = [
    {
        id: "aishell3",
        name: "AISHELL3 · 174 个中文音色",
        sizeBytes: 31559701,
        archive: "vits-icefall-zh-aishell3.tar.bz2",
        sources: [
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2",
            "https://hf-mirror.com/k2-fsa/sherpa-onnx/resolve/main/tts-models/vits-icefall-zh-aishell3.tar.bz2",
        ],
        license: "模型基于 AISHELL3 数据集（Apache 2.0）；引擎 Apache-2.0",
        description: "多说话人中文语音库，男女声都有，换音色不换模型。",
    },
    {
        id: "huayan",
        name: "花燕 · 单音色女声",
        sizeBytes: 67217000,
        archive: "vits-piper-zh_CN-huayan-medium.tar.bz2",
        sources: [
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-huayan-medium.tar.bz2",
            "https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
        ],
        license: "模型训练集许可未明确（HuaYan TTS），个人使用无碍，商用前自行确认",
        description: "Piper 中文女声，自然度不错，但只有这一个音色。",
    },
];

export interface VoiceLibInfo {
    id: string;
    name: string;
    sizeBytes: number;
    archive: string;
    /** 依次尝试的下载地址；第一个失败自动换下一个 */
    sources: string[];
    license: string;
    description: string;
}

export interface VoiceLibStatus extends VoiceLibInfo {
    /** 本地是否已安装（voices/<id> 存在且有 .onnx） */
    installed: boolean;
    installedBytes?: number;
    /** 手动放置（不在清单里）的库 */
    manual?: boolean;
}

/** 正在进行的下载（每包同一时间只允许一个） */
interface ActiveDownload {
    packId: string;
    libId: string;
    cancelled: boolean;
}

const activeDownloads = new Map<string, ActiveDownload>();
/** 最近一条进度消息（IPC 轮询用，不做推送） */
let lastProgress = "";

const DEFAULT_PACK = "com.akisaki.voice.aishell3";

/** 语音包根目录（voices/ 所在处）。 */
async function resolvePackDir(packId = DEFAULT_PACK): Promise<string | null> {
    const host = getExtensionHost();
    if (!host) return null;
    const found = await host.scan();
    const hit = found.find((f) => f.manifest.id === packId && !f.error);
    return hit ? hit.dir : null;
}

function dirSize(dir: string): number {
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) total += dirSize(p);
        else total += fs.statSync(p).size;
    }
    return total;
}

/** 列出：内置清单 ∪ 手动放置的库，各自标 installed。 */
export async function listVoiceLibs(): Promise<VoiceLibStatus[]> {
    const packDir = await resolvePackDir();
    const voicesDir = packDir ? path.join(packDir, "voices") : null;
    const installed = new Set<string>();
    if (voicesDir && fs.existsSync(voicesDir)) {
        for (const e of fs.readdirSync(voicesDir, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            if (e.name.startsWith(".tmp-")) continue; // 下载中的临时目录不算
            const dir = path.join(voicesDir, e.name);
            try {
                if (fs.readdirSync(dir).some((f) => f.endsWith(".onnx"))) installed.add(e.name);
            } catch { /* 目录刚好被删 */ }
        }
    }

    const out: VoiceLibStatus[] = [];
    for (const lib of CATALOG) {
        const isInstalled = installed.has(lib.id);
        installed.delete(lib.id);
        out.push({
            ...lib,
            installed: isInstalled,
            ...(isInstalled && voicesDir ? { installedBytes: dirSize(path.join(voicesDir, lib.id)) } : {}),
        });
    }
    // 剩下的是手动放置的库
    for (const id of installed) {
        out.push({
            id,
            name: id + "（手动放置）",
            sizeBytes: 0,
            archive: "",
            sources: [],
            license: "",
            description: "本地手动放入的音色库",
            installed: true,
            manual: true,
            installedBytes: voicesDir ? dirSize(path.join(voicesDir, id)) : 0,
        });
    }
    return out;
}

/** 当前下载进度（给 IPC 轮询用）。 */
export function getVoiceDownloadProgress(): string {
    return lastProgress;
}

export function cancelVoiceDownload(libId: string): boolean {
    const active = activeDownloads.get(DEFAULT_PACK + "/" + libId);
    if (!active) return false;
    active.cancelled = true;
    return true;
}

/**
 * 下载一个音色库到 <pack>/voices/<libId>。
 * 成功后 sidecar 下次 listVoices 自动发现（无缓存），不需要重启。
 */
export async function downloadVoiceLib(
    libId: string,
    opts?: { onProgress?: (msg: string) => void },
): Promise<{ ok: boolean; error?: string }> {
    const key = DEFAULT_PACK + "/" + libId;
    if (activeDownloads.has(key)) return { ok: false, error: "这个音色库已经在下载中了" };
    const lib = CATALOG.find((l) => l.id === libId);
    if (!lib) return { ok: false, error: "清单里没有这个音色库：" + libId };

    const packDir = await resolvePackDir();
    if (!packDir) return { ok: false, error: "语音扩展包未安装" };

    const voicesDir = path.join(packDir, "voices");
    const targetDir = path.join(voicesDir, libId);
    try {
        if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).some((f) => f.endsWith(".onnx"))) {
            return { ok: false, error: "这个音色库已经安装了" };
        }
    } catch { /* 目录不存在，继续 */ }

    fs.mkdirSync(voicesDir, { recursive: true });
    const tmpArchive = path.join(voicesDir, ".tmp-" + libId + "-" + Date.now() + ".tar.bz2");
    const active: ActiveDownload = { packId: DEFAULT_PACK, libId, cancelled: false };
    activeDownloads.set(key, active);

    const report = (msg: string) => {
        lastProgress = msg;
        opts?.onProgress?.(msg);
    };

    try {
        let ok = false;
        let lastErr = "";
        for (const url of lib.sources) {
            if (active.cancelled) return { ok: false, error: "已取消" };
            try {
                report("连接 " + new URL(url).host + "…");
                const res = await fetch(url, { redirect: "follow" });
                if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
                const total = Number(res.headers.get("content-length") || lib.sizeBytes);
                const reader = res.body.getReader();
                const chunks: Buffer[] = [];
                let downloaded = 0;
                let lastPct = -1;
                for (;;) {
                    if (active.cancelled) {
                        await reader.cancel();
                        return { ok: false, error: "已取消" };
                    }
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(Buffer.from(value));
                    downloaded += value.byteLength;
                    if (total > 0) {
                        const pct = Math.floor((downloaded / total) * 100);
                        if (pct !== lastPct) {
                            lastPct = pct;
                            report("下载 " + pct + "%（" + (downloaded / 1024 / 1024).toFixed(1) + "MB）");
                        }
                    }
                }
                const buf = Buffer.concat(chunks);
                if (buf.length < 1024 * 1024) throw new Error("下载不完整（" + buf.length + " 字节）");
                // 校验 tar.bz2 魔数：BZh
                if (buf.toString("ascii", 0, 3) !== "BZh") throw new Error("不是合法的 tar.bz2 文件");
                fs.writeFileSync(tmpArchive, buf);
                ok = true;
                break;
            } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e);
                console.warn("[voice] 源失败 " + url + "：" + lastErr + "，尝试下一个");
            }
        }
        if (!ok) return { ok: false, error: "下载失败：" + lastErr };

        // 解压（系统 bsdtar）
        report("解压中…");
        const tmpExtract = path.join(voicesDir, ".tmp-" + libId + "-x");
        fs.rmSync(tmpExtract, { recursive: true, force: true });
        fs.mkdirSync(tmpExtract, { recursive: true });
        const extractCode = await new Promise<number>((resolve) => {
            const ex = spawn("tar", ["-xjf", tmpArchive, "-C", tmpExtract], { windowsHide: true });
            ex.on("close", (code) => resolve(code ?? -1));
            ex.on("error", () => resolve(-1));
        });
        if (extractCode !== 0) {
            fs.rmSync(tmpExtract, { recursive: true, force: true });
            return { ok: false, error: "解压失败（exit " + extractCode + "）" };
        }

        // 归档里可能带一层目录，归一化成 voices/<libId>/
        const inner = fs.readdirSync(tmpExtract, { withFileTypes: true });
        const subDirs = inner.filter((e) => e.isDirectory());
        const sourceDir = subDirs.length === 1 ? path.join(tmpExtract, subDirs[0].name) : tmpExtract;
        if (!fs.readdirSync(sourceDir).some((f) => f.endsWith(".onnx"))) {
            fs.rmSync(tmpExtract, { recursive: true, force: true });
            return { ok: false, error: "解压后没找到 .onnx 模型文件" };
        }

        // 原子落地
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(sourceDir, targetDir);
        fs.rmSync(tmpExtract, { recursive: true, force: true });
        fs.rmSync(tmpArchive, { force: true });
        report("完成");
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
        activeDownloads.delete(key);
        try { fs.rmSync(tmpArchive, { force: true }); } catch { /* 已清理 */ }
    }
}

/** 删除一个已安装的音色库（手动放置的也允许删）。 */
export async function removeVoiceLib(libId: string): Promise<{ ok: boolean; error?: string }> {
    if (libId.includes("..") || path.isAbsolute(libId)) return { ok: false, error: "非法的库 id" };
    const packDir = await resolvePackDir();
    if (!packDir) return { ok: false, error: "语音扩展包未安装" };
    const target = path.join(packDir, "voices", libId);
    if (!fs.existsSync(target)) return { ok: false, error: "这个音色库不存在" };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
}

/** 打开音色库目录（资源管理器），方便手动放置。 */
export async function openVoicesFolder(): Promise<boolean> {
    const packDir = await resolvePackDir();
    if (!packDir) return false;
    const dir = path.join(packDir, "voices");
    fs.mkdirSync(dir, { recursive: true });
    const { shell } = await import("electron");
    shell.openPath(dir);
    return true;
}
