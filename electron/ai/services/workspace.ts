// electron/ai/services/workspace.ts
// 工作空间服务（desktop 侧）。与核心版 src/services/workspace.js 严格对称。
//
// ── 为什么根目录刻意放在 ~/.kirari 外面 ────────────────────────────────
// ~/.kirari 放的是配置、数据库、凭证——用户不该随手翻，也不该拿 U 盘拷走。
// 工作空间放的是**产物**：任务写出来的简报、汇总、日志。放在用户目录下显眼的位置
// （~/KirariWorkspace），用户才可能真的去看、去备份、往里丢参考资料。
//
// ── 为什么文件夹名用 id 而不是标题 ──────────────────────────────────
// 标题随时会被改（「每日简报」→「每日科技简报」）。用标题当文件夹名，一改名
// 历史产出就跟任务失联了。所以目录名 = 稳定 id，人看的标题存在 meta.json 里。
//
// ── 安全 ────────────────────────────────────────────────────────────
// 她会拿到**完整**文件 CRUD（用户 2026-11-19 拍板「完整（含删除/新建目录）」）。
// 所以这里的路径校验不是「体验问题」而是「她能不能把文件删到工作空间外面去」：
// 每一段都校验，最后再用 path.relative 复核一遍真实落点，两道都过才允许动手。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ROOT_DIR_NAME = "KirariWorkspace";
export const SPACE_META_FILE = ".kirari-workspace.json";
export const TASK_META_FILE = "meta.json";

export const LIMITS = {
    /** 单次读文件的上限。超过就拒绝——真要读大文件该让她分段读，而不是把上下文炸掉。 */
    readBytes: 256 * 1024,
    /** 单次写入的上限。定期任务的产出不会有这么大，超了多半是哪里写错了。 */
    writeBytes: 4 * 1024 * 1024,
    /** 一次列目录最多返回多少条，防止超长目录把工具结果撑爆。 */
    listEntries: 400,
};

export interface Retention {
    keepFiles: number;
    keepDays: number;
    keepBytes: number;
}

export const DEFAULT_RETENTION: Retention = {
    keepFiles: 200,
    keepDays: 30,
    keepBytes: 50 * 1024 * 1024,
};

export interface TaskMeta {
    taskId: string;
    title: string;
    description: string;
    createdAt: number;
    updatedAt: number;
    lastRunAt: number | null;
    runCount: number;
    retention: Retention;
}

export interface TaskListItem {
    taskId: string;
    dir: string;
    title: string;
    files: number;
    bytes: number;
    lastRunAt: string | null;
    /** 原始时间戳，只用于排序。不要拿 lastRunAt（本地化字符串）反解回时间。 */
    lastRunMs: number;
    runCount: number;
}

export interface FileEntry {
    name: string;
    dir: boolean;
    size: number;
    mtime: string;
}

/** Windows 保留设备名：这些名字在 Windows 上永远不能当文件名，写进去会静默失败。 */
const WIN_RESERVED = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** 工作空间根目录。不创建任何东西，只是算出来。 */
export function resolveRoot(): string {
    const env = String(process.env.KIRARI_WORKSPACE || "").trim();
    if (env) return path.resolve(env);
    return path.join(os.homedir(), ROOT_DIR_NAME);
}

export function rootDir(): string {
    return resolveRoot();
}

/**
 * 校验单段名字。
 * 注意：两端有空格时**直接拒**，而不是 trim。trim 会让「实际写进去的名字」和
 * 「调用方以为的名字」不一致，之后按原名读回来就是 404，这种 bug 极难查。
 */
