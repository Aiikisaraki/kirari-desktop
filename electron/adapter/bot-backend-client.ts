import type { PetBackendResponse } from "./types";
import type { LocalKnowledge } from "../../src/knowledge/localKnowledge";

type ResponseListener = (resp: PetBackendResponse) => void;

// 机器人适配器专用的后端 WS 客户端：与桌面 ChatSessionService 并列，但支持「多会话」，
// 按 session_id 把 pet_response 分发给对应适配器。认证使用登录 uid 的令牌（与桌面一致），
// 记忆隔离由入站时携带的 locationScope 决定（后端忽略客户端 userid，身份来自令牌）。
export class BotBackendClient {
  private readonly backendUrl: string;
  private readonly token: string;
  private readonly localKnowledge: LocalKnowledge | undefined;
  private socket: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private listeners = new Map<string, ResponseListener>();
  private statusCbs: ((connected: boolean) => void)[] = [];

  constructor(backendUrl: string, token: string, localKnowledge?: LocalKnowledge) {
    this.backendUrl = backendUrl;
    this.token = token;
    this.localKnowledge = localKnowledge;
  }

  onStatus(cb: (connected: boolean) => void): void {
    this.statusCbs.push(cb);
  }

  connect(): void {
    if (this.disposed) return;
    // 已在连接中(0)或已打开(1)则跳过，避免重复连接；已关闭/为空才重连
    if (this.socket && this.socket.readyState !== 2 && this.socket.readyState !== 3) return;
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) {
      console.error("[bot-backend] WebSocket 不可用");
      return;
    }
    let url = this.backendUrl;
    if (this.token) {
      try {
        const u = new URL(this.backendUrl);
        if (!u.searchParams.has("token")) {
          u.searchParams.set("token", this.token);
          url = u.toString();
        }
      } catch {
        /* ignore */
      }
    }
    const socket = new WebSocketCtor(url);
    this.socket = socket;
    socket.onopen = () => {
      console.log("[bot-backend] 后端 WS 已连接");
      this.statusCbs.forEach((cb) => cb(true));
    };
    socket.onmessage = (ev: { data: string }) => {
      this.handleMessage(ev.data);
    };
    socket.onclose = () => {
      console.log("[bot-backend] 后端 WS 已断开");
      if (this.socket === socket) this.socket = null; // 关键：断开后清空，否则重连被 guard 挡死
      this.statusCbs.forEach((cb) => cb(false));
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      console.error("[bot-backend] 后端 WS 错误（可能未授权/地址错误）");
      if (this.socket === socket) this.socket = null;
      this.statusCbs.forEach((cb) => cb(false));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  private handleMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw);
      if (payload && payload.type === "pet_response" && typeof payload.speech === "string") {
        const sessionId: string = payload.session_id || "";
        // 后端每条连接建立后 1.5s 会推一条无 session_id 的「问候」，不是用户消息，直接忽略。
        if (!sessionId) {
          console.log(`[bot-backend] 收到问候/广播(无 session_id)，已忽略: "${String(payload.speech).slice(0, 24)}"`);
          return;
        }
        const cb = this.listeners.get(sessionId);
        console.log(`[bot-backend] pet_response session=${sessionId} 命中回调=${!!cb}`);
        if (cb) {
          cb({
            speech: payload.speech,
            emotion: payload.emotion,
            images: Array.isArray(payload.images) ? payload.images : [],
            sessionId,
          });
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // 注册某 session 的响应回调（发送前调用，收到后自动注销）
  onResponse(sessionId: string, cb: ResponseListener): void {
    this.listeners.set(sessionId, cb);
  }
  offResponse(sessionId: string): void {
    this.listeners.delete(sessionId);
  }

  async send(payload: {
    content: string;
    images: string[];
    sessionId: string;
    locationScope: string | null;
  }): Promise<boolean> {
    if (!this.socket || this.socket.readyState !== 1) return false;
    // 私人知识库检索：发消息前本地 + 远程检索（异步），携带结果给后端
    const kbContext = this.localKnowledge ? await this.localKnowledge.search(payload.content) : undefined;
    const msg = JSON.stringify({
      content: payload.content,
      images: payload.images,
      session_id: payload.sessionId,
      locationScope: payload.locationScope,
      kbContext,
    });
    try {
      this.socket.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}
