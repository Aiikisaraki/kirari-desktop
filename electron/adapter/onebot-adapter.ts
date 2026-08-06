import * as fs from "fs";
import { BotAdapter } from "./bot-adapter";
import type { BotIncoming, BotOutgoing, OneBotConfig, OneBotGroupReplyMode, OneBotGroupFilter } from "./types";

// OneBot 正向 WS 适配器（NapCat / LLOneBot）。
// - 收：监听 post_type=message，把 CQ 码消息解析为统一 BotIncoming（文本 + base64/url 图片）。
// - 发：通过 action 帧 send_msg 回发；图片走 base64:// 直传（无需落盘）。
export class OneBotAdapter extends BotAdapter {
  private ws: any = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private echoSeq = 0;
  private selfQQ = ""; // 机器人自身 QQ（get_login_info 获取），用于群 @ 判断
  private loginEcho = "";
  // get_image 异步回调：echo → { resolve, timer }，用于把 OneBot 缓存文件名解析为真实图片字节。
  private pendingImages = new Map<string, { resolve: (v: string | null) => void; timer: ReturnType<typeof setTimeout> }>();

  connect(): void {
    if (this.disposed || this.ws) return;
    const cfg = this.config.config as unknown as OneBotConfig;
    const wsUrl = (cfg.wsUrl || "").trim();
    if (!wsUrl) {
      this.setError("缺少 wsUrl");
      return;
    }
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) {
      this.setError("WebSocket 不可用");
      return;
    }
    let url = wsUrl;
    if (cfg.token) {
      try {
        const u = new URL(wsUrl);
        if (!u.searchParams.has("access_token")) {
          u.searchParams.set("access_token", cfg.token);
          url = u.toString();
        }
      } catch {
        /* ignore */
      }
    }
    this.setError("");
    let ws: any;
    try {
      ws = new WebSocketCtor(url);
    } catch (e) {
      this.setError(e instanceof Error ? e.message : "连接失败");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.setConnected(true);
      this.setError("");
      console.log(`[onebot] 已连接 ${this.name}`);
      this.fetchLoginInfo();
    };
    ws.onmessage = (ev: { data: string }) => this.handleFrame(ev.data);
    ws.onclose = () => {
      this.setConnected(false);
      this.ws = null;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.setConnected(false);
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 清理未完成的 get_image 等待，避免泄漏/悬挂回调
    for (const pend of this.pendingImages.values()) clearTimeout(pend.timer);
    this.pendingImages.clear();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setConnected(false);
  }

