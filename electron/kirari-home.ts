// electron/kirari-home.ts
// Kirari 数据根（~/.kirari）：桌宠版侧。与 kirari-core/src/kirariHome.js **同一份规范**。
//
// ── 分工 ────────────────────────────────────────────────────────────
// 一个 Electron 应用默认把两类完全不同的东西塞进同一个 userData 目录：
//   ① Chromium 运行时缓存（Cache/、GPUCache/、Local Storage/、blob_storage/ …）
//   ② 用户真正在乎的数据（配置、聊天库、技能、皮肤、头像）
// 混在一起的后果：想备份聊天记录得先挑出几十个缓存目录；换机器同步时缓存跟着走；
// 用户打开目录看到的是一堆看不懂的文件夹。
//
// 所以这里把两者拆开：
//   · app.setPath("userData", ~/.kirari)               → 配置/库/皮肤/头像/日志
//   · app.setPath("sessionData", %APPDATA%\<app>\chromium) → 纯缓存，留在 AppData
// sessionData 是 Electron 专门为「不该跟着用户数据走的东西」准备的路径
// （v25 起可分离），必须在 ready 之前设置，见 main.ts 顶部。
//
// ── 目录规范与核心版一字不差（docs/home-layout.md 是给人看的同一份表）──
//   ~/.kirari/
//   ├── home.json                  目录版本 + 迁移记录
//   ├── config.json                模型/搜索/人格/AgentProfile
//   ├── pet-client.config.json     备注名/头像/适配器/窗口/主题/形象
//   ├── knowledge/knowledge.json   私人知识库
//   ├── mcp/servers.json           MCP 服务
//   ├── skills/<id>/SKILL.md       技能正文
//   ├── skills/skills.json         旧 prompt 型技能
//   ├── database/pet_sessions.db   聊天记录/事件流/任务
//   ├── sessions/local-session.json
//   ├── network/{net-state,net-identity}.json
//   ├── avatars/                   皮肤
//   ├── user-avatar/               我的头像
//   ├── logs/
//   └── backups/
//
// ⚠️ 与核心版唯一的差别：本文件不负责一次性迁移。桌宠端在 ready 之前就要
//    setPath，那时还来不及跑完整迁移；而 Electron 自己会在新 userData 为空时
//    重建目录结构，所以迁移放在 kirari-core 启动时（它是数据的最终读取方）
//    与 main.ts 的 migrateLegacyHome()（见下）里做，两边都只复制、不移动。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

const HOME_DIR_NAME = ".kirari";
const HOME_META_FILE = "home.json";
const HOME_VERSION = 1;

/** 数据根下所有路径的**唯一真源**（与 kirari-core 的 LAYOUT 保持同构）。 */
export const LAYOUT = {
    meta: HOME_META_FILE,
    config: "config.json",
    // 模型清单（WorkBuddy models.json 同构，可与其直接互拷）
    models: "models.json",
    clientConfig: "pet-client.config.json",
    consoleAppearance: "console-appearance.json",
    knowledge: "knowledge/knowledge.json",
    // MCP 外部工具服务：标准 mcp.json（`{ "mcpServers": { "<名>": ... } }`），
    // 与 Claude Code / codebuddy / WorkBuddy 同格式，配置文件可直接互拷。
    mcp: "mcp.json",
    // 旧版 MCP 配置（{ servers: [...] }）。首次启动读入标准格式后留档，不再写。
    mcpLegacy: "mcp/servers.json",
    skillsRoot: "skills",
    skillsJson: "skills/skills.json",
    database: "database/pet_sessions.db",
    localSession: "sessions/local-session.json",
    netState: "network/net-state.json",
    netIdentity: "network/net-identity.json",
    avatars: "avatars",
    userAvatar: "user-avatar",
    logs: "logs",
    backups: "backups",
} as const;

export type LayoutKey = keyof typeof LAYOUT;
export type HomePaths = { home: string } & Record<LayoutKey, string>;

const DIR_KEYS: LayoutKey[] = ["skillsRoot", "avatars", "userAvatar", "logs", "backups"];

/** main.ts 登记的数据根（setHomeRoot）；未登记时为 null，交给 resolveHome / electron 求值。 */
let homeRootOverride: string | null = null;

function envDir(name: string): string | null {
    const raw = process.env[name];
    if (!raw || !String(raw).trim()) return null;
    return path.resolve(String(raw).trim());
}

/** 解析数据根（不创建任何文件）。优先级与核心版完全一致。 */
export function resolveHome(): { dir: string; source: string } {
    const explicit = envDir("KIRARI_HOME");
    if (explicit) return { dir: explicit, source: "env:KIRARI_HOME" };

    // 旧变量降级复用：语义从「探测 userData」变成「数据根换位置」。
    const legacyCore = envDir("PET_API_DATA_DIR");
    if (legacyCore) return { dir: legacyCore, source: "env:PET_API_DATA_DIR(legacy)" };

    const legacyDesktop = envDir("KIRARI_DESKTOP_DATA_DIR");
    if (legacyDesktop) return { dir: legacyDesktop, source: "env:KIRARI_DESKTOP_DATA_DIR(legacy)" };

    return { dir: path.join(os.homedir(), HOME_DIR_NAME), source: `default:~/${HOME_DIR_NAME}` };
}

