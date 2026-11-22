import { BotAdapter } from "./bot-adapter";
import { OneBotAdapter } from "./onebot-adapter";
import { QQOfficialAdapter } from "./qqofficial-adapter";
import { BotBackendClient } from "./bot-backend-client";
import type { AdapterConfig, AdapterStatus, BotIncoming, BotNotice, PetBackendResponse } from "./types";
import type { LocalKnowledge } from "../../src/knowledge/localKnowledge";
import * as db from "../ai/db/storage";
import * as memory from "../ai/services/memory";
import * as social from "../ai/services/social";
import { buildVoiceOutgoing } from "../extensions/voiceOutgoing";

// 当前存活的 AdapterManager 单例，供能力层（social 的 refresh 动作）拿到
// 正在运行的适配器实例去协议端重新拉数据。main.ts 每次重建都会覆盖。
let activeManager: AdapterManager | null = null;

/** 取一个正在运行的适配器实例；没有就返回 null（能力层据此给出人话提示）。 */
export function getAdapter(adapterId?: string): BotAdapter | null {
  return activeManager ? activeManager.getAdapter(adapterId) : null;
}

// 主人在其他协议端（如 QQ）发起的对话，需要同步进桌宠聊天框。
// 由 main.ts 注入一个回调，内部转发到 ChatSessionService.injectExternalMessage。
// emotion 为上游透传的原始字符串，真正的白名单校验在 ChatSessionService.acceptEmotion 里做，
// 这里不重复收窄（否则新增情绪标签要改两处，且容易漏）。
export type OwnerSyncMessage = {
  author: "user" | "pet";
  text: string;
  images?: string[];
  emotion?: string | null;
};

export interface AdapterManagerOpts {
  /** @deprecated 已废弃：内核跑在本进程内，不再需要后端地址。保留仅为兼容旧调用点。 */
  backendUrl?: string;
  /** @deprecated 已废弃：本机不设账户，不再需要令牌。 */
  token?: string;
  getDesktopSessionId: () => string;
  getAdaptersConfig: () => AdapterConfig[];
  saveAdaptersConfig: (adapters: AdapterConfig[]) => void;
  onStatusChange: () => void;
  // 把主人的跨端消息/回复同步到桌宠聊天框；可选（未注入则不同步）。
  pushOwnerMessage?: (msg: OwnerSyncMessage) => void;
  // 私人知识库：机器人发消息前本地检索，携带 kbContext 给后端
  localKnowledge?: LocalKnowledge;
}

// 管理多个协议适配器实例：持久化配置、按 (adapter, 发送者) 解析 locationScope，
// 把入站消息交给本进程的 AI 引擎，再按 session 把回复路由回对应适配器。
export class AdapterManager {
  private opts: AdapterManagerOpts;
  private backend: BotBackendClient;
  private instances = new Map<string, BotAdapter>();
  private knownAccounts = new Map<string, Set<string>>();
  private inited = false;

  constructor(opts: AdapterManagerOpts) {
    this.opts = opts;
    this.backend = new BotBackendClient(opts.backendUrl, opts.token, opts.localKnowledge);
  }

  init(): void {
    if (this.inited) return;
    this.inited = true;
    activeManager = this;
    const configs = this.opts.getAdaptersConfig();
    for (const cfg of configs) {
      const inst = this.createInstance(cfg);
      if (!inst) continue;
      this.attach(inst);
      if (cfg.enabled) inst.connect();
    }
    this.backend.connect();
  }

  /**
   * 统一挂载事件监听：消息、环境事件（notice）、连接就绪。
   * 社交环境同步（群列表/好友/群成员）必须在 ready 之后做——刚 open 时协议端
   * 可能还没准备好接受 action 调用。
   */
  private attach(inst: BotAdapter): void {
    this.instances.set(inst.id, inst);
    if (!this.knownAccounts.has(inst.id)) this.knownAccounts.set(inst.id, new Set());
    inst.on("message", (msg: BotIncoming) => void this.handleIncoming(inst, msg));
    inst.on("notice", (evt: BotNotice) => void this.handleNotice(inst, evt));
    inst.on("ready", () => void this.syncSocial(inst));
  }

  /** 拉一遍这个适配器的社交环境（群、好友、群成员），失败只记日志。 */
  private async syncSocial(inst: BotAdapter): Promise<void> {
    try {
      const cfg = this.opts.getAdaptersConfig().find((c) => c.id === inst.id);
      const r = await social.syncAdapter(inst as any, (cfg?.config || {}) as Record<string, unknown>);
      if (r.ok) {
        console.log(`[social] ${inst.id} 社交环境已同步：${r.groups} 群 / ${r.friends} 好友 / ${r.members} 群成员`);
      } else {
        console.log(`[social] ${inst.id} 跳过同步（${r.reason}）`);
      }
    } catch (e: any) {
      console.warn("[social] 同步失败（已忽略）:", e?.message || e);
    }
  }

