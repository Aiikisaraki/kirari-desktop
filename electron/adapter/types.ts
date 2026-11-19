// 机器人适配器框架共享类型定义

export type BotAdapterType = "onebot" | "qqofficial";

// 群消息自动回复触发方式（在“被允许的群”范围内才生效，见 groupFilter）。
// - off：完全不回复群消息（默认，最安全）
// - mention：仅当消息 @ 了本机器人时才回复
// - all：回复群内所有消息（危险，需用户显式选择）
export type OneBotGroupReplyMode = "off" | "mention" | "all";

// 群范围过滤模式（决定「哪些群允许进入回复判断」）：
// - whitelist：仅 groupAllowlist 中的群可被回复（默认，最安全）
// - blacklist：除 groupBlocklist 中的群外，其余群均可被回复
export type OneBotGroupFilter = "whitelist" | "blacklist";

// 各协议的连接配置（仅保存连接所需信息，不存消息/记忆）
export interface OneBotConfig {
  wsUrl: string; // 正向 WS 地址，如 ws://127.0.0.1:3001
  token?: string; // 可选访问令牌（OneBot 走 ?access_token=）
  protocol?: string; // onebot11 / onebot12（预留）
  groupReplyMode?: OneBotGroupReplyMode; // 群消息回复触发方式，默认 off
  groupFilter?: OneBotGroupFilter; // 群范围过滤模式，默认 whitelist
  groupAllowlist?: string[]; // 白名单：仅这些群可被回复（groupFilter=whitelist 时使用）；为空则无群可回
  groupBlocklist?: string[]; // 黑名单：这些群永不回复（groupFilter=blacklist 时使用）
}
export interface QQOfficialConfig {
  appId: string;
  clientSecret: string;
  eventWsUrl?: string; // 事件 WS（预留，第二阶段）
}
export type AdapterConfigPayload = OneBotConfig | QQOfficialConfig;

export interface AdapterConfig {
  id: string;
  type: BotAdapterType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  ownerAccount: string | null; // 被设为主人的协议端账号ID（QQ号/频道用户ID）；null=未设
}

export interface AdapterStatus {
  id: string;
  name: string;
  type: BotAdapterType;
  enabled: boolean;
  connected: boolean;
  lastError: string;
  ownerAccount: string | null;
  knownAccounts: string[]; // 运行时见过的账号（用于 UI 展示/设主人）
  config?: Record<string, unknown>; // 透传连接配置（前端用于读取 groupReplyMode 等）
}

// 适配器 → 后端 的统一入站消息
export interface BotIncoming {
  adapterId: string;
  senderId: string; // 发送者协议端ID（QQ号）
  conversationKey: string; // 记忆/session 键（私聊=私聊ID；群=群号:用户ID）
  replyGroupId?: string; // 群号（私聊无）；回发时用
  text: string;
  images: string[]; // base64 data URL 或 http(s) URL
  isGroup: boolean;
  // ── 场合细节（2026-11-19 起采集）：原本这些字段在适配器里被整包丢弃，
  //    导致模型不知道在跟谁说话、也不知道群里还有别人，只能套固定卖萌句式，
  //    还可能把私聊内容说进群里。现在一路透传到 system prompt 的【当前场合】段。
  senderName?: string; // 群名片 / 昵称
  senderRole?: string; // owner / admin / member（OneBot 才有）
  groupName?: string; // 群名（部分 OneBot 实现会在 message 帧带 group_name）
  memberCount?: number; // 群人数（拿不到就留空）
}

// 后端 → 适配器 的统一出站消息
export interface BotOutgoing {
  text: string;
  images: string[];
}

/**
 * 环境事件（协议端的 notice / request 帧）。
 * 用户 2026-11-19：「谁加群了，谁戳一下了」——这些原来被整包丢弃，
 * 现在统一抛给适配器管理器，落进 social_events 表，她才真的知道身边发生了什么。
 */
export interface BotNotice {
  adapterId: string;
  /** 归一化后的事件类型，如 group_increase:approve / notify:poke / request:friend */
  eventType: string;
  groupId?: string | null;
  /** 触发者（进群的人 / 戳人的 / 申请的人） */
  actorId?: string | null;
  /** 被动方（被戳的是谁） */
  targetId?: string | null;
  /** 人话描述，直接可注入提示词 */
  detail?: string | null;
}

// 后端 pet_response 的精简结构（适配器只需文本+图片）
export interface PetBackendResponse {
  speech: string;
  emotion?: string | null;
  images?: string[];
  sessionId: string;
}
