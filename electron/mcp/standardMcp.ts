import fs from "node:fs";
import path from "node:path";

import type { McpServerConfig } from "../frontend-tools";

/**
 * electron/mcp/standardMcp.ts
 *
 * 标准 MCP 配置格式 ↔ Kirari 内部结构的唯一转换点。
 * **与 kirari-core 的 src/mcp/standardMcp.js 保持同构**（改一处要同步另一处）。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────────
 * 事实标准（Claude Code / codebuddy / WorkBuddy / Cursor 全用这个）是：
 *
 *   { "mcpServers": {
 *       "名字": { "command": "npx", "args": ["-y", "pkg"], "env": {...} },   // stdio
 *       "名字": { "url": "https://.../mcp", "headers": {...} },              // http
 *   } }
 *
 * 而 Kirari 内部用的是带 id/transport 的对象数组（设置页要稳定 id、
 * 连接池按 id 建索引）。两边都需要，所以只在边界转换一次：
 * 文件里永远是标准格式，内存里永远是内部结构。
 *
 * ── 转换的关键约定 ──────────────────────────────────────────────────
 *   · 名字即 id：`mcpServers` 的键是唯一标识，直接当 id 用。这样用户在
 *     一个 agent 里配的 MCP，拷到另一个 agent 里名字不变，可对得上。
 *   · 缺什么补什么：标准格式没有 transport —— 有 command 就是 stdio，
 *     有 url 就是 http。两者都有时以 url 为准（远程优先，与各家一致）。
 *   · disabled 双向：`disabled: true`（WorkBuddy 写法）↔ `enabled: false`。
 *   · 未知字段原样保留：用户可能在条目里写 `"timeout": 60` 之类各家的私有键，
 *     转回标准格式时必须原样带出去，否则一次保存就把人家的配置吃掉了。
 */

/** 内部保留了哪些键（其余键视为「用户的未知字段」，写回时原样搬运）。 */
export const INTERNAL_KEYS = [
    "id",
    "name",
    "transport",
    "url",
    "command",
    "args",
    "env",
    "cwd",
    "headers",
    "enabled",
] as const;

/** 标准条目里可能出现的字段（宽松类型：可能带用户私有键）。 */
export type StandardMcpEntry = Record<string, unknown>;

export interface StandardMcpFile {
    mcpServers?: Record<string, StandardMcpEntry>;
    [key: string]: unknown;
}

/**
 * 标准条目 → 内部条目。
 * @param name mcpServers 的键，作为 id/name
 * @returns 无法识别的条目返回 null（调用方跳过并计数）
 */
export function entryToInternal(name: string, entry: unknown): McpServerConfig | null {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const e = entry as StandardMcpEntry;
    const id = String(name || "").trim();
    if (!id) return null;

    const urlRaw = typeof e.url === "string" ? e.url.trim() : "";
    const cmdRaw = typeof e.command === "string" ? e.command.trim() : "";
    if (!urlRaw && !cmdRaw) return null;

    const out: McpServerConfig & Record<string, unknown> = {
        id,
        name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : id,
        transport: urlRaw ? "http" : "stdio",
        enabled: e.disabled !== true && e.enabled !== false,
    };
    if (urlRaw) {
        out.url = urlRaw;
        if (e.headers && typeof e.headers === "object") {
            out.headers = { ...(e.headers as Record<string, string>) };
        }
    } else {
        out.command = cmdRaw;
        if (Array.isArray(e.args)) out.args = e.args.map((a) => String(a));
        if (e.env && typeof e.env === "object") out.env = { ...(e.env as Record<string, string>) };
        if (typeof e.cwd === "string" && e.cwd.trim()) out.cwd = e.cwd;
    }

    // 用户的扩展字段原样保留（内部不认识，但写回时要还给他）
    for (const k of Object.keys(e)) {
        if (k in out) continue;
        if ((INTERNAL_KEYS as readonly string[]).includes(k)) continue;
        if (k === "disabled") continue; // 已转成 enabled
        out[k] = e[k];
    }
    return out;
}

/**
 * 内部条目 → 标准条目。id 变成 mcpServers 的键，所以不写进值里。
 */
