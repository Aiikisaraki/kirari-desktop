/**
 * 设置分区表 —— 侧栏导航和页头共用这一份。
 *
 * 两端的顺序、分组、文案**必须一致**：核心版只是没有「形象」（那是桌宠皮肤），
 * 其余分区的 id / 标题 / 一句话描述都和桌宠端逐字对应。
 * 组件目录里的文件名也按这里的 id 命名，别再出现"模型/大脑"两种叫法。
 */

export interface SettingsItem {
    /** 分组 id，同时也是组件文件名（ModelSettings.vue → model） */
    id: string;
    /** 侧栏文字 */
    label: string;
    /** 页头标题 */
    title: string;
    /** 页头下方的一句话说明 */
    desc: string;
    /** SettingsIcon 的图标名 */
    icon: string;
    /**
     * 条件显示：只有当对应的扩展包已安装时才出现在导航里。
     * 值是扩展包 manifest 里的 contribution id（如 speech.tts）。
     * 未装包时这一项被过滤掉 —— 这就是「装了扩展才有标签页」的机制。
     */
    requiresExtension?: string;
}

export interface SettingsGroup {
    id: string;
    label: string;
    items: SettingsItem[];
}

/**
 * 过滤掉 requiresExtension 指向的扩展包未安装的条目。
 * 扩展包清单来自主进程（ext:installed），没有宿主时视为全未安装。
 */
export function filterGroupsByExtensions(
    groups: SettingsGroup[],
    installedServiceIds: Set<string>,
): SettingsGroup[] {
    return groups
        .map((g) => ({
            ...g,
            items: g.items.filter(
                (it) => !it.requiresExtension || installedServiceIds.has(it.requiresExtension),
            ),
        }))
        .filter((g) => g.items.length > 0);
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
    {
        id: "device",
        label: "本机",
        items: [
            {
                id: "appearance",
                label: "外观",
                title: "外观",
                icon: "sparkles",
                desc: "换一套界面配色。切换即时生效，只影响观感，不动任何数据。",
            },
            {
                id: "avatar",
                label: "形象",
                title: "形象",
                icon: "paw",
                desc: "换一只桌宠。每个形象自带立绘与动作，换完立刻出现在桌面上。",
            },
        ],
    },
    {
        id: "identity",
        label: "身份",
        items: [
            {
                id: "general",
                label: "通用",
                title: "通用",
                icon: "sliders",
                desc: "她的名字，以及开机时要不要自动出现。",
            },
            {
                id: "profile",
                label: "个人",
                title: "个人",
                icon: "user",
                desc: "聊天时代表你的那张头像。图片只留在本机。",
            },
            {
                id: "persona",
                label: "人格",
                title: "人格",
                icon: "heart",
                desc: "她是谁、怎么说话。换模型、换设备都不会变的那一层。",
            },
        ],
    },
    {
        id: "ability",
        label: "能力",
        items: [
            {
                id: "voice",
                label: "语音",
                title: "语音",
                icon: "chat",
                desc: "让她开口说话：音色库下载与管理。需要安装语音扩展包。",
                requiresExtension: "speech.tts",
            },
            {
                id: "bili",
                label: "B站互动",
                title: "B站互动",
                icon: "globe",
                desc: "评论/动态/私信/点赞/投币/收藏六个开关。命令与这里双向同步，需要安装 B站扩展包。",
                requiresExtension: "bili.explore",
            },
            {
                id: "model",
                label: "模型",
                title: "模型",
                icon: "cpu",
                desc: "接哪家大模型，以及回答实时问题时的搜索渠道。",
            },
            {
                id: "skill",
                label: "技能",
                title: "技能",
                icon: "wand",
                desc: "给她加行为模板或可调用的工具。",
            },
            {
                id: "knowledge",
                label: "知识库",
                title: "知识库",
                icon: "book",
                desc: "你希望她记住的事实，以及可以实时去查的远程来源。",
            },
            {
                id: "mcp",
                label: "工具服务",
                title: "工具服务",
                icon: "plug",
                desc: "接入外部 MCP 服务，让她能读写文件、查资料、调接口。",
            },
        ],
    },
    {
        id: "connect",
        label: "连接",
        items: [
            {
                id: "bot",
                label: "机器人",
                title: "机器人",
                icon: "bot",
                desc: "接 QQ / OneBot，让她在聊天软件里也能回你。",
            },
            {
                id: "sync",
                label: "组网",
                title: "组网",
                icon: "sync",
                desc: "几台设备共用一个大脑：一台当主机，其余接进来。",
            },
        ],
    },
];
