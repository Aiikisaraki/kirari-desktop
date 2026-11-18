// electron/model-config.ts
// 模型配置文件（config.json）的读写与实时监听。
// 该文件是「用户级可编辑配置文件」：用户可手动用文本编辑器修改，
// 程序通过 fs.watch 监听变更并同步到后端、广播给已打开的设置窗口。
import fs from "fs";
// AgentProfile：默认常量只在首次补写时用一次；运行期读取一律走 parseAgentProfile 严格校验，
// 缺字段 / 坏值显式报错，不静默回退默认值（与核心版同构，两端同一份内核）。
import {
    parseAgentProfile,
    DEFAULT_AGENT_PROFILE,
    type AgentProfile,
} from "kirari-agent";
// 数据根布局真源：config.json 落 ~/.kirari/config.json（与核心版同一份 LAYOUT）。
import { homePath } from "./kirari-home";
import * as modelsFile from "./models/modelsFile";

export interface ModelProfile {
    id: number;
    /** 用户起的名字（如「便宜快档」「高质量档」） */
    name: string;
    endpoint: string;
    model: string;
    key: string;
    /**
     * 索引签名：models.json 里还会带 WorkBuddy 的能力位（vendor / supportsToolCall /
     * supportsImages / supportsReasoning / reasoning / useCustomProtocol）以及用户手写
     * 的私有字段。这些字段 Kirari 不解释，但读写时必须原样保留，所以允许挂载。
     */
    [key: string]: unknown;
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
     * ⚠️ v0.8.3 起模型清单搬到独立的 models.json（见 models/modelsFile.ts），
     * 这里只保留 `models` 是为了**读旧配置做一次迁移**；新代码一律走
     * readModels()/writeModels()，不要再往 config.json 写 models。
     *
     * 语义（与核心版控制台一致）：**顶层 endpoint/model/key 才是「当前生效」**——
     * 引擎、聊天、组网同步读的都是它们，所以这套设计对内核零改动。
     * 「设为当前」= 把某一套覆盖到顶层字段并记下 activeModelId。
     */
    models?: ModelProfile[];
    activeModelId?: number;
    /** 阶段 B：工具循环参数（maxRounds / 搜索上限 / max_tokens / 超时），与核心版同构 */
    agentProfile?: AgentProfile;
}

// ⚠️ 不用模块级常量：ESM import 早于 main.ts 的 setHomeRoot()，
// 在顶层求值会绑到 Electron 默认 userData（旧目录）。每次调用重新求值。
function configFile(): string {
    return homePath("config");
}

export function getModelConfigPath(): string {
    return configFile();
}

export function readModelConfigFile(): ModelConfigFile {
    try {
        if (!fs.existsSync(configFile())) return {};
        const obj = JSON.parse(fs.readFileSync(configFile(), "utf-8"));
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
        fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
    } catch (e) {
        console.warn("[model-config] 写入 config.json 失败:", e instanceof Error ? e.message : String(e));
        return next;
    }
    if (changeCallbacks.length > 0) notifyChange();
    return next;
}

// ── 多模型（models 列表 + 激活）────────────────────────────────
// 模型清单已在 v0.8.3 搬到独立的 models.json（WorkBuddy 同构，可整份互拷）。
// config.json 只留「当前生效的三件套 + activeModelId」。
// 下面所有函数都通过 modelsFile 读写清单，别再碰 cfg.models。

/**
 * 读模型清单（来自 models.json）。
 * 文件坏了抛错而不是静默返回空 —— 静默空会让下一次保存把清单整个覆盖掉。
 */
function safeModels(): (ModelProfile & Record<string, unknown>)[] {
    try {
        return modelsFile.readModels();
    } catch (e) {
        console.warn("[model-config] models.json 读取失败，本次按空清单处理:", e instanceof Error ? e.message : String(e));
        return [];
    }
}

/**
 * 一次性迁移：把旧 config.json 里的 models[] 搬到 models.json，并从 config.json 删掉该键。
 *
 * 只在 config.json 里确实存在 models 时动作；已迁移过的文件不会再触发。
 * 返回迁移条数（0 = 无需迁移）。
 */
