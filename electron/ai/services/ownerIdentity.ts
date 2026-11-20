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

// ── 身份归一化（canonical identity）────────────────────────────────────
//
// 与核心版 src/services/ownerIdentity.js 的 canonicalIdentity / samePerson
// 逐字同语义。为什么要有这一层（用户 2026-11-20 原话）：
//
//   「既然三个入口是一个身份，那我不管哪个入口都可以应该看得到啊，
//     你这 bug 也太多了」
//   「还是打补丁，你要考虑一下还有没有其他是主人但是没被存为 _local 的
//     情况，也一并处理掉，我们要规范化编码了」
//
// 此前每次出问题，都是在**比较那一行**补一个 `|| x === "_local"`，
// 换个语句又活过来。根因是同一个人有四种写法，而没有一处负责把它们
// 认成同一个人：
//   1. people.role='owner' 的 person_key（QQ 号）  ← 规范值
//   2. '_local'          本机自用的旧别名
//   3. 本机会话 UUID      身份≠会话，但历史数据混用过
//   4. uid=1 / '__builtin__'  数据库内置账户
//
// 规矩：所有「存身份」之前过 canonicalIdentity；
//       所有「比身份」之前两侧过 samePerson。
// 不再允许任何模块自己写 `x === "_local" || x === ownerKey`。

/** 指代「本机主人」的历史别名集合（小写比较）。 */
const OWNER_ALIASES = new Set(["_local", "local", "uid=1", "uid:1", "1", "__builtin__"]);

/**
 * 判断一个会话键是不是「本机人机对话」。
 *
 * ⚠️ 必须**正向匹配**，绝不能写「不是 bot- 就当本机主人」——
 * 客人 QQ 号（如 1658359753）不以 bot- 开头，那样会被并进主人，
 * 等于抹掉客人隔离这条红线，比原来的 bug 严重得多。
 *
 * 只认两种形状明确的键：
 *   · UUID（本机入口生成的会话 id）
 *   · session_* / console-*（旧版桌面 WS / 控制台）
 */
function isOwnerLocalSession(sid: string): boolean {
    const s = String(sid || "").trim();
    if (!s) return false;

    // net:<device>:<原始 sessionId> —— 剥掉设备壳，用里面的键判
    if (s.startsWith("net:")) {
        const rest = s.slice("net:".length);
        const inner = rest.includes(":") ? rest.slice(rest.indexOf(":") + 1) : "";
        return isOwnerLocalSession(inner);
    }

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    if (/^(?:session|console)[_-][a-zA-Z0-9_-]{1,64}$/.test(s)) return true;

    // 其余（含纯数字 QQ 号、群号、workspace: 等）→ 不动
    return false;
}

/**
 * 把一个任意写法的主人类身份归一成规范身份键。
 *
 * @param value 任何来源的身份值（senderId / ownerKey / sessionId / uid）
 * @param asOwner 可选：以谁为「主人」做归一，默认取本机规范键。
 *        调用方**明确知道**主人是谁时才传（如推送闸门里外部传入的
 *        ownerOfSystem）。传了就以它为基准，不去读本机 people 表——
 *        否则两套基准打架又会认错人。
 * @returns 规范身份键；'' 表示认不出（不是主人，也不是可用身份）
 */
export function canonicalIdentity(value: string | null | undefined, asOwner?: string | null): string {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";

    const ownerKey = asOwner !== undefined && asOwner !== null && String(asOwner).trim()
        ? String(asOwner).trim()
        : getOwnerKey();

    // ① 已经是规范键
    if (raw === ownerKey) return ownerKey;
    // ② 历史别名（只在本机主人语义下成立）
    if (OWNER_ALIASES.has(raw.toLowerCase())) return ownerKey;
    // ③ 本机会话键：本机人机对话只属于本机主人
    if (isOwnerLocalSession(raw)) return ownerKey;
    // ④ 其余（客人 QQ 号等）保持原样，绝不猜——客人隔离是红线
    return raw;
}

/**
 * 两个人是不是同一个人（两侧都先归一）。
 *
 * 这是所有身份比较的唯一正确写法：
 *   if (samePerson(job.ownerKey, getOwnerKey())) { ... }
 */
export function samePerson(
    a: string | null | undefined,
    b: string | null | undefined,
    asOwner?: string | null,
): boolean {
    const ca = canonicalIdentity(a, asOwner);
    const cb = canonicalIdentity(b, asOwner);
    return !!ca && !!cb && ca === cb;
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
