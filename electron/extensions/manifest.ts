// electron/extensions/manifest.ts
//
// 清单校验 + 目录扫描。
//
// manifest 是**扩展包提供的**数据，属于不可信输入。这里默认严格：
//   · engine.command 只允许包目录内相对路径（否则一个"扩展包"就能 spawn 任意可执行文件）
//   · 贡献 id 必须是命名空间风格，避免两个包抢同一个 service id 时静默互相覆盖
//   · 认不出的贡献类型直接忽略，不因此拒绝整包（向前兼容）

import * as fs from "fs";
import * as path from "path";
import {
    EXTENSION_API_VERSION,
    type Contribution,
    type ExtensionManifest,
    type ExtensionPermission,
} from "./types";

const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** 服务/能力 id 用点分层：speech.tts、speech.tts.chinese 之类 */
const CONTRIBUTION_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ALLOWED_PERMISSIONS: ExtensionPermission[] = [
    "network",
    "filesystem:models",
    "filesystem:data",
    "microphone",
    "camera",
];
const ALLOWED_CONTRIBUTIONS = ["service", "capability", "settings", "channel"];

/** 校验失败时抛这个，调用方据此给用户一句人话。 */
export class ExtensionManifestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ExtensionManifestError";
    }
}

function asString(v: unknown, field: string): string {
    if (typeof v !== "string" || !v.trim()) {
        throw new ExtensionManifestError("字段 " + field + " 必须是非空字符串");
    }
    return v.trim();
}

function parseContributions(raw: unknown): Contribution[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        throw new ExtensionManifestError("字段 contributions 必须是数组");
    }
    const out: Contribution[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const c = item as Record<string, unknown>;
        const type = String(c.type || "");
        // 未知贡献：忽略，不拒绝整包
        if (!ALLOWED_CONTRIBUTIONS.includes(type)) continue;
        const id = asString(c.id, type + ".id");
        if (!CONTRIBUTION_ID_RE.test(id)) {
            throw new ExtensionManifestError("贡献 id 不合法：" + id);
        }
        const title = typeof c.title === "string" && c.title.trim() ? c.title.trim() : id;
        const description = typeof c.description === "string" ? c.description : undefined;

        if (type === "service") out.push({ type: "service", id, title, description });
        else if (type === "channel") out.push({ type: "channel", id, title, description });
        else if (type === "capability") {
            out.push({
                type: "capability",
                id,
                title,
                description,
                parameters:
                    c.parameters && typeof c.parameters === "object" && !Array.isArray(c.parameters)
                        ? (c.parameters as Record<string, unknown>)
                        : undefined,
            });
        } else {
            out.push({
                type: "settings",
                id,
                title,
                schema:
                    c.schema && typeof c.schema === "object" && !Array.isArray(c.schema)
                        ? (c.schema as Record<string, unknown>)
                        : undefined,
            });
        }
    }
    return out;
}

/**
 * 把任意 JSON 校验成 ExtensionManifest。
 * 不因未知字段报错（向前兼容：新包可以带宿主还不认识的提示字段）。
 */
