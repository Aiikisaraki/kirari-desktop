// electron/ai/presence/presenceIO.ts
// 在场感在「对话主流程」侧的只读入口。
//
// 为什么不直接 import stateStore + presenceBlock：
// conversationService 是全仓被引用最多的模块，把它直接绑到两个内部文件上，
// 以后改内部结构就会牵动主流程。收口成一个门面，主流程只认识这一个名字。

import { loadOrInitPresenceState as loadState } from "./stateStore";
import { buildPresenceBlock as buildBlock, summarizePresence as summarize, buildPaceBlock as buildPace } from "./presenceBlock";
import { isOwnerLocalSession } from "./presenceHooks";

export function loadOrInitPresenceState(now: number) {
    return loadState(now);
}

export function buildPresenceBlock(state: ReturnType<typeof loadState>, now: number): string {
    return buildBlock(state, now);
}

export function summarizePresence(state: ReturnType<typeof loadState>, now: number): string {
    return summarize(state, now);
}

export function buildPaceBlock(state: ReturnType<typeof loadState>, now: number): string {
    return buildPace(state, now);
}

export { isOwnerLocalSession };