  /**
   * 环境事件落库；成员变动（进群/退群）稍后刷新该群成员表。
   * 请求类事件（加好友/加群）只记录——同意与否是人的决定，不能自动放行。
   */
  private async handleNotice(inst: BotAdapter, evt: BotNotice): Promise<void> {
    try {
      await social.recordEvent({
        adapterId: evt.adapterId || inst.id,
        eventType: evt.eventType,
        groupId: evt.groupId || null,
        actorId: evt.actorId || null,
        targetId: evt.targetId || null,
        detail: evt.detail || null,
      });
      console.log(`[social] 事件 ${evt.eventType} ${evt.detail || ""}`);
    } catch (e: any) {
      console.warn("[social] 事件落库失败（已忽略）:", e?.message || e);
    }
    // 有人进出群 → 过 3 秒重拉成员表（等协议端状态稳定）
    if (evt.groupId && social.affectsMembership(evt.eventType)) {
      setTimeout(() => {
        void social
          .refreshGroup(inst as any, String(evt.groupId))
          .catch((e) => console.warn("[social] 刷新群成员失败（已忽略）:", e?.message || e));
      }, 3000);
    }
  }

  /** 取一个正在运行的适配器实例（能力层「刷新」用）。 */
  getAdapter(adapterId?: string): BotAdapter | null {
    if (adapterId) return this.instances.get(adapterId) || null;
    return this.instances.values().next().value || null;
  }

  private createInstance(cfg: AdapterConfig): BotAdapter | null {
    if (cfg.type === "onebot") return new OneBotAdapter(cfg);
    if (cfg.type === "qqofficial") return new QQOfficialAdapter(cfg);
    console.warn(`[adapter] 暂不支持的适配器类型: ${cfg.type}`);
    return null;
  }

  list(): AdapterStatus[] {
    return this.opts.getAdaptersConfig().map((cfg) => {
      const inst = this.instances.get(cfg.id);
      return {
        id: cfg.id,
        name: cfg.name,
        type: cfg.type,
        enabled: cfg.enabled,
        connected: inst ? inst.isConnected : false,
        lastError: inst ? inst.error : "",
        ownerAccount: cfg.ownerAccount,
        knownAccounts: [...(this.knownAccounts.get(cfg.id) || [])],
        config: cfg.config,
      };
    });
  }

  async add(cfg: Omit<AdapterConfig, "id"> & { id?: string }): Promise<AdapterStatus> {
    const id = cfg.id || `adp_${Date.now().toString(36)}`;
    const full: AdapterConfig = { ...(cfg as AdapterConfig), id };
    const configs = this.opts.getAdaptersConfig().slice();
    configs.push(full);
    this.opts.saveAdaptersConfig(configs);

    const inst = this.createInstance(full);
    if (inst) {
      this.attach(inst);
      if (full.enabled) inst.connect();
    }
    this.emitStatus();
    return this.list().find((a) => a.id === id)!;
  }

  async update(id: string, patch: Partial<AdapterConfig>): Promise<AdapterStatus> {
    const configs = this.opts.getAdaptersConfig().slice();
    const idx = configs.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error("适配器不存在");
    const full: AdapterConfig = { ...configs[idx], ...patch, config: { ...configs[idx].config, ...(patch.config || {}) } };
    configs[idx] = full;
    this.opts.saveAdaptersConfig(configs);

    const inst = this.instances.get(id);
    if (inst) {
      inst.updateConfig(full);
      // 连接相关字段变化 → 重连
      if (patch.enabled !== undefined || patch.config !== undefined || patch.type !== undefined) {
        inst.disconnect();
        if (full.enabled) inst.connect();
      }
    }
    this.emitStatus();
    return this.list().find((a) => a.id === id)!;
  }

  async remove(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (inst) {
      inst.dispose();
      this.instances.delete(id);
      this.knownAccounts.delete(id);
    }
    const configs = this.opts.getAdaptersConfig().filter((c) => c.id !== id);
    this.opts.saveAdaptersConfig(configs);
    this.emitStatus();
  }

  async connect(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (inst) inst.connect();
    // 同步 enabled 标志
    const configs = this.opts.getAdaptersConfig().slice();
    const c = configs.find((x) => x.id === id);
    if (c && !c.enabled) {
      c.enabled = true;
      this.opts.saveAdaptersConfig(configs);
    }
    this.emitStatus();
  }

