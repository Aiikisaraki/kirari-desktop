// electron/ai/local-session.ts
// 「本机会话」真源：这台机器上「我」和这只桌宠的**同一个对话**的会话 id。
//
// 与核心版 src/session/localSession.js 是同一份规则、同一个文件
// （userData/local-session.json）—— 两端读写同一份记录，所以记录天然互通。
//
// ── 为什么必须有这个东西 ──────────────────────────────────────────────
// 以前桌宠版的 sessionId 是构造时 `crypto.randomUUID()`，只存在内存里，
// **从不落盘**。于是每次启动都是一个全新的会话：上一段对话留在库里
// 但永远读不到了（表现就是「聊天框一重启就只剩欢迎语」）。
//
// 修法：把会话 id 落到 userData/local-session.json，两端共用、跨重启稳定：
//   · 桌宠重启 → 还是同一个会话，历史立刻回来；
//   · 核心版控制台打开 → 看到的是同一段对话；
//   · 又是**每台机器唯一**的（不是写死常量）——组网时主机按 sessionId 取上下文，
//     两台机器写死同一个 id 会把两边的上下文搅在一起。
//
// ⚠️ 机器人会话（bot-*）永远独立，不参与收口：那是 QQ 群里多方的对话。
import fs from "fs";
import path from "path";
import crypto from "crypto";
import * as db from "./db/storage";

const FILE = "local-session.json";
/** 不参与「本机会话」收口的会话前缀（每个前缀是一类独立对话）。 */
export const FOREIGN_SESSION_PREFIXES = ["bot-"];

const SESSION_ID_RE = /^[a-zA-Z0-9:_-]{1,80}$/;

export function localSessionFilePath(userDataDir: string): string {
    return path.join(userDataDir, FILE);
}

function readFile(userDataDir: string): string {
    try {
        const raw = JSON.parse(fs.readFileSync(localSessionFilePath(userDataDir), "utf-8"));
        const id = raw && typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
        return SESSION_ID_RE.test(id) ? id : "";
    } catch {
        return "";
    }
}

/** 仅当文件不存在时创建；已存在则沿用已有 id，避免两端同时启动各写各的。 */
function createFile(userDataDir: string, sessionId: string): string {
    const file = localSessionFilePath(userDataDir);
    try {
        fs.writeFileSync(file, JSON.stringify({ sessionId }, null, 2), { encoding: "utf-8", flag: "wx" });
        return sessionId;
    } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
            // 另一个进程（核心版）刚好先建了 → 用它的，保证两端同一个会话
            const existing = readFile(userDataDir);
            if (existing) return existing;
        }
        console.warn(
            "[local-session] 写入失败（本次用内存里的 id，重启可能换会话）:",
            (e as Error)?.message || e,
        );
        return sessionId;
    }
}

/** 是不是「本机人机对话」的会话（机器人会话排除在外）。 */
export function isLocalSession(sessionId: string): boolean {
    return !FOREIGN_SESSION_PREFIXES.some((p) => String(sessionId).startsWith(p));
}

/**
 * 拿到（必要时创建/收口）本机会话 id。幂等，每次启动可调多次。
 *
 * 收口逻辑：库里凡是「本机对话」的会话都并进这一个 id ——
 * 修复的正是旧版本每次启动重掷 sessionId 留下的那堆孤儿会话。
 */
export async function ensureLocalSessionId(userDataDir: string, opts?: { quiet?: boolean }): Promise<string> {
    const quiet = !!opts?.quiet;
    let id = readFile(userDataDir);
    let created = false;

    if (!id) {
        // 首次：优先采纳库里已有的最近一段本机对话（用户立刻能看回老记录），
        // 库里什么都没有才新建一个。
        let all: string[] = [];
        try {
            all = await db.listSessions();
        } catch (e) {
            console.warn("[local-session] 读取会话列表失败:", (e as Error)?.message || e);
        }
        id = all.filter(isLocalSession)[0] || crypto.randomUUID();
        created = true;
    }

    // 收口：其余本机会话并进来
    try {
        const all = await db.listSessions();
        const others = all.filter((s) => isLocalSession(s) && s !== id);
        if (others.length) {
            const moved = await db.mergeSessions(others, id);
            if (!quiet && moved > 0) {
                console.log(`[local-session] 已把 ${others.length} 段早期会话（共 ${moved} 条记录）并进本机会话`);
            }
        }
    } catch (e) {
        console.warn("[local-session] 合并早期会话失败（不影响新消息）:", (e as Error)?.message || e);
    }

    if (created) {
        const finalId = createFile(userDataDir, id);
        if (!quiet) console.log(`[local-session] 本机会话已确定：${finalId.slice(0, 8)}…（与核心版共用）`);
        id = finalId;
    }
    return id;
}
