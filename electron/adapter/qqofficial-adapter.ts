import { BotAdapter } from "./bot-adapter";
import type { BotIncoming, BotOutgoing, QQOfficialConfig } from "./types";

// QQ 官方机器人「WebSocket 反向连接」适配器。
// - 鉴权：POST /app/getAppAccessToken 取 access_token（提前 60s 刷新），网关用 QQBot <token>。
// - 收：GET /gateway/bot 拿 wss 地址；Hello(op=10) 后发 Identify(op=2)，按 interval 心跳(op=1)；
//   Dispatch(op=0) 里处理 C2C/群@/频道/私信四类消息，转成统一 BotIncoming。
// - 发：走 OpenAPI（/v2/users|groups|channels/{id}/messages），msg_id 取触发消息的事件 id。
//   第一版只发文本：http(s) 图片 URL 追加到文本末尾，其他图片暂时不支持上传。

const TOKEN_URLS = [
  "https://api.bot.qq.com/app/getAppAccessToken",
  "https://bots.qq.com/app/getAppAccessToken", // 备用域名
];
const GATEWAY_URL = "https://api.bot.qq.com/gateway/bot";
const OPENAPI_BASE = "https://api.bot.qq.com/v2";
const TOKEN_REFRESH_AHEAD_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;
const DEDUP_LIMIT = 500;

// 网关/OpenAPI 返回「token 失效」时用特殊错误标记，让调用方强制刷新并重连。
class QQTokenExpiredError extends Error {}

// 发消息所需的上下文（无法放进 BotIncoming 的字段，用 WeakMap 随消息对象一起传递）。
type SendContext = {
  msgId: string;
  apiType: "user" | "group" | "channel";
  targetId: string;
};

export class QQOfficialAdapter extends BotAdapter {
  private ws: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private accessToken = "";
  private tokenExpiresAt = 0; // 毫秒时间戳
  private tokenFetchPromise: Promise<string> | null = null;

  private lastSeq: number | null = null; // 心跳里携带的最后收到的 s
  private seenMessages = new Map<string, true>(); // id+msg_seq 去重，最多保留 500 个（插入序即 FIFO）
  private sendContexts = new WeakMap<BotIncoming, SendContext>();

  connect(): void {
    if (this.disposed || this.ws) return;
    // 手动 connect 时取消尚未触发的重连，避免同时开两条连接
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.start();
  }