export function safeSegment(name: unknown, where = "path"): string {
    const raw = String(name == null ? "" : name);
    if (!raw) throw new Error(`[${where}] 名字不能为空`);
    if (raw !== raw.trim()) throw new Error(`[${where}] 名字两端不能有空格`);
    if (raw === "." || raw === "..") throw new Error(`[${where}] 不允许 "${raw}"`);
    if (raw.length > 64) throw new Error(`[${where}] 名字超过 64 字符`);
    if (/[\x00-\x1f\x7f/\\:*?"<>|]/.test(raw)) {
        throw new Error(`[${where}] 名字里不能有 / \\ : * ? " < > | 或控制字符`);
    }
    // Windows 会静默去掉结尾的点和空格
    if (/[. ]$/.test(raw)) throw new Error(`[${where}] 名字不能以点或空格结尾`);
    if (WIN_RESERVED.has(raw.toLowerCase())) throw new Error(`[${where}] "${raw}" 是系统保留名`);
    return raw;
}

export function taskDir(taskId: unknown): string {
    const id = safeSegment(taskId, "taskId");
    return path.join(resolveRoot(), id);
}

/**
 * 把任务内的相对路径解析成绝对路径，顺带做越权校验。
 * 两道防线：逐段 safeSegment（挡住 .. 与非法字符），再用 path.relative 复核
 * 真实落点确实在任务目录里（挡住平台差异带来的意外）。
 */
export function resolveInTask(taskId: unknown, relPath: unknown): string {
    const dir = taskDir(taskId);
    const raw = String(relPath == null ? "" : relPath).trim();
    if (!raw) throw new Error("[path] 路径不能为空");
    if (path.isAbsolute(raw)) throw new Error("[path] 不能用绝对路径");
    if (/^[a-zA-Z]:/.test(raw)) throw new Error("[path] 不能用盘符路径");
    if (/^\\\\/.test(raw)) throw new Error("[path] 不能用 UNC 路径");

    const parts: string[] = [];
    for (const seg of raw.split(/[\\/]+/)) {
        if (!seg || seg === ".") continue;
        if (seg === "..") throw new Error("[path] 不允许用 .. 往上跳");
        parts.push(safeSegment(seg, "path"));
    }
    if (!parts.length) throw new Error("[path] 路径里没有有效文件名");

    const abs = path.join(dir, ...parts);
    // 复核：平台差异可能让 join 出来的落点跑到外面去
    const rel = path.relative(dir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("[path] 路径越出了任务文件夹");
    return abs;
}

// ── 目录 / 元信息 ────────────────────────────────────────────────────

export function ensureRoot(): string {
    const root = resolveRoot();
    fs.mkdirSync(root, { recursive: true });
    const metaPath = path.join(root, SPACE_META_FILE);
    if (!fs.existsSync(metaPath)) {
        fs.writeFileSync(
            metaPath,
            JSON.stringify({ kind: "kirari-workspace", version: 1, createdAt: Date.now() }, null, 2),
            "utf8",
        );
    }
    return root;
}

export function defaultMeta(taskId: string, patch: Partial<Omit<TaskMeta, "retention">> & { retention?: Partial<Retention> } = {}): TaskMeta {
    const now = Date.now();
    return {
        taskId,
        title: patch.title || taskId,
        description: patch.description || "",
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        runCount: 0,
        retention: { ...DEFAULT_RETENTION, ...(patch.retention || {}) },
    };
}

export function ensureTask(
    taskId: unknown,
    patch: Partial<Omit<TaskMeta, "retention">> & { retention?: Partial<Retention> } = {},
): { taskId: string; dir: string; meta: TaskMeta } {
    const id = safeSegment(taskId, "taskId");
    ensureRoot();
    const dir = taskDir(id);
    fs.mkdirSync(dir, { recursive: true });

    const metaPath = path.join(dir, TASK_META_FILE);
    let meta: TaskMeta;
    if (fs.existsSync(metaPath)) {
        meta = readTaskMeta(id);
        // 已有任务：只覆盖明确给了的字段（标题改了不必搬文件夹，这正是用 id 命名的好处）
        let touched = false;
        if (patch.title && patch.title !== meta.title) {
            meta.title = patch.title;
            touched = true;
        }
        if (patch.description != null && patch.description !== meta.description) {
            meta.description = patch.description;
            touched = true;
        }
        if (patch.retention) {
            meta.retention = { ...meta.retention, ...patch.retention };
            touched = true;
        }
        if (touched) {
            meta.updatedAt = Date.now();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
        }
    } else {
        meta = defaultMeta(id, patch);
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    }
    return { taskId: id, dir, meta };
}

export function readTaskMeta(taskId: unknown): TaskMeta {
    const id = safeSegment(taskId, "taskId");
    const metaPath = path.join(taskDir(id), TASK_META_FILE);
    if (!fs.existsSync(metaPath)) return defaultMeta(id);
    try {
        const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return {
            ...defaultMeta(id),
            ...raw,
            taskId: id,
            retention: { ...DEFAULT_RETENTION, ...(raw?.retention || {}) },
        };
    } catch {
        // meta 坏了不该让整个任务不可用——按默认值继续，下次写入时会被修好
        return defaultMeta(id);
    }
}

export function patchTaskMeta(taskId: unknown, patch: Partial<TaskMeta>): TaskMeta {
    const id = safeSegment(taskId, "taskId");
    const meta = readTaskMeta(id);
    const next: TaskMeta = { ...meta, ...patch, taskId: id, updatedAt: Date.now() };
    fs.writeFileSync(path.join(taskDir(id), TASK_META_FILE), JSON.stringify(next, null, 2), "utf8");
    return next;
}

/** 记一次运行。定时任务跑完调这个，用户的「最近运行」才有数。 */
export function recordRun(taskId: unknown): TaskMeta {
    const id = safeSegment(taskId, "taskId");
    const meta = readTaskMeta(id);
    return patchTaskMeta(id, { lastRunAt: Date.now(), runCount: (meta.runCount || 0) + 1 });
}

// ── 文件操作 ────────────────────────────────────────────────────────

function dirStats(dir: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    const walk = (d: string, depth: number) => {
        if (depth > 16) return; // 防软链成环
        let list: fs.Dirent[];
        try {
            list = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of list) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                walk(p, depth + 1);
            } else if (e.isFile()) {
                // 顶层 meta.json 算「框架文件」，不该算进任务产出量
                if (depth === 0 && e.name === TASK_META_FILE) continue;
                files++;
                try {
                    bytes += fs.statSync(p).size;
                } catch {
                    /* 读到一半被删了就跳过 */
                }
            }
        }
    };
    walk(dir, 0);
    return { files, bytes };
}