  private async handleFrame(raw: string): Promise<void> {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    // action 回包（带 echo）：可能是 get_login_info，也可能是 get_image
    if (frame && frame.echo) {
      // get_image 回包：把缓存文件名解析为真实图片字节（base64 / url / 本地路径）
      if (this.pendingImages.has(frame.echo)) {
        const pend = this.pendingImages.get(frame.echo)!;
        clearTimeout(pend.timer);
        this.pendingImages.delete(frame.echo);
        const d = frame.data || {};
        let res: string | null = null;
        // 优先取内联 base64（go-cqhttp 返回纯 base64 或 base64:// 前缀）
        if (typeof d.base64 === "string") {
          res = d.base64.startsWith("base64://") ? d.base64.slice("base64://".length) : d.base64;
        } else if (typeof d.file === "string" && d.file.startsWith("base64://")) {
          res = d.file.slice("base64://".length);
        } else if (typeof d.url === "string" && /^https?:\/\//i.test(d.url)) {
          res = d.url;
        } else if (
          typeof d.file === "string" &&
          (d.file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d.file) || d.file.startsWith("file://"))
        ) {
          try {
            const b = fs.readFileSync(d.file.replace(/^file:\/\//, ""));
            res = b.toString("base64");
          } catch {
            /* 读不到就放弃 */
          }
        }
        pend.resolve(res);
        return;
      }
      if (frame.echo === this.loginEcho && frame.data && frame.data.user_id) {
        this.selfQQ = String(frame.data.user_id);
        console.log(`[onebot] 登录账号 QQ=${this.selfQQ}`);
      }
      return;
    }
    // 只处理事件推送（post_type 存在）
    if (!frame || frame.post_type !== "message") return;
    const msgType: string = frame.message_type || "private";
    const userId: string = String(frame.user_id ?? "");
    if (!userId) return;

    // 优先用事件自带的 self_id 作为机器人自身 QQ（比 get_login_info 更可靠，且能立刻用于 @ 判断）
    if (frame.self_id) this.selfQQ = String(frame.self_id);

    const groupId: string | undefined =
      msgType === "group" ? String(frame.group_id ?? "") : undefined;

    // 群消息过滤：先判断「回复触发方式」，再判断「群范围（白/黑名单）」。
    // 两层都通过才发后端，默认 off + 白名单，绝不无差别骚扰群聊。
    if (msgType === "group") {
      const cfg = this.config.config as unknown as OneBotConfig;
      const mode: OneBotGroupReplyMode = cfg.groupReplyMode || "off";
      if (mode === "off") {
        console.log(`[onebot] 群消息已忽略(groupReplyMode=off) group=${groupId}`);
        return;
      }
      if (mode === "mention" && !this.messageMentionsSelf(frame.message)) {
        console.log(`[onebot] 群消息已忽略(群内未@机器人) group=${groupId}`);
        return;
      }
      // 群范围过滤（白名单 / 黑名单），mention 与 all 都受此约束
      const filter: OneBotGroupFilter = cfg.groupFilter || "whitelist";
      if (filter === "whitelist") {
        const allow = (cfg.groupAllowlist || []).map(String).filter(Boolean);
        if (!groupId || !allow.includes(groupId)) {
          console.warn(
            `[onebot] 群消息已忽略(白名单模式，群号不在允许列表) group=${groupId} 白名单=${(allow.join(",") || "空")}`,
          );
          return;
        }
      } else {
        // blacklist：列出者永不回复，其余放行
        const block = (cfg.groupBlocklist || []).map(String).filter(Boolean);
        if (groupId && block.includes(groupId)) {
          console.warn(
            `[onebot] 群消息已忽略(黑名单模式，该群已被排除) group=${groupId}`,
          );
          return;
        }
      }
    }

    console.log(`[onebot] 收到消息事件 type=${msgType} user=${userId} group=${frame.group_id ?? '-'}`);
    let { text, images: rawImages } = this.parseMessage(frame.message);
    // 把图片候选归一化为可用串（内联 base64 / http URL / 经 get_image 取回字节）；
    // 解析失败的（裸文件名拉不到字节等）直接丢弃，避免把坏串送进模型导致 500 卡死。
    const images = (
      await Promise.all(rawImages.map((r) => this.resolveImage(r)))
    ).filter((x): x is string => typeof x === "string" && x.length > 0);
    // mention 模式下，去掉文本里对自己的 @，以及 @全体成员（避免把 @at 当成内容）
    if (msgType === "group" && this.selfQQ) {
      text = text.replace(new RegExp(`@${this.selfQQ}\\s*`, "g"), "").trim();
    }
    text = text.replace(/@all\s*/g, "").trim();
    // 纯精准 @（去掉 @self/@all 后无文本、无图片）视为「被叫到」：补一句默认招呼，让机器人给出自然回应，
    // 而不是全程沉默。@全体成员（未精准 @机器人）不会进入此分支，故不会触发回复。
    if (msgType === "group" && !text && images.length === 0 && this.messageMentionsSelf(frame.message)) {
      text = "在吗？";
    }
    if (!text && images.length === 0) return;
    const conversationKey =
      msgType === "group" && groupId ? `group:${groupId}:${userId}` : `private:${userId}`;
    const incoming: BotIncoming = {
      adapterId: this.id,
      senderId: userId,
      conversationKey,
      replyGroupId: groupId,
      text,
      images,
      isGroup: msgType === "group",
    };
    console.log(`[onebot] 解析完成 text="${text}" images=${images.length} → emitMessage`);
    this.emitMessage(incoming);
  }

  // 连接后获取机器人自身 QQ（用于群 @ 判断）
  private fetchLoginInfo(): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.loginEcho = `kirari-login-${++this.echoSeq}`;
    try {
      this.ws.send(JSON.stringify({ action: "get_login_info", params: {}, echo: this.loginEcho }));
    } catch {
      /* ignore */
    }
  }

