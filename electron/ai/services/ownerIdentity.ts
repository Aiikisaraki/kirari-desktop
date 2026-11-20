// electron/ai/services/ownerIdentity.ts
// 「主人」的唯一身份真源 —— 与核心版 src/services/ownerIdentity.js 逐字对应。
//
// 2026-11-20 用户拍板：「这三个入口就是同一个身份、同一个对话框上下文」
//   —— 网页控制台 / 桌宠对话框 / 主人 QQ 私聊，身份键逐字相同，会话 id 也共用。
//
// 之前"主人"有四个键（QQ 号 / '_local' / 本机会话 UUID / uid=1），同一个人在
// 不同子系统里成了四个人：网页查不到 QQ 建的任务、桌面聊天框被当成 user、
// 记忆池按 UUID 分等，全是这一个根因的症状。现在只认一个键。
//
// 身份键 = 主人真实账号（people.role='owner' 的 person_key），跨机器稳定。
// 会话键 = local-session.json 的 UUID，本机这段对话的分区，三端共用。
// 两者本来就不该相等，不要再把会话 UUID 当身份用。
//
// 客人不在这里：客人身份永远是自己的 QQ 号，走 bot- 会话。
// 本模块只回答"主人这个身份是谁"，不判断"谁是不是主人"——后者由
// selfOps.roleOf 按当场 scene 决定，只认握手/场合，不认自称。

import { getOwnerKeySync } from "../db/storage";

/** 全新装机还没有主人记录时的临时键。 */
export const FALLBACK = "_local";

/** 主人的规范身份键（同步）。每次现取，设主人后立刻生效。 */
export function getOwnerKey(): string {
    try {
        const k = getOwnerKeySync();
        if (k && String(k).trim()) return String(k).trim();
    } catch {
        /* 存储未就绪 */
    }
    // people 表是唯一权威。早期适配器 ownerAccount 在首次对话时就会 touchPerson
    // 写进 people.role='owner'（见 adapter-manager.ts），所以这里查不到就是真的
    // 还没设过主人，直接用 FALLBACK，不要去猜配置文件。
    return FALLBACK;
}

/**
 * 本机主人入口统一 scene。字段必须与核心版 ownerScene 逐字一致。
 */
export function ownerScene(opts: { platform?: string; chatType?: string; senderName?: string } = {}): Record<string, unknown> {
    return {
        chatType: opts.chatType || "local",
        isGroup: false,
        isOwner: true,
        role: "owner",
        trustedLocal: true,
        // 规范身份键：三端一致，绝不是 '_local' 或会话 UUID
        senderId: getOwnerKey(),
        senderName: opts.senderName || "主人",
        platform: opts.platform || "desktop",
    };
}

/**
 * 从会话 id 在服务端派生场合身份（用于组网 relayed 消息）。
 * 与核心版 src/services/ownerIdentity.js 的 sceneFromSessionId 逐字对应。
 *
 * 信任模型：能 uplin 到主机的消息已通过配对码/长期凭据握手（未鉴权连接的
 * relay 帧被 hostServer 丢弃）= 主人授权的设备；叶子不单独配协议端，所以
 * 叶子上行就是主人在那台设备前打字。但仍只从可验证事实派生，绝不读帧里
 * 自报的 role/isOwner。
 *   · 本机会话（UUID / session_*）→ 主人 ownerScene
 *   · bot- 平台会话 → 从 sessionId 里的账号对比规范主人键：主人私聊=owner，其余=user
 */
export function sceneFromSessionId(sessionId: string, platform = "net"): Record<string, unknown> {
    const sid = String(sessionId || "").trim();
    const ownerKey = getOwnerKey();

    if (sid.startsWith("bot-")) {
        let counterpart = "";
        const userM = /(?:^|:)user:([^:]+)/.exec(sid);
        if (userM) counterpart = userM[1];
        else counterpart = sid.split(":").pop() || "";
        counterpart = String(counterpart || "").trim();
        const isOwnerPerson = !!counterpart && counterpart === ownerKey;
        const isGroup = /(?:^|[:-])(?:group|channel):/.test(sid);
        return {
            chatType: isGroup ? "group" : "private",
            isGroup,
            senderId: isOwnerPerson ? ownerKey : counterpart,
            senderName: "",
            isOwner: isOwnerPerson && !isGroup,
            role: isOwnerPerson && !isGroup ? "owner" : "user",
            trustedLocal: false,
            platform,
        };
    }

    return ownerScene({ platform, chatType: "local" });
}