export function listFiles(taskId: unknown, relPath = ""): FileEntry[] {
    const id = safeSegment(taskId, "taskId");
    const target = relPath ? resolveInTask(id, relPath) : taskDir(id);
    if (!fs.existsSync(target)) throw new Error(`路径不存在：${relPath || "(任务根目录)"}`);
    if (!fs.statSync(target).isDirectory()) throw new Error(`不是文件夹：${relPath}`);
    // 只在列**任务根目录**时藏掉 meta.json（框架文件，用户不用关心）；
    // 列子目录时它本来就不在那儿，不该误过滤同名的用户文件。
    const atTaskRoot = !relPath;
    const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => !(atTaskRoot && e.name === TASK_META_FILE))
        .sort((a, b) => {
            // 文件夹在前，然后按名字
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name, "zh-CN");
        })
        .slice(0, LIMITS.listEntries)
        .map((e) => {
            const p = path.join(target, e.name);
            let size = 0;
            let mtime = "";
            try {
                const st = fs.statSync(p);
                size = st.size;
                mtime = new Date(st.mtimeMs).toLocaleString("zh-CN");
            } catch {
                /* 忽略 */
            }
            return { name: e.name, dir: e.isDirectory(), size, mtime };
        });
    return entries;
}

export function statPath(taskId: unknown, relPath: unknown): { dir: boolean; size: number; mtime: string } | null {
    const abs = resolveInTask(taskId, relPath);
    if (!fs.existsSync(abs)) return null;
    const st = fs.statSync(abs);
    return { dir: st.isDirectory(), size: st.size, mtime: new Date(st.mtimeMs).toLocaleString("zh-CN") };
}

