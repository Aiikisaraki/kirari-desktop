import type { InjectionKey, Ref } from "vue";

/**
 * 设置页跨区块共享的上下文。
 *
 * 桌宠本机运行、不设账户，也不区分本地/远程部署模式，
 * 因此这里不再携带鉴权态与模式字段。保留这个注入点，
 * 是为了后续加入「组网」等跨区块共享状态时不用改动各设置页的注入方式。
 */
export interface SettingsContext {
    /**
     * 叶子节点：**机器人（协议端）设置**只读。
     *
     * 用户拍板：「一旦成为叶子，这个机器人都统一从主节点走，叶子节点时这个设置就灰掉，
     * 里面东西锁定不可设置。」——指的只是机器人这一块。QQ/OneBot 连接跑在主机上，
     * 叶子上配了也不生效。
     *
     * 模型/人格/搜索**不读这个值**：叶子上改了要能同步回主机
     * （onModelConfigChanged → notifyLocalConfigChanged → 主机按白名单裁决）。
     * 组网设置页（SyncSettings）也不读它——要留退出叶子的入口。
     */
    botReadonly: Ref<boolean>;
}

export const SETTINGS_CONTEXT = Symbol(
    "settings-context",
) as InjectionKey<SettingsContext>;
