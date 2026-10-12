// electron/model-config.ts
// 模型配置文件（config.json）的读写与实时监听。
// 该文件是「用户级可编辑配置文件」：用户可手动用文本编辑器修改，
// 程序通过 fs.watch 监听变更并同步到后端、广播给已打开的设置窗口。
import fs from "fs";
import path from "path";
import { app } from "electron";

export interface ModelProfile {
    id: number;
    /** 用户起的名字（如「便宜快档」「高质量档」） */
    name: string;
    endpoint: string;
    model: string;
    key: string;
}

export interface ModelConfigFile {
    endpoint?: string;
    model?: string;
    key?: string;
    searchKey?: string;
    searchEndpoint?: string;
    searchProvider?: string; // 'uapis' | 'tavily' | 'searxng'
    basePersona?: string; // 用户自定义基础人格（自由文字）；缺省/空则后端回退到预设人格
    seeded?: boolean;
    /**
     * 多模型：用户自己保存的多套「地址 + 型号 + 钥匙」。
     *
     * 语义（与核心版控制台一致）：**顶层 endpoint/model/key 才是「当前生效」**——
     * 引擎、聊天、组网同步读的都是它们，所以这套设计对内核零改动。
     * 「设为当前」= 把某一套覆盖到顶层字段并记下 activeModelId。
     * 用户手改 config.json 的顶层字段仍然有效（models 列表不受影响）。
     */
    models?: ModelProfile[];
    activeModelId?: number;
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
        // k 是 keyof 联合，直接索引赋值时 TS 会把目标类型收成所有字段的交集
        // （string & boolean & undefined → undefined），只能显式断言。
        if (v.trim() !== "") (next as Record<string, string>)[k] = v.trim();
        else delete (next as Partial<ModelConfigFile>)[k];
    }
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
    } catch (e) {
        console.warn("[model-config] 写入 config.json 失败:", e instanceof Error ? e.message : String(e));
        return next;
    }
    if (changeCallbacks.length > 0) notifyChange();
    return next;
}

// ── 多模型（models 列表 + 激活）────────────────────────────────
// 与核心版控制台同一套语义。写盘直接用 writeModelConfigFile（它按字段合并，
// models/activeModelId 不在 patch 里就不会被动）。

/** 外部编辑可能把 models 搞坏：形状不对就当没有（懒自愈，不报错）。 */
function safeModels(cfg: ModelConfigFile): ModelProfile[] {
    return Array.isArray(cfg.models) ? cfg.models.filter((m) => m && typeof m === "object" && typeof m.id === "number") : [];
}

function maskOf(key: string): string {
    if (!key) return "";
    if (key.length <= 6) return "****";
    return `${key.slice(0, 3)}${"*".repeat(6)}${key.slice(-4)}`;
}

export type ModelListItem = {
    id: number;
    name: string;
    endpoint: string;
    model: string;
    keyMasked: string;
    hasKey: boolean;
};

/**
 * 列出已保存的模型套 + 当前使用 id。
 * 懒迁移：列表为空但顶层已配好（老用户）→ 自动导成「默认」套并设为当前。
 */
export function listModelProfiles(): { items: ModelListItem[]; activeId: number | null } {
    const cfg = readModelConfigFile();
    let models = safeModels(cfg);
    let activeId = typeof cfg.activeModelId === "number" ? cfg.activeModelId : null;
    if (models.length === 0 && cfg.key && cfg.model && cfg.endpoint) {
        // 懒迁移：老用户只有顶层单套配置 → 导成「默认」套并设为当前（行为零变化）
        const migrated: ModelProfile = {
            id: 1,
            name: "默认",
            endpoint: cfg.endpoint,
            model: cfg.model,
            key: cfg.key,
        };
        const next: ModelConfigFile = { ...cfg, models: [migrated], activeModelId: 1 };
        writeConfig(next);
        models = [migrated];
        // ⚠️ activeId 不能再读迁移前的 cfg（那时还没有 activeModelId），
        // 否则迁移后第一次调用返回 null，UI 上「使用中」徽标凭空消失。
        activeId = 1;
    }
    return {
        items: models.map((m) => ({
            id: m.id,
            name: m.name,
            endpoint: m.endpoint,
            model: m.model,
            keyMasked: maskOf(m.key),
            hasKey: !!m.key,
        })),
        activeId,
    };
}

type ChangeCallback = (cfg: ModelConfigFile) => void;
const changeCallbacks: ChangeCallback[] = [];
let watchHandle: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
// 最近一次已通知的配置快照：程序自己写盘后 fs.watch 也会响，
// 用它去重，保证「一次变更只通知一次」；外部编辑器改动不在快照里，照常实时同步。
let lastNotifiedJson = "";

/** 程序写盘后主动通知（与核心版 writeRaw→notify 同一模式）：不依赖 fs.watch，时序确定。 */
function notifyChange(): void {
    const cfg = readModelConfigFile();
    lastNotifiedJson = JSON.stringify(cfg);
    for (const cb of changeCallbacks) {
        try {
            cb(cfg);
        } catch (e) {
            console.warn("[model-config] 变更回调出错:", e instanceof Error ? e.message : String(e));
        }
    }
}

