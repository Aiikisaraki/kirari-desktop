// electron/ai/events/store.ts
// EventStore 适配器：把 kirari-agent 的纯契约接到桌宠端已有的 better-sqlite3 连接上。
//
// 与核心版 src/session/eventStore.js 对称：共享包只定义契约，db 连接由两端各自注入。
// 这里直接复用 storage.getDb()，不新开连接 —— 桌宠进程内只有一份 pet_sessions.db，
// 核心版本地模式拉起的子进程写的是同一个文件，靠 WAL + busy_timeout 并发写。
//
// ⚠️ 顶层只 import getDb 这个函数，不在模块加载期调用它：engine.ts 顶层就 import
//    了 conversationService → recorder → 本文件，而 initDatabase() 要等 initEngine()
//    才执行。真正取连接发生在 append/query/maxSeq 被调用时，那时库必然已就绪。

import {
    SESSION_EVENTS_TABLE,
    SCHEMA_VERSION,
    DEFAULT_EVENT_QUERY_LIMIT,
    MAX_EVENT_QUERY_LIMIT,
} from "kirari-agent";
import type { AgentEvent, EventQuery, EventStore } from "kirari-agent";
import { getDb } from "../db/storage";

function parsePayload(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch (e) {
        // 显式告警，不静默吞：坏 payload 会让投影结果不完整，必须能被发现。
        console.warn("[events] 事件 payload 不是合法 JSON，按空对象处理：", (e as Error)?.message || e);
        return {};
    }
}

type EventRow = {
    seq: number;
    origin: string;
    event_id: string;
    session_id: string;
    turn_id: string;
    ts: number;
    schema_ver: number;
    type: string;
    payload: string;
};

function toAgentEvent(row: EventRow): AgentEvent {
    return {
        schemaVersion: row.schema_ver,
        origin: row.origin as AgentEvent["origin"],
        eventId: row.event_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        seq: row.seq,
        ts: row.ts,
        type: row.type as AgentEvent["type"],
        payload: parsePayload(row.payload),
    };
}

export const eventStore: EventStore = {
    // INSERT OR IGNORE 配合 UNIQUE(origin, event_id)：批量 flush 重试不会重复落事件。
    append(events): void {
        if (!events || events.length === 0) return;
        const stmt = getDb().prepare(`
            INSERT OR IGNORE INTO ${SESSION_EVENTS_TABLE}
                (origin, event_id, session_id, turn_id, ts, schema_ver, type, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const e of events) {
            stmt.run(
                e.origin,
                e.eventId,
                e.sessionId,
                e.turnId,
                e.ts,
                e.schemaVersion ?? SCHEMA_VERSION,
                e.type,
                JSON.stringify(e.payload ?? {}),
            );
        }
    },

    query(q: EventQuery): AgentEvent[] {
        const where = ["session_id = ?"];
        const args: (string | number)[] = [q.sessionId];
        if (q.fromSeq !== undefined) { where.push("seq > ?"); args.push(q.fromSeq); }
        if (q.toSeq !== undefined) { where.push("seq <= ?"); args.push(q.toSeq); }
        if (q.turnId) { where.push("turn_id = ?"); args.push(q.turnId); }
        if (q.types && q.types.length > 0) {
            where.push(`type IN (${q.types.map(() => "?").join(", ")})`);
            args.push(...q.types);
        }
        const n = Math.min(MAX_EVENT_QUERY_LIMIT, Math.max(1, q.limit ?? DEFAULT_EVENT_QUERY_LIMIT));
        args.push(n);
        const rows = getDb().prepare(
            `SELECT seq, origin, event_id, session_id, turn_id, ts, schema_ver, type, payload
             FROM ${SESSION_EVENTS_TABLE}
             WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
        ).all(...args) as EventRow[];
        return rows.map(toAgentEvent);
    },

    maxSeq(sessionId?: string): number {
        const db = getDb();
        const row = sessionId
            ? (db.prepare(`SELECT MAX(seq) AS m FROM ${SESSION_EVENTS_TABLE} WHERE session_id = ?`).get(sessionId) as
                | { m: number | null }
                | undefined)
            : (db.prepare(`SELECT MAX(seq) AS m FROM ${SESSION_EVENTS_TABLE}`).get() as
                | { m: number | null }
                | undefined);
        return row?.m ?? 0;
    },
};
