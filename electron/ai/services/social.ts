// electron/ai/services/social.ts
// 社交环境服务（桌宠版）—— 与核心版 src/services/social.js 同语义。
//
// 用户 2026-11-19 原话：
//   「我希望她至少管理会话的能力是完整的，能看到机器人协议端的所有能力接口，
//     看到几个好友，几个群，谁加群了，谁戳一下了，群里有几个人…………一系列。
//     我希望她能完整意识到自己的人际关系和周围的环境。」
//
// 她当时的回答「我没有能查看『加入了哪些群』的接口」是真话：适配器只调过
// get_login_info / get_image，notice 帧被整包丢弃。这一层负责把协议端的
// 事实缓存下来、把事件记成流水、并产出可注入提示词的自然语言摘要。
//
// ⚠️ 两端共用同一个 SQLite 库，字段语义必须与核心版完全一致。

import * as storage from "../db/storage";

/** 支持社交同步的适配器类型（目前只有 OneBot v11 有这套接口）。 */
export type SocialCapableAdapter = {
    id: string;
    config?: Record<string, unknown>;
    fetchGroupList?: () => Promise<SocialGroupPayload[] | null>;
    fetchFriendList?: () => Promise<SocialContactPayload[] | null>;
    fetchGroupMemberList?: (groupId: string) => Promise<SocialMemberPayload[] | null>;
};

export type SocialGroupPayload = {
    groupId: string;
    groupName?: string | null;
    memberCount?: number | null;
    maxMemberCount?: number | null;
};
export type SocialContactPayload = { userId: string; nickname?: string | null; remark?: string | null };
export type SocialMemberPayload = {
    userId: string;
    nickname?: string | null;
    card?: string | null;
    role?: string | null;
};

export type SocialEvent = {
    adapterId: string;
    eventType: string;
    groupId?: string | null;
    actorId?: string | null;
    targetId?: string | null;
    detail?: string | null;
};

export function supportsSocial(adapter: SocialCapableAdapter | null | undefined): boolean {
    return !!adapter && typeof adapter.fetchGroupList === "function";
}

/**
 * 全量同步一个适配器的社交环境。
 */
export async function syncAdapter(
    adapter: SocialCapableAdapter | null | undefined,
    cfg: Record<string, unknown> = {},
): Promise<{ ok: boolean; reason?: string; groups: number; friends: number; members: number }> {
    const adapterId = adapter?.id;
    const result = { ok: false, groups: 0, friends: 0, members: 0 } as {
        ok: boolean;
        reason?: string;
        groups: number;
        friends: number;
        members: number;
    };
    if (!adapterId) return { ...result, reason: "no_adapter" };
    if (!supportsSocial(adapter)) return { ...result, reason: "unsupported" };

    result.ok = true;

    try {
        const groups = await adapter!.fetchGroupList!();
        if (Array.isArray(groups)) {
            await storage.upsertSocialGroups(adapterId, groups);
            result.groups = groups.length;
        }
    } catch (e) {
        console.warn("[social] 拉群列表失败（已忽略）:", e instanceof Error ? e.message : e);
    }

    try {
        const friends = await adapter!.fetchFriendList!();
        if (Array.isArray(friends)) {
            await storage.upsertSocialContacts(adapterId, friends);
            result.friends = friends.length;
        }
    } catch (e) {
        console.warn("[social] 拉好友列表失败（已忽略）:", e instanceof Error ? e.message : e);
    }

    // 群成员：只同步人数合理的群（超大群拉一次很贵，意义有限）
    try {
        const groupRows = await storage.listSocialGroups(adapterId);
        for (const g of groupRows) {
            if (typeof g.memberCount === "number" && g.memberCount > 500) continue;
            const members = await adapter!.fetchGroupMemberList!(g.groupId);
            if (Array.isArray(members)) {
                await storage.replaceGroupMembers(adapterId, g.groupId, members);
                result.members += members.length;
            }
        }
    } catch (e) {
        console.warn("[social] 拉群成员失败（已忽略）:", e instanceof Error ? e.message : e);
    }

    // 「我在这群能不能说话」：与适配器配置保持一致
    try {
        await storage.syncGroupReplyFlags(adapterId, {
            groupReplyMode: cfg.groupReplyMode as string | undefined,
            groupFilter: cfg.groupFilter as string | undefined,
            groupAllowlist: cfg.groupAllowlist as string[] | undefined,
            groupBlocklist: cfg.groupBlocklist as string[] | undefined,
        });
    } catch (e) {
        console.warn("[social] 同步群回复开关失败（已忽略）:", e instanceof Error ? e.message : e);
    }

    return result;
}

/** 只刷新单个群的成员（有人进群/退群时用，比全量便宜）。 */
export async function refreshGroup(
    adapter: SocialCapableAdapter | null | undefined,
    groupId: string,
): Promise<{ ok: boolean; members?: number; reason?: string }> {
    if (!supportsSocial(adapter)) return { ok: false, reason: "unsupported" };
    const members = await adapter!.fetchGroupMemberList!(String(groupId));
    if (!Array.isArray(members)) return { ok: false, reason: "unsupported" };
    await storage.replaceGroupMembers(adapter!.id, String(groupId), members);
    try {
        await storage.upsertSocialGroups(adapter!.id, [{ groupId: String(groupId), memberCount: members.length }]);
    } catch {
        /* 人数更新失败不影响成员表 */
    }
    return { ok: true, members: members.length };
}

/**
 * 记录一条环境事件（notice / request）。
 */