  async disconnect(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (inst) inst.disconnect();
    const configs = this.opts.getAdaptersConfig().slice();
    const c = configs.find((x) => x.id === id);
    if (c && c.enabled) {
      c.enabled = false;
      this.opts.saveAdaptersConfig(configs);
    }
    this.emitStatus();
  }

  /**
   * 把某账号**设为主人之前**攒下的私聊记录并进桌宠主对话。
   *
   * 与核心版 botManager.mergeOwnerHistory 同语义 —— 两端必须一致，否则一边合一边不合规。
   *
   * 为什么必须有这一步：主人只能从 knownAccounts 里挑，而 knownAccounts 要「对方先发过
   * 消息」才有 —— 也就是说用户一定先以客人身份聊过一段，那段记录落在
   * `bot-<适配器>-private:<QQ>` 里。而 bot- 前缀被 FOREIGN_SESSION_PREFIXES 挡着，
   * 永远不会被收口并进主对话。只改路由的话，老记录就永远丢在客人会话里了。
   *
   * 只并**私聊**（1:1 对话，搬过去最自然）；群会话 `group:<群号>:<QQ>` 是多方上下文，不掺。
   *
   * @returns 实际搬过去多少条
   */
  private async mergeOwnerHistory(adapterId: string, accountKey: string): Promise<number> {
    const legacy = `bot-${adapterId}-private:${accountKey}`;
    try {
      const all = await db.listSessions();
      if (!all.includes(legacy)) return 0;
      const target = this.opts.getDesktopSessionId();
      if (!target || legacy === target) return 0;
      const moved = await db.mergeSessions([legacy], target);
      if (moved > 0) console.log(`[adapter] 已把主人 ${accountKey} 此前 ${moved} 条私聊记录并进主对话`);
      return moved;
    } catch (e) {
      console.warn("[adapter] 合并主人旧记录失败（不影响新消息）:", (e as Error)?.message || e);
      return 0;
    }
  }

  // 设置某账号为主人：之后该账号复用桌面 session + scope=null（共享登录 uid 的记忆）。
  // accountKey 为空表示取消主人。
  //
  // 顺带把该账号此前以客人身份攒下的私聊记录并进主对话（见 mergeOwnerHistory）。
  // 取消主人不反向拆回 —— 已经并进主对话的记录不会再拆出去。
  async setOwner(
    adapterId: string,
    accountKey: string,
  ): Promise<{ ownerAccount: string | null; moved: number }> {
    const configs = this.opts.getAdaptersConfig().slice();
    const c = configs.find((x) => x.id === adapterId);
    if (!c) throw new Error("适配器不存在");
    c.ownerAccount = accountKey || null;
    this.opts.saveAdaptersConfig(configs);
    const inst = this.instances.get(adapterId);
    if (inst) inst.setOwner(accountKey || null);
    this.emitStatus();
    const moved = c.ownerAccount ? await this.mergeOwnerHistory(adapterId, c.ownerAccount) : 0;
    return { ownerAccount: c.ownerAccount, moved };
  }