/** 全量数据路径（传根则基于该根）。 */
export function homePaths(root?: string): HomePaths {
    const dir = root || resolveHome().dir;
    const out: Record<string, string> = { home: dir };
    for (const [key, rel] of Object.entries(LAYOUT)) out[key] = path.join(dir, rel);
    return out as HomePaths;
}

/** 预先建好目录结构。幂等。 */
export function ensureHomeLayout(root?: string): HomePaths {
    const p = homePaths(root);
    fs.mkdirSync(p.home, { recursive: true });
    for (const key of DIR_KEYS) fs.mkdirSync(p[key], { recursive: true });
    for (const key of ["knowledge", "database", "localSession", "netState"] as LayoutKey[]) {
        fs.mkdirSync(path.dirname(p[key]), { recursive: true });
    }
    return p;
}

/**
 * 拿「数据根」绝对路径。**必须在调用时求值，不要存成模块级常量。**
 *
 * 求值顺序：
 *   1. main.ts 早期 `setHomeRoot()` 登记的根（正常运行时就是它）
 *   2. KIRARI_HOME / 旧 PET_API_DATA_DIR / KIRARI_DESKTOP_DATA_DIR
 *   3. 当前 Electron 的 userData —— 单测把 electron mock 成临时目录时靠这条隔离
 *   4. ~/.kirari
 *
 * 为什么强调「调用时」：ESM 的 import 早于 main.ts 模块体执行。任何模块若在顶层
 * 用 homePath() 算成常量，就会在 setHomeRoot() 之前被求值，从而绑到 Electron 的
 * 默认 userData（= 旧目录 %APPDATA%\akisaki-kirari），造成「配置写新根、读旧根」。
 */
export function kirariHome(): string {
    if (homeRootOverride) return homeRootOverride;
    const resolved = resolveHome();
    if (!resolved.source.startsWith("default:")) return resolved.dir;
    // 静态 import 的 app：单测里 electron 被 vi.mock 成临时目录时，
    // 这条分支让用例写在沙箱内、不落到用户真实家目录。
    try {
        const ud = app?.getPath?.("userData");
        if (ud && typeof ud === "string" && ud.trim()) return ud;
    } catch {
        /* 非 Electron 上下文（纯 node 脚本）走默认值 */
    }
    return resolved.dir;
}

/** main.ts 在 ready 之前登记数据根，之后所有 homePath() 都以它为准。 */
export function setHomeRoot(dir: string): void {
    homeRootOverride = path.resolve(dir);
}

/** 数据根下的具体路径（最常用入口）。 */
export function homePath(key: LayoutKey, root?: string): string {
    return path.join(root || kirariHome(), LAYOUT[key]);
}

// ─────────────────────────── 旧位置 ───────────────────────────

/** 旧位置候选根：桌宠版旧 userData、桌宠 fallback、核心版包内 data。 */
export function legacyRoots(): string[] {
    const appName = "akisaki-kirari";
    const home = os.homedir();
    const out: string[] = [];
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        out.push(path.join(appData, appName));
    } else if (process.platform === "darwin") {
        out.push(path.join(home, "Library", "Application Support", appName));
    } else {
        const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
        out.push(path.join(xdg, appName));
    }
    out.push(path.join(home, ".akisaki-kirari"));
    return out;
}

export interface HomeMigrationResult {
    ran: boolean;
    reason: string;
    from: string | null;
    copied: string[];
    skipped: string[];
    failed: { path: string; error: string }[];
}