/** 内部：整体写回 config.json（保留无关字段），并主动通知变更。 */
function writeConfig(next: ModelConfigFile): void {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
    } catch (e) {
        console.warn("[model-config] 写入 config.json 失败:", e instanceof Error ? e.message : String(e));
        return;
    }
    if (changeCallbacks.length > 0) notifyChange();
}

export function addModelProfile(p: { name: string; endpoint: string; model: string; key: string }): number {
    const cfg = readModelConfigFile();
    const models = safeModels(cfg);
    // id 取当前最大 +1。注意：如果删掉的恰好是最大 id，下一个新增会复用这个号
    // （实践中无害：activeModelId 在删除时已同步清理，不存在指向已删套的旧引用）。
    const id = models.reduce((max, m) => Math.max(max, m.id), 0) + 1;
    const profile: ModelProfile = {
        id,
        name: p.name.trim().slice(0, 40),
        endpoint: p.endpoint.trim(),
        model: p.model.trim(),
        key: p.key.trim(),
    };
    const next: ModelConfigFile = { ...cfg, models: [...models, profile] };
    // 第一套自动成为当前使用（没有当前套就没法聊天）
    if (typeof next.activeModelId !== "number" || !models.some((m) => m.id === next.activeModelId)) {
        next.activeModelId = id;
        next.endpoint = profile.endpoint;
        next.model = profile.model;
        next.key = profile.key;
    }
    writeConfig(next);
    return id;
}

/**
 * 更新一套。key 传空串/undefined = 保持原值。
 * 编辑的正是「当前使用」那一套时，顶层生效字段（endpoint/model/key）必须跟着同步——
 * 否则界面写「已保存，立即生效」、引擎读的还是旧值（聊天继续用旧配置，连接状态也不更新）。
 * 返回写盘后的完整配置（调用方无需再读一次）；那一套不存在时返回 null。
 */
export function updateModelProfile(
    id: number,
    patch: { name?: string; endpoint?: string; model?: string; key?: string },
): ModelConfigFile | null {
    const cfg = readModelConfigFile();
    const models = safeModels(cfg);
    const cur = models.find((m) => m.id === id);
    if (!cur) return null;
    const merged: ModelProfile = {
        ...cur,
        name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim().slice(0, 40) : cur.name,
        endpoint: typeof patch.endpoint === "string" && patch.endpoint.trim() ? patch.endpoint.trim() : cur.endpoint,
        model: typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : cur.model,
        key: typeof patch.key === "string" && patch.key.trim() ? patch.key.trim() : cur.key,
    };
    const next: ModelConfigFile = {
        ...cfg,
        models: models.map((m) => (m.id === id ? merged : m)),
    };
    if (next.activeModelId === id) {
        next.endpoint = merged.endpoint;
        next.model = merged.model;
        next.key = merged.key;
    }
    writeConfig(next);
    return next;
}

export function deleteModelProfile(id: number): boolean {
    const cfg = readModelConfigFile();
    const models = safeModels(cfg);
    if (!models.some((m) => m.id === id)) return false;
    const next: ModelConfigFile = { ...cfg, models: models.filter((m) => m.id !== id) };
    // ⚠️ 删除前判断是不是当前套：删完 activeId 指向不存在的套，读取方会当成没选
    if (next.activeModelId === id) {
        // 当前套删掉：顶层字段保持不动（聊天还能用），activeId 置空直到用户再选
        delete next.activeModelId;
    }
    writeConfig(next);
    return true;
}

/**
 * 「设为当前」：把那一套覆盖到顶层生效字段，记下 activeModelId。
 * 返回新的完整配置 —— 调用方（main.ts）拿去走 handleModelConfigChanged，
 * 引擎按配置指纹自动重建上下文，下一条消息就用新套。
 */
export function activateModelProfile(id: number): ModelConfigFile | null {
    const cfg = readModelConfigFile();
    const target = safeModels(cfg).find((m) => m.id === id);
    if (!target) return null;
    const next: ModelConfigFile = {
        ...cfg,
        endpoint: target.endpoint,
        model: target.model,
        key: target.key,
        activeModelId: id,
    };
    writeConfig(next);
    return next;
}

// （ChangeCallback / changeCallbacks / watchHandle / debounceTimer / notifyChange
//   等变更通知基建统一声明在文件中部 writeConfig 附近，此处不再重复。）

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
                // 程序自己的写盘已经主动通知过了（见 writeConfig/writeModelConfigFile），
                // 这里只处理「外部编辑器改动」：快照一致说明没有外部变化，跳过。
                if (JSON.stringify(cfg) === lastNotifiedJson) return;
                notifyChange();
            }, 200);
        });
        watchHandle.on("error", (e) => {
            console.warn("[model-config] 监听 config.json 出错（外部编辑可能不会实时同步）:", e instanceof Error ? e.message : String(e));
        });
    } catch (e) {
        console.warn("[model-config] 无法监听 config.json（外部编辑不会实时同步）:", e instanceof Error ? e.message : String(e));
    }
}