export function internalToEntry(srv: McpServerConfig & Record<string, unknown>): StandardMcpEntry | null {
    if (!srv || typeof srv !== "object") return null;
    const out: StandardMcpEntry = {};
    if (srv.transport === "http" && srv.url) {
        out.url = srv.url;
        if (srv.headers && typeof srv.headers === "object" && Object.keys(srv.headers).length) {
            out.headers = { ...srv.headers };
        }
    } else if (srv.transport === "stdio" && srv.command) {
        out.command = srv.command;
        if (Array.isArray(srv.args) && srv.args.length) out.args = [...srv.args];
        if (srv.env && typeof srv.env === "object" && Object.keys(srv.env).length) out.env = { ...srv.env };
        if (srv.cwd) out.cwd = srv.cwd;
    } else {
        return null; // 半配置：没有 url 也没有 command
    }
    // 内部 enabled=false ↔ 标准 disabled=true（WorkBuddy 用 disabled）
    if (srv.enabled === false) out.disabled = true;
    else if (srv.disabled === true) out.disabled = true;

    // 用户的扩展字段原样带出去
    for (const k of Object.keys(srv)) {
        if ((INTERNAL_KEYS as readonly string[]).includes(k)) continue;
        out[k] = srv[k];
    }
    return out;
}

/** 标准格式对象 → 内部数组。dropped = 无法识别的键名。 */
export function fromStandard(raw: unknown): { servers: McpServerConfig[]; dropped: string[] } {
    const servers: McpServerConfig[] = [];
    const dropped: string[] = [];
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as StandardMcpFile) : {};
    const map = obj.mcpServers && typeof obj.mcpServers === "object" ? obj.mcpServers : {};
    for (const [name, entry] of Object.entries(map)) {
        const s = entryToInternal(name, entry);
        if (s) servers.push(s);
        else dropped.push(name);
    }
    return { servers, dropped };
}

/** 内部数组 → 标准格式对象（可直接写文件）。 */
export function toStandard(servers: readonly McpServerConfig[]): { mcpServers: Record<string, StandardMcpEntry> } {
    const map: Record<string, StandardMcpEntry> = {};
    for (const s of servers) {
        const entry = internalToEntry(s as McpServerConfig & Record<string, unknown>);
        if (!entry) continue;
        // 名字冲突时加序号后缀，避免静默丢一个 server
        let key = String(s.id || s.name || "").trim();
        if (!key) continue;
        if (key in map) {
            let i = 2;
            while (`${key}-${i}` in map) i++;
            key = `${key}-${i}`;
        }
        map[key] = entry;
    }
    return { mcpServers: map };
}

/**
 * 读标准 MCP 配置文件。
 * 文件不存在 → 空数组（正常：没配过）；文件坏了 → 抛错（不静默当作空，
 * 否则用户保存设置时会把坏文件整体覆盖掉，等于删配置）。
 */
export function readStandardFile(file: string): {
    servers: McpServerConfig[];
    dropped: string[];
    missing: boolean;
    raw?: StandardMcpFile;
} {
    if (!fs.existsSync(file)) return { servers: [], dropped: [], missing: true };
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch (e) {
        throw new Error(`MCP 配置文件不是合法 JSON：${file} — ${e instanceof Error ? e.message : String(e)}`);
    }
    const { servers, dropped } = fromStandard(raw);
    return { servers, dropped, missing: false, raw: raw as StandardMcpFile };
}

/** 写标准 MCP 配置文件（保留文件里的其他顶层键）。 */
export function writeStandardFile(file: string, servers: readonly McpServerConfig[]): StandardMcpFile {
    let existing: StandardMcpFile = {};
    try {
        if (fs.existsSync(file)) {
            const cur = JSON.parse(fs.readFileSync(file, "utf-8"));
            if (cur && typeof cur === "object" && !Array.isArray(cur)) existing = cur as StandardMcpFile;
        }
    } catch {
        /* 坏文件：本次写入以新内容为准（调用方已决定要覆盖） */
    }

    const next: StandardMcpFile = { ...existing, ...toStandard(servers) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", "utf-8");
    return next;
}