function readMeta(dir: string): Record<string, unknown> | null {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, HOME_META_FILE), "utf-8"));
        return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function isWritable(dir: string): boolean {
    try {
        const probe = path.join(dir, `.kirari-write-probe-${process.pid}`);
        fs.writeFileSync(probe, "");
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

/**
 * 一次性迁移：旧 userData（扁平结构）→ 新数据根布局。**只复制，不移动、不删除。**
 *
 * 为什么桌宠端也要做：用户第一次升级时，聊天库和皮肤都还在
 * %APPDATA%\akisaki-kirari 里；不搬过来就会「打开是全新的、历史全没了」。
 * 但用户也可能选择继续用旧目录（KIRARI_HOME 指过去），所以绝不删原件。
 *
 * 幂等判据是 home.json 里的 migration.at —— 不看目标是否为空，
 * 免得用户删了某个文件就被整体重搬一次。
 */
export function migrateLegacyHome(opts: { root?: string; from?: string } = {}): HomeMigrationResult {
    const dir = opts.root || kirariHome();
    fs.mkdirSync(dir, { recursive: true });
    ensureHomeLayout(dir);

    const meta = readMeta(dir);
    const prev = meta?.migration as { at?: string; from?: string | null } | undefined;
    if (prev?.at) {
        return { ran: false, reason: "already-migrated", from: prev.from ?? null, copied: [], skipped: [], failed: [] };
    }

    const candidates = opts.from ? [opts.from] : legacyRoots();
    const chosen =
        candidates.find((c) => {
            try {
                return fs.existsSync(c) && fs.statSync(c).isDirectory() && fs.readdirSync(c).length > 0 && isWritable(c);
            } catch {
                return false;
            }
        }) || null;

    const copied: string[] = [];
    const skipped: string[] = [];
    const failed: { path: string; error: string }[] = [];

    const copyFile = (fromAbs: string, toRel: string) => {
        try {
            if (!fs.existsSync(fromAbs)) return;
            const dest = path.join(dir, toRel);
            if (fs.existsSync(dest)) {
                skipped.push(toRel);
                return;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            // kirari.db / chat-session*.json 是旧库与旧聊天记录，必须是**文件**拷贝，
            // 它们随后由 legacy-db / legacy-chat 迁移器读走进库。
            fs.copyFileSync(fromAbs, dest);
            copied.push(toRel);
        } catch (e) {
            failed.push({ path: toRel, error: e instanceof Error ? e.message : String(e) });
        }
    };

    const copyDir = (fromRel: string, toRel: string) => {
        const srcRoot = path.join(chosen as string, fromRel);
        if (!fs.existsSync(srcRoot)) return;
        const walk = (rel: string) => {
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(path.join(srcRoot, rel), { withFileTypes: true });
            } catch (e) {
                failed.push({ path: path.join(toRel, rel), error: e instanceof Error ? e.message : String(e) });
                return;
            }
            for (const ent of entries) {
                const childRel = rel ? path.join(rel, ent.name) : ent.name;
                if (ent.isDirectory()) walk(childRel);
                else if (ent.isFile()) copyFile(path.join(srcRoot, childRel), path.join(toRel, childRel));
            }
        };
        walk("");
    };

    if (chosen) {
        copyFile(path.join(chosen, "config.json"), LAYOUT.config);
        copyFile(path.join(chosen, "pet-client.config.json"), LAYOUT.clientConfig);
        copyFile(path.join(chosen, "console-appearance.json"), LAYOUT.consoleAppearance);
        copyFile(path.join(chosen, "knowledge.json"), LAYOUT.knowledge);
        // 旧扁平 mcp-servers.json 先原样落到 legacy 位置，由 mcp-config.ts 转成标准 mcp.json。
        // 直接改名成 mcp.json 会失败：两者 schema 不同（数组 vs mcpServers 对象）。
        copyFile(path.join(chosen, "mcp-servers.json"), LAYOUT.mcpLegacy);
        copyFile(path.join(chosen, "skills.json"), LAYOUT.skillsJson);
        copyFile(path.join(chosen, "local-session.json"), LAYOUT.localSession);
        copyFile(path.join(chosen, "net-state.json"), LAYOUT.netState);
        copyFile(path.join(chosen, "net-identity.json"), LAYOUT.netIdentity);
        // WAL 三件套：只拷主库会丢最后一批事务。
        copyFile(path.join(chosen, "pet_sessions.db"), LAYOUT.database);
        copyFile(path.join(chosen, "pet_sessions.db-wal"), `${LAYOUT.database}-wal`);
        copyFile(path.join(chosen, "pet_sessions.db-shm"), `${LAYOUT.database}-shm`);
        // 目录整体搬
        copyDir("skills", LAYOUT.skillsRoot);
        copyDir("avatars", LAYOUT.avatars);
        copyDir("user-avatar", LAYOUT.userAvatar);
        // 日志不搬（新根从今天起自己记，旧日志留在旧目录随时可查）
        // 旧版遗留物必须留在**根目录**：legacy-chat / legacy-db 两个迁移器
        // 就是按 userData 根下的文件名去找它们的。
        copyFile(path.join(chosen, "chat-session.json"), "chat-session.json");
        copyFile(path.join(chosen, "chat-session.local.json"), "chat-session.local.json");
        copyFile(path.join(chosen, "kirari.db"), "kirari.db");
        // 旧版机器人适配器（core 的 migrateLegacyAdapterFile 会读它再改名留档）
        copyFile(path.join(chosen, "adapter.json"), "adapter.json");
    }

    const nextMeta: Record<string, unknown> = { ...(meta || {}) };
    nextMeta.version = HOME_VERSION;
    nextMeta.createdAt = nextMeta.createdAt || new Date().toISOString();
    nextMeta.migration = {
        at: new Date().toISOString(),
        from: chosen,
        copiedCount: copied.length,
        skippedCount: skipped.length,
        failed,
    };
    try {
        fs.writeFileSync(path.join(dir, HOME_META_FILE), JSON.stringify(nextMeta, null, 2), "utf-8");
        if (copied.length || skipped.length) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupDir = path.join(dir, LAYOUT.backups);
            fs.mkdirSync(backupDir, { recursive: true });
            fs.writeFileSync(
                path.join(backupDir, `migration-${stamp}.json`),
                JSON.stringify({ from: chosen, copied, skipped, failed }, null, 2),
                "utf-8",
            );
        }
    } catch {
        /* 元数据写不了不影响本次启动，下次启动会重试 */
    }

    return { ran: true, reason: chosen ? "migrated" : "empty-legacy", from: chosen, copied, skipped, failed };
}