  private async handleIncoming(adapter: BotAdapter, msg: BotIncoming): Promise<void> {
    console.log(`[adapter] handleIncoming adapter=${adapter.name} sender=${msg.senderId} text="${msg.text}"`);
    const accts = this.knownAccounts.get(adapter.id) || new Set<string>();
    const isNew = !accts.has(msg.senderId);
    accts.add(msg.senderId);
    this.knownAccounts.set(adapter.id, accts);

    // owner → scope=null（共享登录 uid）；guest → 独立 scope
    // ⚠️ 必须同时要求「不是群聊」：群里的发言是多人上下文，即使发言人是主人，
    //    也不能并进桌宠主对话——否则群聊内容会混进私聊历史，反向也会把私聊内容带到群里
    //    （2026-11-19 用户报的隐私问题）。与核心版 botManager 的 isOwner 判定同语义。
    //
    // 注意区分两件事：
    //   sessionId/scope —— 这段对话记在哪儿（群聊必须独立，见上）。
    //   role            —— 这个人在管理权限上的级别（owner/admin/user），
    //                      由 people 档案决定，与"她记得谁"无关。
    // 每个说话的人都有自己的档案和记忆池，主人只是权限最高的那一位，不是唯一被记住的那位。
    const isOwnerAccount = adapter.ownerAccount != null && msg.senderId === adapter.ownerAccount && !msg.isGroup;
    let role = "user";
    try {
      const person = await memory.touchPerson({
        personKey: msg.senderId,
        displayName: msg.senderName || null,
        platform: adapter.id,
        // 配置里的 owner 账号首次出现时授予 owner；其余保持已有角色
        role: isOwnerAccount ? "owner" : undefined,
      });
      role = person?.role || (isOwnerAccount ? "owner" : "user");
    } catch (e: any) {
      console.warn("[adapter] 人物档案更新失败（已忽略）:", e?.message || e);
      role = isOwnerAccount ? "owner" : "user";
    }
    // 拥有者私聊才并入主对话；拥有者在群里不并（见上）。
    const isOwner = isOwnerAccount && role === "owner" ? true : isOwnerAccount;
    const scope = isOwner ? null : `${adapter.id}::${msg.senderId}`;
    // 客人会话前缀必须是 bot-（不是 bot:）—— 两端 FOREIGN_SESSION_PREFIXES 都按
    // "bot-" 排除；用冒号会被 ensureLocalSessionId 当成本机会话并进主对话（群聊泄漏）。
    // 与核心版 botManager 的 bot-<适配器>-<对话键> 格式对齐。
    const sessionId = isOwner ? this.opts.getDesktopSessionId() : `bot-${adapter.id}-${msg.conversationKey}`;
    console.log(`[adapter] role=${role} isOwner=${isOwner} scope=${scope} session=${sessionId}`);

    // 主人账号：先把用户在协议端的输入同步到桌宠聊天框（与桌面自身发消息表现一致）。
    if (isOwner && this.opts.pushOwnerMessage) {
      this.opts.pushOwnerMessage({
        author: "user",
        text: msg.text,
        images: msg.images,
      });
    }

    const onResp = (resp: PetBackendResponse) => {
      this.backend.offResponse(sessionId);
      // 语音条：只有装了语音扩展包且策略允许时 buildVoiceOutgoing 才返回音频；
      // 没装扩展包时它立刻返回 null，这里发出的内容与历史行为完全一致。
      // 注意它是 await 的：扩展包停摆最多拖慢 policy.timeoutMs，之后照样发文本。
      void (async () => {
        const audio = await buildVoiceOutgoing({
          text: resp.speech,
          isGroup: msg.isGroup,
          isOwner,
        }).catch(() => null);
        await adapter.sendMessage(msg, {
          text: resp.speech,
          images: resp.images || [],
          ...(audio ? { audio } : {}),
        });
      })().catch((e) => console.error(`[adapter] 回发失败 ${adapter.name}:`, e));
      // 主人账号：把宠物回复同步进桌宠聊天框，实现跨端对话可见。
      if (isOwner && this.opts.pushOwnerMessage) {
        this.opts.pushOwnerMessage({
          author: "pet",
          text: resp.speech,
          images: resp.images || [],
          emotion: typeof resp.emotion === "string" ? resp.emotion : null,
        });
      }
    };
    // 群名/人数：消息帧里通常没有，从 social 缓存里补。
    // 没有这一步，「当前场合」段就只剩「一个群里」，她不知道自己身处几十人的什么群，
    // 语气和分寸都无从判断（用户 2026-11-19 报的问题之一）。
    let groupName = msg.groupName || "";
    let memberCount = msg.memberCount;
    if (msg.isGroup && msg.replyGroupId) {
      try {
        const g = await db.getSocialGroup(adapter.id, msg.replyGroupId);
        if (g) {
          if (!groupName && g.groupName) groupName = g.groupName;
          if (typeof memberCount !== "number" && typeof g.memberCount === "number") memberCount = g.memberCount;
        }
      } catch (e: any) {
        console.warn("[adapter] 读取群信息失败（已忽略）:", e?.message || e);
      }
    }

    this.backend.onResponse(sessionId, onResp);
    const ok = await this.backend.send({
      content: msg.text,
      images: msg.images,
      sessionId,
      locationScope: scope,
      // 场合信息：让她知道在群聊/私聊、对谁说话，从而决定语气松紧与隐私边界。
      scene: {
        chatType: msg.isGroup ? "group" : "private",
        groupId: msg.replyGroupId || "",
        groupName,
        senderName: msg.senderName || "",
        senderRole: msg.senderRole || "",
        senderId: msg.senderId || "",
        isOwner,
        // 管理权限角色：只影响她能改什么设置，不影响她记得谁、怎么称呼谁
        role,
        memberCount,
        platform: adapter.id,
      },
    });
    console.log(`[adapter] backend.send → ${ok ? "已发送" : "失败(未连接)"}`);
    if (!ok) {
      this.backend.offResponse(sessionId);
      console.warn(`[adapter] 后端未连接，丢弃消息 ${adapter.name}`);
    }
    // 仅在「新账号出现」等状态变化时广播，避免每条消息都刷 UI
    if (isNew) this.emitStatus();
  }

  private emitStatus(): void {
    this.opts.onStatusChange();
  }

  dispose(): void {
    for (const inst of this.instances.values()) inst.disconnect();
    this.backend.disconnect();
    if (activeManager === this) activeManager = null;
  }
}
