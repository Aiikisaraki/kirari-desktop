// electron/ai/presence/stateStore.ts
// PresenceState 的落盘层：settings_kv 单键 JSON，原子写、坏档自愈。
//
// ── 为什么放 settings_kv 而不是独立文件 ────────────────────────────
// 方案里原本建议 ~/.kirari/presence/<uid>.json，但看了 db/storage.ts 之后改主意：
// settings_kv 已经是「单值小状态」的既定去处（简报档位锁、组网设置都在这），
// better-sqlite3 的事务写入比手写「临时文件 + rename」更原子，也不用新管一个目录。
// 键名带 uid，和记忆/简报的隔离口径一致。
//
// ── 坏档自愈 ────────────────────────────────────────────────────────
// 状态文件是**可再生数据**（驱动会衰减回去、账本会重新积累），
// 所以解析失败时宁可重置也不抛错 —— 绝不能让一个坏 JSON 把对话主流程挂掉。

import * as db from "../db/storage";
import { LOCAL_UID } from "../db/storage";
import type { PresenceState } from "./types";
import { createInitialState } from "./purpose";

const KEY = (uid: number) => `presence_state:${uid}`;

/** 读状态。没有/坏档/版本不认 → 返回 null（调用方决定用 createInitialState 兜底）。 */
export function loadPresenceState(uid: number = LOCAL_UID): PresenceState | null {
    try {
        const raw = db.getSetting(KEY(uid));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PresenceState;
        if (!parsed || parsed.version !== 1 || typeof parsed.drives !== "object" || !parsed.drives) {
            console.warn("[presence] 状态档版本/形状不认，按全新状态处理");
            return null;
        }
        // 旧档可能没有 recentNeeds（该字段是后来加的）：补默认值而不是整档作废
        if (!Array.isArray(parsed.recentNeeds)) parsed.recentNeeds = [];
        return parsed;
    } catch (e) {
        console.warn("[presence] 状态档解析失败（按全新状态处理）:", e instanceof Error ? e.message : e);
        return null;
    }
}

/** 读状态，没有就建一个新的（以 now 为基准）。 */
export function loadOrInitPresenceState(now: number, uid: number = LOCAL_UID): PresenceState {
    return loadPresenceState(uid) ?? createInitialState(now);
}

/** 写状态。失败只告警 —— 内在状态丢一轮可以接受，对话主流程不能挂。 */
export function savePresenceState(state: PresenceState, uid: number = LOCAL_UID): void {
    try {
        db.setSetting(KEY(uid), JSON.stringify(state));
    } catch (e) {
        console.warn("[presence] 状态写入失败（本轮改动丢弃）:", e instanceof Error ? e.message : e);
    }
}