  // 从消息里提取所有被 @ 的 QQ（同时支持 CQ 字符串与数组段格式；"all" 表示 @全体成员）
  private extractMentionQQs(message: unknown): Set<string> {
    const qqs = new Set<string>();
    const visit = (seg: any) => {
      if (!seg) return;
      if (typeof seg === "string") {
        const re = /\[CQ:at,[^\]]*?qq=([0-9]+|all)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(seg)) !== null) qqs.add(m[1]);
      } else if (typeof seg === "object") {
        if (seg.type === "at") {
          qqs.add(String(seg.data?.qq ?? ""));
        } else if (Array.isArray(seg.message)) {
          seg.message.forEach(visit);
        }
      }
    };
    if (typeof message === "string") visit(message);
    else if (Array.isArray(message)) message.forEach(visit);
    else if (message && typeof message === "object") visit(message);
    return qqs;
  }

  // 判断原始消息是否精准 @ 了本机器人（qq=all 即 @全体成员 不计入，绝不回复 @all）
  private messageMentionsSelf(message: unknown): boolean {
    if (!this.selfQQ) return false; // 还不知道自身 QQ → 保守忽略，避免误回
    return this.extractMentionQQs(message).has(this.selfQQ);
  }

  // 解析 OneBot v11 文本/CQ 码混合消息。返回纯文本与图片（base64→data URL；url=→原样）。
  private parseMessage(message: unknown): { text: string; images: string[] } {
    if (typeof message === "string") {
      const images: string[] = [];
      let text = "";
      const parts = message.split("[CQ:");
      for (let i = 0; i < parts.length; i++) {
        if (i === 0) {
          text += parts[i];
          continue;
        }
        const end = parts[i].indexOf("]");
        const body = end >= 0 ? parts[i].slice(0, end) : parts[i];
        const segType = body.split(",")[0];
        if (segType === "image") {
          const file = this.cqParam(body, "file");
          const url = this.cqParam(body, "url");
          // 仅记录候选（file 优先，退而求其次 url），真正的归一化在 resolveImage 完成。
          const candidate = file || url;
          if (candidate) images.push(candidate);
        } else if (segType === "at") {
          const qq = this.cqParam(body, "qq");
          text += `@${qq || "?"} `;
        } else if (segType === "text") {
          text += this.cqParam(body, "text") || "";
        }
        if (end >= 0) text += parts[i].slice(end + 1);
      }
      return { text: text.trim(), images };
    }
    if (Array.isArray(message)) {
      let text = "";
      const images: string[] = [];
      for (const seg of message) {
        if (seg?.type === "text") text += seg.data?.text || "";
        else if (seg?.type === "at") {
          const qq: string = String(seg.data?.qq ?? "");
          text += `@${qq === "all" ? "all" : qq || "?"} `;
        }         else if (seg?.type === "image") {
          // 仅记录候选（file 优先，退而求其次 url），真正的归一化在 resolveImage 完成。
          const file: string = seg.data?.file || "";
          const url: string = seg.data?.url || "";
          const candidate = file || url;
          if (candidate) images.push(candidate);
        }
      }
      return { text: text.trim(), images };
    }
    return { text: "", images: [] };
  }

  private cqParam(body: string, key: string): string {
    const m = body.match(new RegExp(`${key}=([^,\\]]+)`));
    return m ? m[1].trim() : "";
  }

  // 把 OneBot 给出的图片候选归一化为可直接喂给模型的图片串：
  // - base64:// / base64: / data:image/... → 统一为标准 data:image/jpeg;base64,...（修正缺失的 MIME 子类型）
  // - http(s) URL → 原样（模型自行拉取）
  // - 裸 file_id / 缓存文件名（如 FF3C422A....jpg）→ 走 OneBot get_image 取回真实字节内联为 base64，
  //   保证云模型也能用；拉取失败/超时返回 null（调用方丢弃该图，不阻塞消息）。
  private async resolveImage(raw: string): Promise<string | null> {
    if (!raw) return null;
    const s = raw.trim();
    // 1. 内联 base64 变体（部分客户端用单冒号 / 缺失 MIME 子类型）
    if (s.startsWith("base64://")) return `data:image/jpeg;base64,${s.slice("base64://".length)}`;
    if (s.startsWith("base64:")) {
      const rest = s.slice("base64:".length);
      // 防止 base64:data:image/... 双前缀：若 rest 本身就是 data URL 则直接返回
      return rest.startsWith("data:image/") ? rest : `data:image/jpeg;base64,${rest}`;
    }
    // 2. 已是 data:image/... 形式：校验载荷真的是 base64，而非被塞进了真实 URL
    if (s.startsWith("data:image/")) {
      const comma = s.indexOf(",");
      if (comma === -1) return null;
      const payload = s.slice(comma + 1).trim();
      // 部分客户端把真实 http 链接塞进 base64 载荷（形如 data:image/jpeg;base64,https://...），
      // 应把真实链接提取出来当 http 图片用，而不是当成 base64 喂给模型导致 500
      if (/^https?:\/\//i.test(payload)) return payload;
      return s;
    }
    // 3. 真实 http(s) 链接
    if (/^https?:\/\//i.test(s)) return s;
    // 4. 裸 file_id / 缓存文件名：走 OneBot get_image 拉回字节
    if (this.ws && this.ws.readyState === 1) {
      try {
        const b64 = await this.getImage(s);
        if (!b64) return null;
        // get_image 可能返回 base64（不带前缀）或真实 http URL
        if (/^https?:\/\//i.test(b64)) return b64;
        return `data:image/jpeg;base64,${b64}`;
      } catch (e) {
        console.warn("[onebot] get_image 失败，跳过该图片:", e instanceof Error ? e.message : String(e));
        return null;
      }
    }
    return null;
  }

  // 通过 OneBot get_image action 拉取图片字节，返回 base64（不带前缀）；超时/失败返回 null。
  private getImage(file: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) return resolve(null);
      const echo = `kirari-getimg-${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pendingImages.delete(echo);
        resolve(null);
      }, 8000);
      this.pendingImages.set(echo, { resolve, timer });
      try {
        this.ws.send(JSON.stringify({ action: "get_image", params: { file }, echo }));
      } catch {
        clearTimeout(timer);
        this.pendingImages.delete(echo);
        resolve(null);
      }
    });
  }

  async sendMessage(target: BotIncoming, outgoing: BotOutgoing): Promise<void> {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("OneBot 未连接");
    }
    const segs: any[] = [];
    if (outgoing.text) segs.push({ type: "text", data: { text: outgoing.text } });
    for (const img of outgoing.images || []) {
      const m = /^data:image\/[a-zA-Z+]+;base64,(.+)$/.exec(img);
      const file = m ? `base64://${m[1]}` : img;
      segs.push({ type: "image", data: { file } });
    }
    const params: Record<string, unknown> = { message: segs };
    if (target.isGroup && target.replyGroupId) params.group_id = target.replyGroupId;
    else params.user_id = target.senderId;
    const action = {
      action: "send_msg",
      params,
      echo: `kirari-${++this.echoSeq}`,
    };
    this.ws.send(JSON.stringify(action));
  }
}