export async function recordEvent(evt: SocialEvent): Promise<boolean> {
    const adapterId = String(evt?.adapterId || "");
    const eventType = String(evt?.eventType || "");
    if (!adapterId || !eventType) return false;
    return storage.addSocialEvent({
        adapterId,
        eventType,
        groupId: evt.groupId || null,
        actorId: evt.actorId || null,
        targetId: evt.targetId || null,
        detail: evt.detail || null,
    });
}

/** 成员数发生变化的事件类型（需要刷新成员表）。 */
export function affectsMembership(eventType: string): boolean {
    const t = String(eventType || "");
    return t.startsWith("group_increase") || t.startsWith("group_decrease");
}

/**
 * 她当前所处的社交环境摘要 —— 给人看的自然语言，不是 JSON。
 * 注入提示词用，让她不用查工具也知道"我在哪、周围有谁"。
 */
export async function buildEnvironmentBlock(opts: { adapterId?: string | null } = {}): Promise<string> {
    try {
        const overview = await storage.socialOverview(opts.adapterId || null);
        if (!overview.groups && !overview.contacts) return "";

        const lines: string[] = [];
        lines.push("\n\n【你周围的环境 · 这些是事实，不用猜】");
        if (opts.adapterId) lines.push(`- 接入方式：${opts.adapterId}（OneBot 协议端）。`);
        lines.push(
            `- 你在 ${overview.groups} 个群里，通讯录里有 ${overview.contacts} 个好友；` +
                `这些群里一共有 ${overview.members} 个不同的人。`,
        );
        if (overview.people) lines.push(`- 到目前为止真正跟你说过话的有 ${overview.people} 个人。`);

        const groups = await storage.listSocialGroups(opts.adapterId || null);
        if (groups.length) {
            const shown = groups.slice(0, 12).map((g) => {
                const n = typeof g.memberCount === "number" ? `${g.memberCount} 人` : "人数未知";
                const name = g.groupName || `群 ${g.groupId}`;
                return `${name}（${n}，${g.replyEnabled ? "你在群里会回话" : "你在这个群不说话"}）`;
            });
            lines.push(`- 具体的群：${shown.join("；")}${groups.length > 12 ? `；等共 ${groups.length} 个` : ""}。`);
        }

        // 最近发生的事：谁进群了、谁戳你了
        const events = await storage.listSocialEvents({ adapterId: opts.adapterId || null, limit: 8 });
        if (events.length) {
            const shown = events.map((e) => `${friendlyEventTime(e.createdAt)} ${describeEvent(e)}`);
            lines.push(`- 最近周围发生的事（新的在前）：${shown.join("；")}。`);
        }

        lines.push("- 这些是协议端给的真实数据，跟\"你记得什么\"是两回事；被问到直接照着答，别说不清楚。");
        return lines.join("\n");
    } catch (e) {
        // 环境摘要是增强项，读失败就当没有，不能让整轮回复挂掉
        console.warn("[social] 环境摘要构建失败（已忽略）:", e instanceof Error ? e.message : e);
        return "";
    }
}

/** 一条事件的自然语言描述（提示词和工具返回共用）。 */
export function describeEvent(e: storage.SocialEventRow | null | undefined): string {
    if (!e) return "";
    const type = String(e.eventType || "");
    const base = type.split(":")[0];
    const group = e.groupId ? `群 ${e.groupId}` : "";
    switch (base) {
        case "group_increase":
            return `${e.actorId || "有人"} 加入了${group || "群"}`;
        case "group_decrease":
            return `${e.actorId || "有人"} 离开了${group || "群"}`;
        case "group_admin":
            return `${e.actorId || "有人"} 的管理员身份变了（${group}）`;
        case "group_recall":
            return `${e.actorId || "有人"} 撤回了一条消息${group ? `（${group}）` : ""}`;
        case "group_ban":
            return `${e.actorId || "有人"} 在${group}被禁言/解除禁言`;
        case "group_upload":
            return `${e.actorId || "有人"} 在${group}传了文件`;
        case "friend_add":
            return `${e.actorId || "有人"} 加你为好友`;
        case "notify":
            return e.detail || `${e.actorId || "有人"} 戳了你一下`;
        case "request":
            return e.detail || `${e.actorId || "有人"} 发来一个请求`;
        default:
            return e.detail || type;
    }
}

/** 事件时间措辞：刚发生的事说"刚刚"，别把时间戳直接怼出来。 */
export function friendlyEventTime(ts: string | number | null | undefined): string {
    const ms = parseDbTime(ts);
    if (!ms) return "";
    const diff = Date.now() - ms;
    if (diff < 0) return "";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    return new Date(ms).toISOString().slice(0, 10);
}

/** SQLite CURRENT_TIMESTAMP 是 UTC "YYYY-MM-DD HH:MM:SS"。 */
function parseDbTime(ts: string | number | null | undefined): number {
    if (ts == null) return 0;
    if (typeof ts === "number") return ts;
    const s = String(ts);
    const parsed = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** 拿一个群的完整画像（含成员），供能力返回。 */
export async function groupProfile(adapterId: string, groupId: string) {
    const group = await storage.getSocialGroup(adapterId, groupId);
    if (!group) return null;
    const members = await storage.listGroupMembers(adapterId, groupId, 500);
    return { ...group, members };
}

/** 查一个人：好友表 + 在哪些群 + 她记得的档案。 */
export async function personProfile(adapterId: string | null, userId: string) {
    const uid = String(userId || "");
    if (!uid) return null;
    const contacts = await storage.listSocialContacts(adapterId || null);
    const contact = contacts.find((c) => c.userId === uid) || null;
    const groups = adapterId ? await storage.groupsOfMember(adapterId, uid) : [];
    let person = null;
    try {
        person = await storage.getPerson(uid);
    } catch {
        /* people 表读失败不影响社交信息 */
    }
    return { userId: uid, contact, groups, person };
}