  // 异步建立连接：先取 token → 拿网关地址 → 创建 WebSocket
  private async start(): Promise<void> {
    this.setError("");
    this.lastSeq = null;
    let token: string;
    let gatewayUrl: string;
    try {
      token = await this.fetchAccessToken();
      const cfg = this.config.config as unknown as QQOfficialConfig;
      const override = (cfg.eventWsUrl || "").trim();
      gatewayUrl = override || (await this.fetchGatewayUrl(token));
      if (override) console.log(`[qqofficial] 使用配置里的事件 WS 地址`);
    } catch (e) {
      if (e instanceof QQTokenExpiredError) {
        this.forceTokenRefresh("网关返回 Token 失效");
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[qqofficial] 连接准备失败: ${msg}`);
      this.setError(msg);
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) return;

    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) {
      this.setError("WebSocket 不可用");
      return;
    }
    let ws: any;
    try {
      ws = new WebSocketCtor(gatewayUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "WebSocket 创建失败";
      console.warn(`[qqofficial] ${msg}`);
      this.setError(msg);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.setConnected(true);
      this.setError("");
      console.log(`[qqofficial] 事件 WS 已连接`);
    };
    // 把首次拿到的 token 传进 handler，Hello 时用当前 token（可能已被提前刷新）发 Identify
    ws.onmessage = (ev: { data: string }) => this.handleFrame(ev.data, token);
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.stopHeartbeat();
      this.setConnected(false);
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.setConnected(false);
      this.setError("事件 WS 错误");
    };
  }

  // 获取 access_token：未过期直接复用；并发调用合并为一次请求；失败切换备用域名。
  private async fetchAccessToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.accessToken && this.tokenExpiresAt - TOKEN_REFRESH_AHEAD_MS > now) {
      return this.accessToken;
    }
    if (this.tokenFetchPromise) return this.tokenFetchPromise;
    const pending = this.doFetchAccessToken();
    this.tokenFetchPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.tokenFetchPromise === pending) this.tokenFetchPromise = null;
    }
  }

  private async doFetchAccessToken(): Promise<string> {
    const cfg = this.config.config as unknown as QQOfficialConfig;
    const appId = (cfg.appId || "").trim();
    const clientSecret = (cfg.clientSecret || "").trim();
    if (!appId || !clientSecret) throw new Error("缺少 appId 或 clientSecret");

    let lastErr: unknown;
    for (const url of TOKEN_URLS) {
      try {
        const res = await globalThis.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appId, clientSecret }),
        });
        const body: any = await res.json().catch(() => ({}));
        // 业务错误在 body.code 里（HTTP 可能仍是 200）
        if (body?.code !== undefined && Number(body.code) !== 0) {
          throw new Error(
            `获取 AccessToken 失败 code=${body.code} message=${body.message || body.description || ""}`,
          );
        }
        const token = body?.access_token;
        if (typeof token !== "string" || !token) throw new Error("获取 AccessToken 失败: 响应没有 access_token");
        // expires_in 可能是字符串（如 "7200"）
        const expiresIn = Number(body?.expires_in);
        const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200;
        this.accessToken = token;
        this.tokenExpiresAt = Date.now() + lifetime * 1000;
        console.log(`[qqofficial] AccessToken 已获取，有效期 ${lifetime}s`);
        this.scheduleTokenRefresh(lifetime);
        return token;
      } catch (e) {
        lastErr = e;
        console.warn(
          `[qqofficial] AccessToken 请求失败(${url}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("获取 AccessToken 失败");
  }

  // 提前 60s 刷新 token（失败则 5s 后重试一次），刷新结果供后续 OpenAPI/Identify 使用
  private scheduleTokenRefresh(lifetimeSec: number): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    if (this.disposed || lifetimeSec <= 60) return;
    const delay = (lifetimeSec * 1000) - TOKEN_REFRESH_AHEAD_MS;
    this.tokenRefreshTimer = setTimeout(() => {
      this.tokenRefreshTimer = null;
      this.fetchAccessToken(true)
        .then(() => console.log("[qqofficial] AccessToken 已提前刷新"))
        .catch((e) => {
          console.warn(`[qqofficial] 定时刷新 AccessToken 失败: ${e instanceof Error ? e.message : String(e)}`);
          if (!this.disposed) {
            this.tokenRefreshTimer = setTimeout(() => {
              this.tokenRefreshTimer = null;
              this.fetchAccessToken(true).catch(() => {
                /* 下一次业务调用仍会按需重试 */
              });
            }, RECONNECT_DELAY_MS);
          }
        });
    }, delay);
  }

  // 网关地址：Authorization: QQBot <token>
  private async fetchGatewayUrl(token: string): Promise<string> {
    const res = await globalThis.fetch(GATEWAY_URL, {
      headers: { Authorization: `QQBot ${token}` },
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 401 || Number(body?.code) === 100016) {
      throw new QQTokenExpiredError("网关 Token 失效");
    }
    if (!res.ok || (body?.code !== undefined && Number(body.code) !== 0)) {
      throw new Error(
        `获取网关地址失败 status=${res.status} code=${body?.code ?? "-"} message=${body?.message || ""}`,
      );
    }
    const url = body?.url;
    if (typeof url !== "string" || !url.startsWith("wss")) throw new Error("网关地址无效");
    return url;
  }

  private handleFrame(raw: string, identifyToken: string): void {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const op = Number(frame.op);

    if (op === 10) {
      // Hello：启动心跳并发送 Identify
      const interval = Number(frame.d?.heartbeat_interval);
      if (Number.isFinite(interval) && interval > 0) this.startHeartbeat(interval);
      this.sendIdentify(this.accessToken || identifyToken);
      return;
    }
    if (op === 9) {
      // Invalid Session：强制刷新 token 重连
      this.forceTokenRefresh("会话无效(op=9)");
      return;
    }
    if (op === 11) return; // Heartbeat ACK
    if (op !== 0) return;

    // Dispatch：记录 s（心跳携带），按事件类型分发
    if (frame.s !== undefined && frame.s !== null) {
      const n = Number(frame.s);
      if (Number.isFinite(n)) this.lastSeq = n;
    }
    this.handleEvent(String(frame.t || ""), frame.d || {});
  }

  // 心跳 op=1，d=最后收到的 s（没有则 null）
  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      } catch {
        /* ignore */
      }
    }, intervalMs);
    console.log(`[qqofficial] 心跳已启动 interval=${intervalMs}ms`);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendIdentify(token: string): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    const intents = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 9);
    const payload = {
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
        properties: { $os: "windows", $browser: "akisaki-kirari", $device: "desktop" },
      },
    };
    this.ws.send(JSON.stringify(payload));
    console.log(`[qqofficial] 已发送 Identify intents=${intents}`);
  }

  // 消息事件按 id+msg_seq 去重（最近 500 个）
  private isDuplicate(d: any): boolean {
    const id = d?.id !== undefined && d?.id !== null ? String(d.id) : "";
    const seq = d?.msg_seq !== undefined && d?.msg_seq !== null ? String(d.msg_seq) : "";
    if (!id && !seq) return false;
    const key = `${id}:${seq}`;
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.set(key, true);
    if (this.seenMessages.size > DEDUP_LIMIT) {
      const oldest = this.seenMessages.keys().next().value;
      if (oldest !== undefined) this.seenMessages.delete(oldest);
    }
    return false;
  }

  private handleEvent(t: string, d: any): void {
    if (t === "READY") {
      console.log("[qqofficial] 会话已就绪 READY");
      return;
    }
    let senderId = "";
    let conversationKey = "";
    let replyGroupId: string | undefined;
    let isGroup = false;
    let apiType: SendContext["apiType"] = "user";
    let targetId = "";

    if (t === "C2C_MESSAGE_CREATE") {
      senderId = String(d.user_openid ?? "");
      conversationKey = `private:${senderId}`;
      apiType = "user";
      targetId = senderId;
    } else if (t === "GROUP_AT_MESSAGE_CREATE") {
      // 群消息 content 已由官方去掉 @ 前缀
      senderId = String(d.author?.member_openid ?? d.author?.id ?? "");
      replyGroupId = String(d.group_openid ?? "");
      conversationKey = `group:${replyGroupId}:${senderId}`;
      isGroup = true;
      apiType = "group";
      targetId = replyGroupId;
    } else if (t === "AT_MESSAGE_CREATE" || t === "PUBLIC_MESSAGE_CREATE") {
      senderId = String(d.author?.id ?? "");
      replyGroupId = String(d.channel_id ?? "");
      conversationKey = `channel:${replyGroupId}:${senderId}`;
      isGroup = true;
      apiType = "channel";
      targetId = replyGroupId;
    } else if (t === "DIRECT_MESSAGE_CREATE") {
      senderId = String(d.author?.id ?? "");
      const guildId = String(d.guild_id ?? "");
      replyGroupId = String(d.channel_id ?? "");
      conversationKey = `dm:${guildId}:${senderId}`;
      isGroup = true;
      apiType = "channel";
      targetId = replyGroupId;
    } else {
      return; // 其他事件忽略
    }
    if (!senderId || !targetId) return;

    if (this.isDuplicate(d)) {
      console.log(`[qqofficial] 重复消息已忽略 t=${t} id=${d.id ?? "-"} seq=${d.msg_seq ?? "-"}`);
      return;
    }

    const text = typeof d.content === "string" ? d.content.trim() : "";
    const images: string[] = [];
    if (Array.isArray(d.attachments)) {
      for (const att of d.attachments) {
        const url = typeof att?.url === "string" ? att.url : "";
        const contentType = typeof att?.content_type === "string" ? att.content_type : "";
        if (url && contentType.startsWith("image/")) images.push(url);
      }
    }
    // 空文本但有图片也放行；两者都空才忽略
    if (!text && images.length === 0) return;

    const incoming: BotIncoming = {
      adapterId: this.id,
      senderId,
      conversationKey,
      replyGroupId,
      text,
      images,
      isGroup,
    };
    // 记录回发上下文：被动消息必须带触发它的事件 id
    this.sendContexts.set(incoming, { msgId: String(d.id ?? ""), apiType, targetId });
    console.log(
      `[qqofficial] 收到消息事件 t=${t} sender=${senderId} text="${text}" images=${images.length}`,
    );
    this.emitMessage(incoming);
  }

  async sendMessage(target: BotIncoming, outgoing: BotOutgoing): Promise<void> {
    const ctx = this.sendContexts.get(target);
    if (!ctx) throw new Error("QQ 官方适配器缺少消息发送上下文");

    let token: string;
    try {
      token = await this.fetchAccessToken();
    } catch (e) {
      throw new Error(`获取 AccessToken 失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 第一版只发文本：http(s) 图片 URL 追加到文本末尾，其余图片暂不支持上传
    let content = outgoing.text || "";
    for (const img of outgoing.images || []) {
      const s = String(img).trim();
      if (/^https?:\/\//i.test(s)) {
        content += `\n${s}`;
      } else {
        console.warn("[qqofficial] 暂不支持图片上传，已跳过非 http(s) 图片");
      }
    }
    if (!content) {
      console.warn("[qqofficial] 回复内容为空，跳过发送");
      return;
    }

    const body: Record<string, unknown> = { msg_type: 0, content };
    if (ctx.msgId) body.msg_id = ctx.msgId;
    else console.warn("[qqofficial] 缺少事件 msg_id，被动消息可能被官方拒绝");

    const path =
      ctx.apiType === "user"
        ? `users/${encodeURIComponent(ctx.targetId)}/messages`
        : ctx.apiType === "group"
          ? `groups/${encodeURIComponent(ctx.targetId)}/messages`
          : `channels/${encodeURIComponent(ctx.targetId)}/messages`;

    const res = await globalThis.fetch(`${OPENAPI_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify(body),
    });
    const resp: any = await res.json().catch(() => ({}));
    if (res.status === 401 || Number(resp?.code) === 100016) {
      this.forceTokenRefresh("OpenAPI Token 失效");
      throw new Error(`发消息失败: Token 失效 status=${res.status} code=${resp?.code ?? "-"}`);
    }
    if (!res.ok || (resp?.code !== undefined && Number(resp.code) !== 0)) {
      throw new Error(
        `发消息失败 status=${res.status} code=${resp?.code ?? "-"} message=${resp?.message || ""}`,
      );
    }
    console.log(`[qqofficial] 消息已发送 → ${ctx.apiType}:${ctx.targetId}`);
  }

  // token 失效：清空 token 与定时器、关闭当前连接，5s 后重连（重连会重新取 token）
  private forceTokenRefresh(reason: string): void {
    console.warn(`[qqofficial] ${reason}，强制刷新 Token 后重连`);
    this.accessToken = "";
    this.tokenExpiresAt = 0;
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.closeWs();
    this.scheduleReconnect();
  }

  private closeWs(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.stopHeartbeat();
    this.setConnected(false);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    this.closeWs();
  }
}
