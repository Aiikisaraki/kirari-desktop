import { EventEmitter } from "events";
import type { AdapterConfig, BotIncoming, BotNotice, BotOutgoing } from "./types";

// 所有协议适配器的抽象基类：管理连接状态，向上抛出统一的 BotIncoming 消息。
// 具体协议（OneBot / QQ 官方）实现 connect/disconnect/sendMessage 与消息编解码。
export abstract class BotAdapter extends EventEmitter {
  protected config: AdapterConfig;
  protected connected = false;
  protected lastError = "";
  protected disposed = false; // 仅由 dispose() 设置，永久停止重连

  constructor(config: AdapterConfig) {
    super();
    this.config = config;
  }

  get id(): string {
    return this.config.id;
  }
  get name(): string {
    return this.config.name;
  }
  get type(): AdapterConfig["type"] {
    return this.config.type;
  }
  get isConnected(): boolean {
    return this.connected;
  }
  get error(): string {
    return this.lastError;
  }
  get ownerAccount(): string | null {
    return this.config.ownerAccount;
  }

  abstract connect(): void;
  abstract disconnect(): void;
  abstract sendMessage(target: BotIncoming, outgoing: BotOutgoing): Promise<void>;

  // 永久释放实例：标记为 disposed 后再断开连接，防止 reconnect 继续触发。
  // disconnect() 本身只关闭当前连接，不设置 disposed，以便用户/配置变更后能重新连接。
  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  // 用最新配置更新（如改了 wsUrl/token 后重连）
  updateConfig(patch: Partial<AdapterConfig>): void {
    const next: AdapterConfig = {
      ...this.config,
      ...patch,
      config: { ...this.config.config, ...(patch.config || {}) },
    };
    this.config = next;
  }

  setOwner(accountKey: string | null): void {
    this.config.ownerAccount = accountKey;
  }

  protected emitMessage(msg: BotIncoming): void {
    this.emit("message", msg);
  }

  /**
   * 抛出环境事件（进群/退群/戳一戳/加好友请求…）。
   * 这些帧原来被 `post_type !== "message"` 整包丢弃，导致她对身边发生的事完全无感
   * （用户 2026-11-19：「谁加群了，谁戳一下了」）。
   */
  protected emitNotice(evt: BotNotice): void {
    this.emit("notice", evt);
  }

  protected setConnected(v: boolean): void {
    this.connected = v;
  }
  protected setError(e: string): void {
    this.lastError = e;
  }
}
