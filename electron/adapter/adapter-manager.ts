import { BotAdapter } from "./bot-adapter";
import { OneBotAdapter } from "./onebot-adapter";
import { BotBackendClient } from "./bot-backend-client";
import type { AdapterConfig, AdapterStatus, BotIncoming, PetBackendResponse } from "./types";
import type { LocalKnowledge } from "../../src/knowledge/localKnowledge";
import * as db from "../ai/db/storage";

// 主人在其他协议端（如 QQ）发起的对话，需要同步进桌宠聊天框。
// 由 main.ts 注入一个回调，内部转发到 ChatSessionService.injectExternalMessage。
export type OwnerSyncMessage = {
  author: "user" | "pet";
  text: string;
  images?: string[];
  emotion?: "happy" | "wave" | null;
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
    const configs = this.opts.getAdaptersConfig();
    for (const cfg of configs) {
      const inst = this.createInstance(cfg);
      if (!inst) continue;
      this.instances.set(cfg.id, inst);
      this.knownAccounts.set(cfg.id, new Set());
      inst.on("message", (msg: BotIncoming) => void this.handleIncoming(inst, msg));
      if (cfg.enabled) inst.connect();
    }
    this.backend.connect();
  }

  private createInstance(cfg: AdapterConfig): BotAdapter | null {
    if (cfg.type === "onebot") return new OneBotAdapter(cfg);
    // QQ 官方机器人第二阶段实现
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
      this.instances.set(id, inst);
      this.knownAccounts.set(id, new Set());
      inst.on("message", (msg: BotIncoming) => void this.handleIncoming(inst, msg));
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
    const isOwner = adapter.ownerAccount != null && msg.senderId === adapter.ownerAccount;
    const scope = isOwner ? null : `${adapter.id}::${msg.senderId}`;
    // 客人会话前缀必须是 bot-（不是 bot:）—— 两端 FOREIGN_SESSION_PREFIXES 都按
    // "bot-" 排除；用冒号会被 ensureLocalSessionId 当成本机会话并进主对话（群聊泄漏）。
    // 与核心版 botManager 的 bot-<适配器>-<对话键> 格式对齐。
    const sessionId = isOwner ? this.opts.getDesktopSessionId() : `bot-${adapter.id}-${msg.conversationKey}`;
    console.log(`[adapter] isOwner=${isOwner} scope=${scope} session=${sessionId}`);

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
      adapter
        .sendMessage(msg, { text: resp.speech, images: resp.images || [] })
        .catch((e) => console.error(`[adapter] 回发失败 ${adapter.name}:`, e));
      // 主人账号：把宠物回复同步进桌宠聊天框，实现跨端对话可见。
      if (isOwner && this.opts.pushOwnerMessage) {
        this.opts.pushOwnerMessage({
          author: "pet",
          text: resp.speech,
          images: resp.images || [],
          emotion: resp.emotion === "happy" || resp.emotion === "wave" ? resp.emotion : null,
        });
      }
    };
    this.backend.onResponse(sessionId, onResp);
    const ok = await this.backend.send({
      content: msg.text,
      images: msg.images,
      sessionId,
      locationScope: scope,
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
  }
}
