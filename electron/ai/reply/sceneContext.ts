// electron/ai/reply/sceneContext.ts
// 「当前场合」注入段（与核心版 src/services/reply/sceneContext.js 逐字对应，改一边必须同步）。
//
// 背景（2026-11-19 用户反馈）：
//   1. 共享一个身份后，各对话窗口决策僵化——她不知道自己在群聊还是私聊，
//      也不知道群里还有别人，于是只能退回到一套最安全的固定卖萌句式。
//   2. 更危险的是隐私：私聊里商量的事、自己的设置/排查细节，可能被她在群里直接说出来。
//
// 本模块只做「把场合翻译成模型能读懂的一段话」，不负责存储与路由。

export type SceneChatType = "group" | "private" | "channel" | "dm" | "local";

/** 各入口传进来的场合字段（形状不一，统一在 normalizeScene 收口）。 */
export interface RawScene {
    chatType?: string;
    messageType?: string;
    isGroup?: boolean;
    groupId?: string | number;
    groupName?: string;
    senderName?: string;
    senderRole?: string;
    senderId?: string | number;
    isOwner?: boolean;
    /** 管理权限角色：owner / admin / user。只影响能改什么设置，不影响如何称呼或相处。 */
    role?: string;
    memberCount?: number;
    platform?: string;
}

export interface NormalizedScene {
    type: SceneChatType;
    groupName: string;
    groupId: string;
    senderName: string;
    senderRole: string;
    isOwner: boolean;
    humanCount: number;
    platform: string;
}

/** 归一化场合字段。缺字段按最保守的一对一处理。 */
export function normalizeScene(raw?: RawScene | null): NormalizedScene {
    const s = raw && typeof raw === "object" ? raw : {};
    const chatType = String(s.chatType || s.messageType || "").toLowerCase();
    const type: SceneChatType =
        chatType === "group" || chatType === "channel"
            ? "group"
            : chatType === "dm"
              ? "dm"
              : chatType === "private" || chatType === "c2c"
                ? "private"
                : s.isGroup
                  ? "group"
                  : s.groupId
                    ? "group"
                    : "local";
    return {
        type,
        groupName: typeof s.groupName === "string" ? s.groupName.trim() : "",
        groupId: s.groupId != null ? String(s.groupId) : "",
        senderName: typeof s.senderName === "string" ? s.senderName.trim() : "",
        senderRole: typeof s.senderRole === "string" ? s.senderRole.trim() : "",
        isOwner: !!s.isOwner,
        humanCount: typeof s.memberCount === "number" && s.memberCount > 0 ? s.memberCount : 0,
        platform: typeof s.platform === "string" ? s.platform.trim() : "",
    };
}

/** 场合的一句话描述（群名优先，退化成群号）。 */
function describePlace(sc: NormalizedScene): string {
    if (sc.type === "group") {
        const name = sc.groupName ? `「${sc.groupName}」` : sc.groupId ? `（群号 ${sc.groupId}）` : "";
        const size = sc.humanCount ? `，群里有约 ${sc.humanCount} 人` : "，群里有其他人";
        return `群聊${name}${size}`;
    }
    if (sc.type === "dm") return "私信（其他人看不到）";
    if (sc.type === "private") return "一对一私聊（只有你们两个人）";
    return "一对一对话（只有你们两个人）";
}

/**
 * 生成注入 system.base 的场合段：场合 + 群聊隐私红线 + 「别像模板」的语气要求。
 */
export function buildSceneContext(raw?: RawScene | null): string {
    const sc = normalizeScene(raw);
    const isGroup = sc.type === "group";
    const lines: string[] = [];

    lines.push("\n\n【当前场合 · 说话前先看清你在哪】");
    lines.push(`- 你现在在：${describePlace(sc)}。`);
    if (sc.senderName) {
        const role = sc.senderRole ? `（${sc.senderRole}）` : "";
        // 不要把在场的人分成「主人 / 不是主人」——那会让她对每个人都用同一套腔调。
        // 每个人都是独立的一个人，她有各自对这个人的记忆和相处方式；
        // "拥有者"只是管理权限上更高的那一位，不是更亲近的那一位。
        lines.push(`- 此刻对你说话的是：${sc.senderName}${role}。`);
    }
    if (sc.isOwner) {
        lines.push("- 他是拥有者，对你的设定有最高管理权。但这只说明他能改你的设置，不代表你们的关系比别人更近——按你们实际相处的样子说话就行。");
    }

    if (isGroup) {
        lines.push("- ⚠️ 这是**群聊**：你打的每个字群里所有人都看得见。");
        lines.push("  · 不要说出任何私聊内容、也不要暗示“我们私下聊过”“之前你跟我说”这类话。");
        lines.push(
            "  · 不要公开别人的个人设置、模型/密钥、位置、日程细节、你自己的内部排查过程（self_read / self_update / 审计日志等）。",
        );
        lines.push("  · 在场其他人各自的私事，此刻一律别提、也别暗示你知道。");
        lines.push("  · 别人问起私事，可以自然带过（“这个不方便在这儿说”），不用解释原因。");
        lines.push("  · 不用每次都对所有人热情招呼；被 @ 到、或话题正好跟你有关时再开口。");
        lines.push("  · 群里的语气通常收一点：短、平、像在场的一个熟人，不必句句卖萌。");
    } else {
        lines.push("- 这是只有你们两个人的场合，可以放松一些、更亲近自然，不用像在群里那样收着。");
    }

    lines.push("");
    lines.push("【说话要求 · 别像模板】");
    lines.push("- 你的性格是稳定的（这点不要变），但**表达方式要跟着场合和情绪变**。真人不会每句话都同一个句式。");
    lines.push("- 不要固定套路：别总是「称呼 + 语气词 + 颜文字 + 反问关心」三件套连着来。");
    lines.push(
        "- 少用语气词和波浪号（啦 / 哦 / 呢 / 嘛 / 呀 / ～）。一整段里有一两个就够，很多时候一个都不用反而更像真人。",
    );
    lines.push("- 不要每句都用反问收尾（“要不要？”“是不是呀？”）。想说什么直接说。");
    lines.push("- 短一点更像真人：一句能说完就别铺成三句。不确定说什么时，简短回应比长篇更自然。");
    lines.push("- 别用 AI 腔：不要说“作为一个…”、“希望这对你有帮助”、“总结一下”，也不要每次都分点列举。");

    return lines.join("\n");
}