export function migrateModelsOutOfConfig(): number {
    const cfg = readModelConfigFile();
    if (!Array.isArray(cfg.models) || cfg.models.length === 0) return 0;
    const legacy = cfg.models;

    // 目标文件已有内容时不覆盖（避免把用户新写的清单冲掉），只补缺的
    let existing: (ModelProfile & Record<string, unknown>)[] = [];
    try {
        existing = modelsFile.readModels();
    } catch {
        existing = [];
    }
    const have = new Set(existing.map((m) => m.id));
    const merged = [...existing, ...legacy.filter((m) => m && typeof m.id === "number" && !have.has(m.id))];
    try {
        modelsFile.writeModels(merged);
    } catch (e) {
        console.warn("[model-config] 迁移 models 到 models.json 失败，保留原 config.json 不动:", e);
        return 0;
    }

    // 清单已落盘，从 config.json 删掉（其余字段原样保留）
    const next: ModelConfigFile = { ...cfg };
    delete next.models;
    try {
        fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
    } catch (e) {
        console.warn("[model-config] 从 config.json 移除 models 失败（数据已在 models.json）:", e);
    }
    return legacy.length;
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
    let models = safeModels();
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
        // 清单写 models.json，activeModelId 仍归 config.json
        try {
            modelsFile.writeModels([migrated]);
        } catch (e) {
            console.warn("[model-config] 写入 models.json 失败:", e instanceof Error ? e.message : String(e));
        }
        writeConfig({ ...cfg, activeModelId: 1 });
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
        fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf-8");
    } catch (e) {
        console.warn("[model-config] 写入 config.json 失败:", e instanceof Error ? e.message : String(e));
        return;
    }
    if (changeCallbacks.length > 0) notifyChange();
}

/**
 * 运行期读取 agentProfile。
 *  - 配置缺 agentProfile：惰性补写一份默认值落盘（一次），走 writeConfig 整体 spread，
 *    手写的未知字段原样保留。这样存量用户升级无感，也不用到处改初始化入口。
 *  - 已有但缺字段 / 值非法：parseAgentProfile 显式报错，不回退默认值。
 * fs.watch 已把外部改动同步进文件，这里每次直接读文件，改配置立即生效。
 */
export function getAgentProfile(): AgentProfile {
    const cfg = readModelConfigFile();
    if (!cfg.agentProfile) {
        writeConfig({ ...cfg, agentProfile: { ...DEFAULT_AGENT_PROFILE } });
        return { ...DEFAULT_AGENT_PROFILE };
    }
    return parseAgentProfile(cfg.agentProfile, "config.json.agentProfile");
}

export function addModelProfile(p: { name: string; endpoint: string; model: string; key: string }): number {
    const cfg = readModelConfigFile();
    const models = safeModels();
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
    try {
        modelsFile.writeModels([...models, profile]);
    } catch (e) {
        console.warn("[model-config] 写入 models.json 失败:", e instanceof Error ? e.message : String(e));
        return id;
    }
    const next: ModelConfigFile = { ...cfg };
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
    const models = safeModels();
    const cur = models.find((m) => m.id === id);
    if (!cur) return null;
    const merged: ModelProfile = {
        ...cur,
        name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim().slice(0, 40) : cur.name,
        endpoint: typeof patch.endpoint === "string" && patch.endpoint.trim() ? patch.endpoint.trim() : cur.endpoint,
        model: typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : cur.model,
        key: typeof patch.key === "string" && patch.key.trim() ? patch.key.trim() : cur.key,
    };
    try {
        modelsFile.writeModels(models.map((m) => (m.id === id ? merged : m)));
    } catch (e) {
        console.warn("[model-config] 写入 models.json 失败:", e instanceof Error ? e.message : String(e));
        return null;
    }
    const next: ModelConfigFile = { ...cfg };
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
    const models = safeModels();
    if (!models.some((m) => m.id === id)) return false;
    try {
        modelsFile.writeModels(models.filter((m) => m.id !== id));
    } catch (e) {
        console.warn("[model-config] 写入 models.json 失败:", e instanceof Error ? e.message : String(e));
        return false;
    }
    const next: ModelConfigFile = { ...cfg };
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
    const target = safeModels().find((m) => m.id === id);
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
        watchHandle = fs.watch(configFile(), () => {
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
