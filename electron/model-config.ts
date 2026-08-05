// electron/model-config.ts
// 模型配置文件（config.json）的读写与实时监听。
// 该文件是「用户级可编辑配置文件」：用户可手动用文本编辑器修改，
// 程序通过 fs.watch 监听变更并同步到后端、广播给已打开的设置窗口。
import fs from "fs";
import path from "path";
import { app } from "electron";

export interface ModelConfigFile {
    endpoint?: string;
    model?: string;
    key?: string;
    searchKey?: string;
    searchEndpoint?: string;
    searchProvider?: string; // 'uapis' | 'tavily' | 'searxng'
    basePersona?: string; // 用户自定义基础人格（自由文字）；缺省/空则后端回退到预设人格
    seeded?: boolean;
}

const CONFIG_FILE = path.join(app.getPath("userData"), "config.json");

export function getModelConfigPath(): string {
    return CONFIG_FILE;
}

export function readModelConfigFile(): ModelConfigFile {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return {};
        const obj = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
        return obj && typeof obj === "object" ? (obj as ModelConfigFile) : {};
    } catch {
        return {};
    }
}

export function writeModelConfigFile(patch: Partial<ModelConfigFile>): ModelConfigFile {
    const current = readModelConfigFile();
    // 合并规则：
    //  - 未提供（undefined）的字段：不动现有值，避免 { ...current, model: undefined }
    //    把用户未改动的配置无声清空（JSON.stringify 会丢弃 undefined 的 key）。
    //  - 非空字符串：写入（trim 后）。
    //  - 空字符串：显式删除该字段（用于「恢复预设」等清空场景，如 basePersona）。
    const next: ModelConfigFile = { ...current };
    for (const k of Object.keys(patch) as (keyof ModelConfigFile)[]) {
        const v = patch[k];
        if (typeof v !== "string") continue;
        if (v.trim() !== "") next[k] = v.trim();
        else delete (next as Partial<ModelConfigFile>)[k];
    }
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
    } catch (e) {
        console.warn("[model-config] 写入 config.json 失败:", e instanceof Error ? e.message : String(e));
    }
    return next;
}

type ChangeCallback = (cfg: ModelConfigFile) => void;
const changeCallbacks: ChangeCallback[] = [];
let watchHandle: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function onModelConfigChanged(cb: ChangeCallback): void {
    changeCallbacks.push(cb);
}

// 启动对 config.json 的监听：用户用外部编辑器修改文件后，触发回调（同步后端 + 广播前端）。
export function startModelConfigWatch(): void {
    if (watchHandle) return;
    try {
        watchHandle = fs.watch(CONFIG_FILE, () => {
            // 某些平台会连续触发多次，做一次去抖
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const cfg = readModelConfigFile();
                for (const cb of changeCallbacks) {
                    try {
                        cb(cfg);
                    } catch (e) {
                        console.warn("[model-config] 监听回调出错:", e instanceof Error ? e.message : String(e));
                    }
                }
            }, 200);
        });
        watchHandle.on("error", (e) => {
            console.warn("[model-config] 监听 config.json 出错（外部编辑可能不会实时同步）:", e instanceof Error ? e.message : String(e));
        });
    } catch (e) {
        console.warn("[model-config] 无法监听 config.json（外部编辑不会实时同步）:", e instanceof Error ? e.message : String(e));
    }
}
