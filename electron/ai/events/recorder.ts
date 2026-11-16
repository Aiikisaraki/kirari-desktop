// electron/ai/events/recorder.ts
// 桌宠端侧的事件记录器单例。共享包只放纯逻辑，这里负责接 EventStore、读开关、
// 维护「当前轮次」，以及进程退出兜底。与核心版 src/session/eventRecorder.js 对称。

import { createRecorder } from "kirari-agent";
import type { EventRecorder } from "kirari-agent";
import { eventStore } from "./store";
import { getSetting } from "../db/storage";

// 存储层挂钩发生在 getReply 之前（入口先存 user 消息），那时还没有轮次，
// 统一记为 "ui"。UI 消息事件不要求与 turn 严格对齐，投影按 sessionId + seq 走。
const NO_TURN = "ui";
let activeTurnId: string | null = null;

export function newTurnId(): string {
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function currentTurnId(): string {
    return activeTurnId || NO_TURN;
}

export function beginTurn(turnId?: string): string {
    activeTurnId = turnId || newTurnId();
    return activeTurnId;
}

export function endTurn(): void {
    activeTurnId = null;
}

export const recorder: EventRecorder = createRecorder(eventStore, {
    // 红线：事件写失败只警告，绝不冒泡到用户。
    onWarn: (message, err) => console.warn(message, err instanceof Error ? err.message : (err ?? "")),
});

/**
 * 开关来自 settings_kv.events_enabled（缺省启用），不新增任何配置字段。
 * 读失败时按启用处理并告警，不让「设置读不到」变成静默不记事件。
 *
 * ⚠️ 关键差异（相对核心版）：**不在模块顶层调用**。
 *    engine.ts 顶层就 import 了 conversationService → 本模块，而 initDatabase()
 *    要等 initEngine() 才执行。顶层读表会让 getDb() 走兜底路径，额外建出一个
 *    ~/.akisaki-kirari/kirari.db，与真实 userData 库对不上。
 *    改由 getReply 在每轮开始时刷新一次，那时数据库必然已就绪。
 */
export function refreshEnabled(): void {
    try {
        const value = getSetting("events_enabled");
        recorder.setEnabled(value !== "0");
    } catch (e) {
        console.warn("[events] 读取事件开关失败，按启用处理：", (e as Error)?.message || e);
        recorder.setEnabled(true);
    }
}

// 进程退出兜底：把队列里剩余事件同步落库，避免丢最后几条。
// 主路径是 conversationService 每轮 finally 的 flush，这里只是额外保险。
process.on("beforeExit", () => recorder.flushSync());
