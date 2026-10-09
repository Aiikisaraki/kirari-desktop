import type { InjectionKey } from "vue";

/**
 * 设置页跨区块共享的上下文。
 *
 * 桌宠本机运行、不设账户，也不区分本地/远程部署模式，
 * 因此这里不再携带鉴权态与模式字段。保留这个注入点，
 * 是为了后续加入「组网」等跨区块共享状态时不用改动各设置页的注入方式。
 */
export interface SettingsContext {
    // 暂无跨区块共享状态；保留空接口以便后续扩展。
}

export const SETTINGS_CONTEXT = Symbol(
    "settings-context",
) as InjectionKey<SettingsContext>;