export function readFile(taskId: unknown, relPath: unknown): string {
    const abs = resolveInTask(taskId, relPath);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${relPath}`);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error(`这是文件夹不是文件：${relPath}，用 ls 看里面`);
    if (st.size > LIMITS.readBytes) {
        throw new Error(
            `文件太大（${(st.size / 1024).toFixed(0)}KB，上限 ${LIMITS.readBytes / 1024}KB），`
            + "请分段读或者先整理一下",
        );
    }
    return fs.readFileSync(abs, "utf8");
}

export function writeFile(taskId: unknown, relPath: unknown, content: string): number {
    const abs = resolveInTask(taskId, relPath);
    const text = String(content == null ? "" : content);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > LIMITS.writeBytes) {
        throw new Error(
            `内容太大（${(bytes / 1024).toFixed(0)}KB，上限 ${LIMITS.writeBytes / 1024}KB），`
            + "分成几个文件写",
        );
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // 写之前确认父目录没被换成文件（mkdir 会抛，但报错信息不友好）
    fs.writeFileSync(abs, text, "utf8");
    return bytes;
}

export function mkdir(taskId: unknown, relPath: unknown): string {
    const abs = resolveInTask(taskId, relPath);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
}

/** 删单个文件或空目录。不给 relPath 就拒——删整个任务要走 removeTask，语义要清楚。 */
export function remove(taskId: unknown, relPath: unknown): { removed: boolean; dir: boolean } {
    const raw = String(relPath == null ? "" : relPath).trim();
    if (!raw) throw new Error("不能删整个任务文件夹（要删整个任务用 rm_task）");
    const abs = resolveInTask(taskId, raw);
    const dir = taskDir(taskId);
    if (path.resolve(abs) === path.resolve(dir)) throw new Error("不能删整个任务文件夹");
    if (!fs.existsSync(abs)) return { removed: false, dir: false };
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
        // 只删空目录：非空目录要她一个个删，避免一条命令抹掉一堆产出
        const rest = fs.readdirSync(abs);
        if (rest.length) throw new Error(`文件夹不是空的（还有 ${rest.length} 项），先清空再删`);
        fs.rmdirSync(abs);
        return { removed: true, dir: true };
    }
    fs.unlinkSync(abs);
    return { removed: true, dir: false };
}

export function removeTask(taskId: unknown): { removed: boolean } {
    const dir = taskDir(taskId);
    if (!fs.existsSync(dir)) return { removed: false };
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true };
}

// ── 保留策略 ────────────────────────────────────────────────────────

interface FileRec {
    abs: string;
    mtime: number;
    size: number;
}

function collectFiles(taskId: string): FileRec[] {
    const dir = taskDir(taskId);
    const out: FileRec[] = [];
    const walk = (d: string, depth: number) => {
        if (depth > 16) return;
        let list: fs.Dirent[];
        try {
            list = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of list) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) {
                walk(p, depth + 1);
            } else if (e.isFile()) {
                if (depth === 0 && e.name === TASK_META_FILE) continue; // 永不清理
                try {
                    const st = fs.statSync(p);
                    out.push({ abs: p, mtime: st.mtimeMs, size: st.size });
                } catch {
                    /* 忽略 */
                }
            }
        }
    };
    walk(dir, 0);
    out.sort((a, b) => a.mtime - b.mtime); // 最旧在前
    return out;
}

/**
 * 按保留策略清理旧产出：先按天数，再按数量，最后按总字节。
 * 三轮都从最旧的开始删，meta.json 永不删。
 */
export function pruneTask(taskId: unknown, policy: Partial<Retention> = {}): { deleted: number; freedBytes: number } {
    const id = safeSegment(taskId, "taskId");
    const meta = readTaskMeta(id);
    const p: Retention = { ...DEFAULT_RETENTION, ...(meta.retention || {}), ...policy };

    let files = collectFiles(id);
    let deleted = 0;
    let freed = 0;
    const drop = (f: FileRec) => {
        try {
            fs.unlinkSync(f.abs);
            deleted++;
            freed += f.size;
            return true;
        } catch {
            return false;
        }
    };

    // 1) 超龄
    if (p.keepDays > 0) {
        const cutoff = Date.now() - p.keepDays * 86400000;
        const keep: FileRec[] = [];
        for (const f of files) {
            if (f.mtime < cutoff) drop(f);
            else keep.push(f);
        }
        files = keep;
    }

    // 2) 超量
    if (p.keepFiles > 0 && files.length > p.keepFiles) {
        const excess = files.length - p.keepFiles;
        const rest: FileRec[] = [];
        for (let i = 0; i < files.length; i++) {
            if (i < excess && drop(files[i])) continue;
            rest.push(files[i]);
        }
        files = rest;
    }

    // 3) 超字节
    if (p.keepBytes > 0) {
        let total = files.reduce((n, f) => n + f.size, 0);
        const rest: FileRec[] = [];
        for (const f of files) {
            if (total > p.keepBytes) {
                if (drop(f)) {
                    total -= f.size;
                    continue;
                }
            }
            rest.push(f);
        }
        files = rest;
    }

    // 顺手清掉删空的子目录（不动任务根目录）
    const sweepEmpty = (d: string, depth: number) => {
        if (depth > 16) return;
        let list: fs.Dirent[];
        try {
            list = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of list) {
            if (e.isDirectory()) sweepEmpty(path.join(d, e.name), depth + 1);
        }
        if (depth > 0) {
            try {
                if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
            } catch {
                /* 忽略 */
            }
        }
    };
    try {
        sweepEmpty(taskDir(id), 0);
    } catch {
        /* 忽略 */
    }

    return { deleted, freedBytes: freed };
}

export function pruneAll(): { deleted: number; freedBytes: number } {
    let deleted = 0;
    let freed = 0;
    for (const t of listTasks()) {
        try {
            const r = pruneTask(t.taskId);
            deleted += r.deleted;
            freed += r.freedBytes;
        } catch (e) {
            console.warn(`[workspace] 清理任务 ${t.taskId} 失败:`, (e as Error)?.message || e);
        }
    }
    return { deleted, freedBytes: freed };
}

// ── 列表与概览 ──────────────────────────────────────────────────────

export function listTasks(): TaskListItem[] {
    const root = resolveRoot();
    if (!fs.existsSync(root)) return [];
    const out: TaskListItem[] = [];
    let list: fs.Dirent[];
    try {
        list = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    for (const e of list) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(".")) continue; // 元信息文件之类
        try {
            const meta = readTaskMeta(e.name);
            const stats = dirStats(path.join(root, e.name));
            out.push({
                taskId: e.name,
                dir: path.join(root, e.name),
                title: meta.title || e.name,
                files: stats.files,
                bytes: stats.bytes,
                lastRunAt: meta.lastRunAt ? new Date(meta.lastRunAt).toLocaleString("zh-CN") : null,
                lastRunMs: meta.lastRunAt || 0,
                runCount: meta.runCount || 0,
            });
        } catch {
            /* 目录名不合法或读不到，跳过 */
        }
    }
    // 最近跑过的排前面 —— 用户打开概览时最关心这个
    out.sort((a, b) => {
        if (a.lastRunMs !== b.lastRunMs) return b.lastRunMs - a.lastRunMs;
        return a.taskId.localeCompare(b.taskId);
    });
    return out;
}

export function overview(): {
    root: string;
    exists: boolean;
    tasks: number;
    files: number;
    bytes: number;
    list: TaskListItem[];
} {
    const root = resolveRoot();
    const exists = fs.existsSync(root);
    const list = exists ? listTasks() : [];
    return {
        root,
        exists,
        tasks: list.length,
        files: list.reduce((n, t) => n + t.files, 0),
        bytes: list.reduce((n, t) => n + t.bytes, 0),
        list,
    };
}