export function parseManifest(raw: unknown): ExtensionManifest {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ExtensionManifestError("manifest 必须是 JSON 对象");
    }
    const m = raw as Record<string, unknown>;

    const id = asString(m.id, "id");
    if (!ID_RE.test(id)) {
        throw new ExtensionManifestError("扩展包 id 不合法：" + id + "（应为反向域名风格小写标识）");
    }
    const name = asString(m.name, "name");
    const version = asString(m.version, "version");
    if (!VERSION_RE.test(version)) {
        throw new ExtensionManifestError("版本号不是 semver：" + version);
    }

    const apiVersion = Number(m.apiVersion);
    if (!Number.isFinite(apiVersion)) {
        throw new ExtensionManifestError("字段 apiVersion 必须是数字");
    }
    if (apiVersion > EXTENSION_API_VERSION) {
        throw new ExtensionManifestError(
            "扩展包要求 API v" + apiVersion + "，当前宿主只支持到 v" + EXTENSION_API_VERSION + "，请升级桌宠本体",
        );
    }

    const engineRaw = m.engine;
    if (!engineRaw || typeof engineRaw !== "object" || Array.isArray(engineRaw)) {
        throw new ExtensionManifestError("字段 engine 必须是对象");
    }
    const e = engineRaw as Record<string, unknown>;
    if (e.runtime !== "sidecar") {
        throw new ExtensionManifestError("不支持的 runtime：" + String(e.runtime) + "（目前只有 sidecar）");
    }
    if (e.protocol !== "jsonrpc-stdio@1") {
        throw new ExtensionManifestError(
            "不支持的协议：" + String(e.protocol) + "（目前只有 jsonrpc-stdio@1）",
        );
    }
    let launch: "host-node" | "binary" | undefined;
    if (e.launch !== undefined) {
        if (e.launch !== "host-node" && e.launch !== "binary") {
            throw new ExtensionManifestError(
                "不支持的 launch：" + String(e.launch) + "（只有 host-node / binary）",
            );
        }
        launch = e.launch;
    }
    const command = asString(e.command, "engine.command");
    if (path.isAbsolute(command) || command.includes("..")) {
        throw new ExtensionManifestError("engine.command 只允许扩展包目录内的相对路径");
    }
    const args = Array.isArray(e.args) ? e.args.map((a) => String(a)) : undefined;

    let env: Record<string, string> | undefined;
    if (e.env && typeof e.env === "object" && !Array.isArray(e.env)) {
        env = {};
        for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
            // 只允许扩展包自己的键；宿主关键变量一律不让改
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
            if (/^(PATH|NODE_OPTIONS|ELECTRON|LD_|DYLD_)/i.test(k)) continue;
            env[k] = String(v);
        }
    }

    const rawTimeout = Number(e.requestTimeoutMs);
    const requestTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined;
    const rawIdle = Number(e.idleTimeoutMs);
    const idleTimeoutMs = Number.isFinite(rawIdle) && rawIdle > 0 ? rawIdle : undefined;

    const permissions = Array.isArray(m.permissions)
        ? m.permissions.filter((p): p is ExtensionPermission =>
              ALLOWED_PERMISSIONS.includes(p as ExtensionPermission),
          )
        : undefined;

    const resRaw = m.resources;
    let resources: ExtensionManifest["resources"];
    if (resRaw && typeof resRaw === "object" && !Array.isArray(resRaw)) {
        const r = resRaw as Record<string, unknown>;
        const ram = Number(r.minRamMb);
        resources = {
            minRamMb: Number.isFinite(ram) ? ram : undefined,
            gpuRecommended: r.gpuRecommended === true,
        };
    }

    return {
        id,
        name,
        version,
        apiVersion,
        description: typeof m.description === "string" ? m.description : undefined,
        engine: {
            runtime: "sidecar",
            protocol: "jsonrpc-stdio@1",
            launch,
            command,
            args,
            env,
            requestTimeoutMs,
            idleTimeoutMs,
        },
        contributions: parseContributions(m.contributions),
        permissions,
        resources,
    };
}

/** 扫出的一枚候选扩展包。 */
export interface DiscoveredExtension {
    manifest: ExtensionManifest;
    /** 扩展包根目录（绝对路径），sidecar 的 cwd 就是它 */
    dir: string;
    /** 校验失败的包也返回，好让设置页能显示"这个包装不上、原因是什么" */
    error?: string;
}

/**
 * 扫描扩展根目录下的一层子目录，找 manifest.json。
 *
 * 只扫一层：不允许"包里的包"，避免出现来路不明的执行入口。
 * 目录不存在返回空数组（首次启动的常见状态，不是错误）。
 */
export async function discoverExtensions(rootDir: string): Promise<DiscoveredExtension[]> {
    const out: DiscoveredExtension[] = [];
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(rootDir, entry.name);
        const manifestPath = path.join(dir, "manifest.json");
        let text: string;
        try {
            text = await fs.promises.readFile(manifestPath, "utf-8");
        } catch {
            continue; // 没有 manifest.json 的目录不是扩展包
        }
        try {
            out.push({ manifest: parseManifest(JSON.parse(text)), dir });
        } catch (err) {
            out.push({
                // 校验失败也给个占位清单，设置页才能显示目录名与原因
                manifest: {
                    id: entry.name,
                    name: entry.name,
                    version: "0.0.0",
                    apiVersion: 0,
                    engine: { runtime: "sidecar", protocol: "jsonrpc-stdio@1", command: "" },
                    contributions: [],
                },
                dir,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return out;
}
