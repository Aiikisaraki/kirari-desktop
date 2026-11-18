import fs from "node:fs";
import path from "node:path";

import { homePath } from "../kirari-home";
import type { ModelProfile } from "../model-config";

/**
 * electron/models/modelsFile.ts
 *
 * 模型清单文件（models.json）—— 与 WorkBuddy 的 ~/.workbuddy/models.json 同构。
 * **与 kirari-core 的 src/services/modelsFile.js 保持同构**（改一处要同步另一处）。
 *
 * ── 为什么单独拆一个文件 ────────────────────────────────────────────
 * 以前 models[] 塞在 config.json 里，config.json 就混了「当前生效的模型三件套 +
 * 搜索渠道 + 人格 + AgentProfile + 模型清单」四类东西。拆开之后：
 *   config.json   只放 Kirari 自己的运行期设置（当前模型 / 搜索 / 人格 / agentProfile）
 *   models.json   纯模型清单，字段名跟 WorkBuddy 一致 → 整份文件可直接拷给别的 agent
 *
 * ── 字段映射（WorkBuddy ↔ Kirari）────────────────────────────────────
 *   id       模型型号（真实发给 API 的 model 名）   ↔  model
 *   name     界面上显示的名字                      ↔  name
 *   url      服务地址（base URL）                  ↔  endpoint
 *   apiKey   密钥                                  ↔  key
 *   vendor / supportsToolCall / supportsImages / supportsReasoning / reasoning
 *            原样保留，Kirari 不解释但保证不丢
 *   profileId  Kirari 内部主键（数字）
 *
 * ⚠️ profileId 是 Kirari 独有的扩展字段。WorkBuddy 读我们写的文件时会忽略它；
 *    我们读 WorkBuddy 的文件时它不存在 —— 此时按顺序补编号。两边都不受影响。
 */

/** Kirari 认识的字段（其余字段原样保留，不丢用户手写的东西）。 */
export const KNOWN_KEYS = ["profileId", "id", "name", "url", "apiKey", "vendor"] as const;

/** 外部 JSON 里的模型条目（WorkBuddy 形状 + 可能的私有键）。 */
export type ModelEntry = Record<string, unknown>;

function modelsFile(): string {
    return homePath("models");
}

export function getModelsPath(): string {
    return modelsFile();
}

export function maskKey(key: string): string {
    if (!key) return "";
    if (key.length <= 6) return "****";
    return `${key.slice(0, 3)}${"*".repeat(6)}${key.slice(-4)}`;
}

/** WorkBuddy 条目 → Kirari 内部条目。 */
function fromEntry(raw: unknown): (ModelProfile & Record<string, unknown>) | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as ModelEntry;
    const model = typeof r.id === "string" ? r.id.trim() : "";
    const endpoint = typeof r.url === "string" ? r.url.trim() : "";
    if (!model && !endpoint && !r.apiKey) return null;
    const out: ModelProfile & Record<string, unknown> = {
        id: 0, // 稍后由 readModels 补齐/校正
        name: typeof r.name === "string" ? r.name.trim() : model,
        model,
        endpoint,
        key: typeof r.apiKey === "string" ? r.apiKey : "",
    };
    if (typeof r.profileId === "number" && Number.isSafeInteger(r.profileId) && r.profileId > 0) {
        out.id = r.profileId;
    }
    // 其余字段（vendor / supports* / reasoning / 用户私有）原样带着
    for (const k of Object.keys(r)) {
        if ((KNOWN_KEYS as readonly string[]).includes(k)) continue;
        out[k] = r[k];
    }
    return out;
}

/** Kirari 内部条目 → WorkBuddy 条目。 */
function toEntry(m: ModelProfile & Record<string, unknown>): ModelEntry | null {
    if (!m || typeof m !== "object") return null;
    const model = String(m.model || "").trim();
    const endpoint = String(m.endpoint || "").trim();
    if (!model && !endpoint && !m.key) return null;
    const out: ModelEntry = {
        id: model || String(m.id || ""),
        name: String(m.name || model).trim(),
        vendor: typeof m.vendor === "string" && m.vendor ? m.vendor : "Custom",
        url: endpoint,
        apiKey: m.key || "",
    };
    // 能力位：用户没显式写过就给一组保守默认（写了就照抄）
    out.supportsToolCall = m.supportsToolCall !== false;
    out.supportsImages = m.supportsImages === true;
    out.supportsReasoning = m.supportsReasoning === true;
    out.useCustomProtocol = m.useCustomProtocol === true;
    if (m.reasoning !== undefined) out.reasoning = m.reasoning;
    if (Number.isSafeInteger(m.id)) out.profileId = m.id;
    // 用户的私有扩展字段原样带出
    for (const k of Object.keys(m)) {
        if (["id", "name", "model", "endpoint", "key"].includes(k)) continue;
        if (k in out) continue;
        out[k] = m[k];
    }
    return out;
}

/**
 * 读模型清单。
 * 文件不存在 → 返回空数组（首次启动正常情况）；文件坏了 → 抛错（不静默当空，
 * 否则用户一保存就把整个清单覆盖没了）。
 */
export function readModels(): (ModelProfile & Record<string, unknown>)[] {
    const file = modelsFile();
    if (!fs.existsSync(file)) return [];
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
        throw new Error(`models.json 不是合法 JSON：${file} — ${e instanceof Error ? e.message : String(e)}`);
    }
    const list: unknown[] = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown[] }).models)
          ? (raw as { models: unknown[] }).models
          : [];
    const out: (ModelProfile & Record<string, unknown>)[] = [];
    let nextId = 1;
    const used = new Set<number>();
    for (const item of list) {
        const m = fromEntry(item);
        if (!m) continue;
        if (!Number.isSafeInteger(m.id) || m.id <= 0 || used.has(m.id)) {
            while (used.has(nextId)) nextId++;
            m.id = nextId;
        }
        used.add(m.id);
        if (m.id >= nextId) nextId = m.id + 1;
        out.push(m);
    }
    return out;
}

/** 写模型清单（models.json 顶层就是数组，整体写）。 */
export function writeModels(models: readonly (ModelProfile & Record<string, unknown>)[]): ModelEntry[] {
    const list: ModelEntry[] = [];
    for (const m of models) {
        const e = toEntry(m);
        if (e) list.push(e);
    }
    const file = modelsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n", "utf-8");
    return list;
}
