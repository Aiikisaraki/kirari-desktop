import fs from "fs/promises";
import path from "path";
import { nativeImage } from "electron";
import * as frontendTools from "./frontend-tools";
import * as engine from "./ai/engine";
import * as db from "./ai/db/storage";
import type { AiModelSettings } from "./ai/aiContext";
import { readModelConfigFile } from "./model-config";
import type { LocalKnowledge, RetrievedPassage } from "../src/knowledge/localKnowledge";

export type ChatAuthor = "user" | "pet" | "system";

// 对话回答可携带的情绪标签：用于前端"情绪优先"播放（先播情绪动画再播说话）。
// 由模型在回复解析后给出；本模块只消费，不负责生成。
export type PetEmotion = "happy" | "wave";

export type ChatMessage = {
    id: string;
    author: ChatAuthor;
    text: string;
    timestamp: number;
    // 可选情绪标签（仅 pet 消息可能携带）。无则省略，前端退化为直接说话。
    emotion?: PetEmotion | null;
    // 关联图片（用户发送的图片、或 AI 返回的图片），URL 或 base64 data URL。
    images?: string[];
};

export type ChatStateSnapshot = {
    sessionId: string;
    /** 大脑是否就绪：配置齐全即 true。不再是"网络连接"语义。 */
    connected: boolean;
    lastError: string;
    waitingForReply: boolean;
    messages: ChatMessage[];
    bubbleMessage: string;
    bubbleInteractive: boolean;
};

/**
 * 旧版聊天记录的磁盘格式（chat-session.json）。
 *
 * 2026-10-12 起聊天记录统一改用数据库（用户拍板），这个类型只用于**一次性迁移**：
 * 启动时发现文件存在就把内容导进 messages 表，然后改名备份，之后不再读写。
 * 保留定义是为了让迁移代码有明确的形状可校验。
 */
type LegacyPersistedChatState = {
    sessionId: string;
    messages: ChatMessage[];
    bubbleMessage: string;
    bubbleInteractive: boolean;
};

type ChatSessionOptions = {
    userid: number;
    emitState: (state: ChatStateSnapshot) => void;
    /**
     * 本机会话 id（userData/local-session.json 里那一份，见 ai/local-session.ts）。
     * 传入后桌宠就固定用这个会话 —— 重启不换、与核心版控制台共用同一段对话。
     * 不传（旧调用方 / 测试）则退化为进程内随机 id，行为同历史版本。
     */
    sessionId?: string;
    // 私人知识库：发消息前本地检索，结果直接进入内核的私有知识库通道
    localKnowledge?: LocalKnowledge;
    // 模型配置读取器。缺省直接读 userData/config.json。
    readSettings?: () => AiModelSettings | null;
    /**
     * 组网出口：本机作为叶子时，把请求上行给主机。
     * 返回 true 表示已成功上行（本地不再调模型，等广播回复）。
     * 第三参 kbContext 是本机私人知识库的检索结果 —— 主机没有我们的本地
     * 知识库，不带就等于白配了（回答准确度全靠它）。
     * 未提供 / 返回 false → 走本地独立调用。
     */
    relaySender?: (content: string, images: string[], kbContext: RetrievedPassage[]) => boolean;
};

/** 主机广播回来的回复（结构见 net/protocol.ts） */
export type RelayResultFrame = {
    requestId: string;
    speech: string;
    emotion?: string | null;
    fromDeviceId: string;
    fromName?: string;
    sessionId: string;
    seq: number;
};

const WELCOME_MESSAGE = "今天也一起加油吧。";
const LONG_REPLY_PROMPT = "回复较长，点我看详情";

// 单条消息的回复超时（毫秒）：模型推理卡死或网络中断时，不能让前端永远停在"思考中"
// 且禁用发送按钮。到点后兜底清除等待态并给出可见提示，用户可重试。
const REPLY_TIMEOUT_MS = 60000;

// 发送前图片压缩阈值：在客户端就从源头把图压小，
// 避免超大图直接喂给视觉模型导致推理失败或白白吃带宽 / token。
const MAX_IMAGE_LONG_EDGE = 1280; // 最长边像素上限（多数视觉模型甜区 512–1024，留点余量）
const IMAGE_JPEG_QUALITY = 0.8; // 转 JPEG 质量，单图通常压到 < 300KB

// 未配置大脑时的提示。按项目规范：不裸露"API Key / Token / 模型 / 提示词"等术语。
const NOT_CONFIGURED_HINT = "小灵的大脑还没连接上，去设置里填上就能聊天啦";

// 对 base64 data URL 图片做等比缩放 + JPEG 压缩；远程 http(s) URL 由模型自行拉取，原样透传。
// 任何异常（解码失败、resize 为空）一律回退原图，绝不阻断发送。
function downscaleImageDataUrl(dataUrl: string): string {
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
        return dataUrl;
    }
    try {
        const img = nativeImage.createFromDataURL(dataUrl);
        if (img.isEmpty()) return dataUrl;
        const size = img.getSize();
        const longEdge = Math.max(size.width, size.height);
        if (longEdge <= MAX_IMAGE_LONG_EDGE) {
            return dataUrl;
        }
        const scale = MAX_IMAGE_LONG_EDGE / longEdge;
        const resized = img.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
        });
        // ⚠️ 别用 toDataURL("image/jpeg", quality)：Electron 的 toDataURL 只认
        //    { scaleFactor }，多传的参数被忽略，实际吐出来的是 PNG（无损、大）。
        //    要真的压成 JPEG 得走 toJPEG(quality 0~100)，它是下面这种 Buffer。
        const jpeg = resized.toJPEG(Math.round(IMAGE_JPEG_QUALITY * 100));
        const out = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
        if (!out) return dataUrl;
        // 罕见情况：小尺寸高噪点图压缩后反而更大，保留更小者
        return out.length >= dataUrl.length ? dataUrl : out;
    } catch {
        return dataUrl;
    }
}

export class ChatSessionService {
    private readonly userid: number;
    private readonly emitState: (state: ChatStateSnapshot) => void;
    private readonly localKnowledge: LocalKnowledge | undefined;
    private readonly readSettings: () => AiModelSettings | null;
    private readonly relaySender:
        | ((content: string, images: string[], kbContext: RetrievedPassage[]) => boolean)
        | undefined;
    /** 已经显示过的广播回复（按 requestId 去重，防止重连重放时刷屏） */
    private readonly shownRelayReplies = new Set<string>();
    private initialized = false;
    private disposed = false;
    /** 欢迎语是否已写入数据库（避免重启后重复补一条） */
    private welcomePersisted = false;
    // 本轮生成的取消控制器：用户点「停止」时中断模型请求。
    private abortController: AbortController | null = null;
    // 发送消息后的回复超时定时器：到点仍未收到回应则兜底结束等待态。
    private replyTimeout: ReturnType<typeof setTimeout> | null = null;
    private state: ChatStateSnapshot = {
        sessionId: crypto.randomUUID(),
        connected: false,
        lastError: "",
        waitingForReply: false,
        messages: [this.createMessage("pet", WELCOME_MESSAGE)],
        bubbleMessage: WELCOME_MESSAGE,
        bubbleInteractive: false,
    };

    constructor(options: ChatSessionOptions) {
        this.userid = options.userid;
        this.emitState = options.emitState;
        // 会话 id 由外部（main.ts 从 local-session.json）给定 —— 不再每次启动重掷，
        // 否则重启就换会话、上一段对话永远读不回来。
        if (options.sessionId) this.state.sessionId = options.sessionId;
        this.localKnowledge = options.localKnowledge;
        this.relaySender = options.relaySender;
        this.readSettings =
            options.readSettings ??
            (() => {
                const cfg = readModelConfigFile();
                return {
                    model: cfg.model || "",
                    endpoint: cfg.endpoint || "",
                    key: cfg.key || "",
                    searchProvider: cfg.searchProvider,
                    searchKey: cfg.searchKey,
                    searchEndpoint: cfg.searchEndpoint,
                    userid: this.userid,
                };
            });
    }

    /**
     * 初始化聊天服务。
     *
     * @param legacyJsonPath 旧版 chat-session.json 的路径。传了才会做一次性迁移；
     *   不传（或传空串）就是纯数据库模式。迁移成功后该文件会被改名成 .bak 留着，
     *   **不删** —— 用户自己的聊天记录，宁可留个备份也不能弄丢。
     */
    async init(legacyJsonPath?: string) {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        if (legacyJsonPath) {
            await this.migrateLegacyJson(legacyJsonPath);
        }
        await this.loadFromDb();
        this.ensureBubbleState();
        // 进程内引擎：把前端托管工具与私有知识库注入内核，并检查大脑是否就绪
        this.prepareEngine();
        this.emit();
    }

    /**
     * 一次性迁移：把旧版 chat-session.json 的内容导进 messages 表。
     *
     * 幂等且保守：
     *   · 文件不存在 / 解析失败 → 什么都不做（当没旧数据）；
     *   · 那个会话在库里已有消息 → 不导入（避免重复灌一遍，比如迁移后又回滚）；
     *   · 成功后把文件改名成 <名字>.migrated-<时间戳>.bak，不删。
     */
    private async migrateLegacyJson(jsonPath: string): Promise<void> {
        let legacy: LegacyPersistedChatState | null = null;
        try {
            const text = await fs.readFile(jsonPath, "utf-8");
            const parsed = JSON.parse(text) as LegacyPersistedChatState;
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
                legacy = parsed;
            }
        } catch {
            return; // 没有旧文件或读不出来：纯新装，无需迁移
        }
        if (!legacy) return;

        const sessionId = legacy.sessionId || crypto.randomUUID();
        const existing = await db.getSessionMessages(sessionId, 1);
        if (existing.length > 0) {
            // 库里已有这个会话的记录：说明迁移已经做过（或用户又在库里聊过了），跳过
            console.log("[chat-session] 数据库里已有该会话记录，跳过旧文件迁移");
        } else {
            let imported = 0;
            for (const m of legacy.messages) {
                if (!m || typeof m.text !== "string" || !m.text.trim()) continue;
                await db.saveMessage(sessionId, m.author === "pet" ? "assistant" : "user", m.text, {
                    emotion: m.emotion ?? null,
                    images: Array.isArray(m.images) ? m.images : undefined,
                });
                imported++;
            }
            console.log(`[chat-session] 已把旧聊天记录导入数据库（${imported} 条，会话 ${sessionId.slice(0, 8)}…）`);
        }

        // 备份旧文件：改名而非删除。用户数据宁可留一份多余的，不能因迁移出 bug 就没了。
        try {
            const backup = `${jsonPath}.migrated-${Date.now()}.bak`;
            await fs.rename(jsonPath, backup);
            console.log(`[chat-session] 旧聊天记录文件已备份为 ${path.basename(backup)}`);
        } catch (e) {
            console.warn("[chat-session] 旧文件备份失败（不影响使用）:", (e as Error)?.message || e);
        }
    }

    /** 从数据库加载当前会话的完整历史（聊天界面的记录真源）。 */
    private async loadFromDb(): Promise<void> {
        try {
            const rows = await db.getSessionMessages(this.state.sessionId, 200);
            if (rows.length > 0) {
                this.state.messages = rows.map((r) => this.uiMessageToChat(r));
                const lastPet = [...rows].reverse().find((r) => r.role === "assistant");
                this.lastPetSpeech = lastPet && typeof lastPet.content === "string" ? lastPet.content : "";
            }
        } catch (e) {
            console.warn("[chat-session] 读取聊天记录失败（从空历史开始）:", (e as Error)?.message || e);
        }
    }

    /** 数据库行 → 界面消息。role 只用 user/assistant，作者名按桌宠语义映射。 */
    private uiMessageToChat(row: db.UiMessage): ChatMessage {
        // content 可能是纯文本，也可能是 [text, image_url] 多模态数组（带图的那几条）。
        // 数组时必须把 text 段捞出来，否则带图消息在界面上只剩图片、文字全没了。
        let text = "";
        const inlineImages: string[] = [];
        if (typeof row.content === "string") {
            text = row.content;
        } else if (Array.isArray(row.content)) {
            for (const part of row.content) {
                if (!part || typeof part !== "object") continue;
                const p = part as { type?: string; text?: string; image_url?: { url?: string } };
                if (p.type === "text" && typeof p.text === "string") text += p.text;
                else if (p.type === "image_url" && p.image_url?.url) inlineImages.push(p.image_url.url);
            }
        }
        const images = [...inlineImages, ...(Array.isArray(row.images) ? row.images : [])];
        return {
            id: row.id,
            author: row.role === "assistant" ? "pet" : row.role === "user" ? "user" : "system",
            text,
            timestamp: row.timestamp,
            emotion: (row.emotion as PetEmotion | null) ?? null,
            images: images.length ? images : undefined,
        };
    }

    /**
     * 重新从数据库读一遍当前会话历史（不改会话 id）。
     *
     * 为什么需要：启动时旧聊天记录迁移（chat-session.json / 旧 kirari.db）跑在
     * 本服务 init 之后，而 local-session 的「收口」又会把那些刚写进来的旧会话
     * 并进本机会话 —— 合并完必须重新读一次，界面才看得到这批历史。
     */
    async refreshHistory(): Promise<void> {
        if (this.disposed) return;
        await this.loadFromDb();
        this.ensureBubbleState();
        this.emit();
    }

    getSnapshot() {
        return this.cloneState();
    }

    /** 当前会话 id（组网上行时要用；state 本身是私有的，只放行这一个字段） */
    getSessionId(): string {
        return this.state.sessionId;
    }

    async sendMessage(payload: { text: string; images?: string[] }) {
        const text = (payload.text || "").trim();
        const rawImages = Array.isArray(payload.images)
            ? payload.images.filter((x) => typeof x === "string" && x.trim())
            : [];
        // 发送前把过大的图片压缩好（最长边≤1280 + JPEG q0.8），从源头规避模型处理超大图失败。
        const images = rawImages.map((img) => downscaleImageDataUrl(img));
        if (!text && images.length === 0) {
            return false;
        }

        // 大脑未配置：不进等待态，直接给出可操作的提示（设置页入口）。
        const settings = this.readSettings();
        if (!engine.isConfigured(settings)) {
            this.state.connected = false;
            this.state.lastError = NOT_CONFIGURED_HINT;
            this.emit();
            return false;
        }

        this.state.waitingForReply = true;
        this.state.lastError = "";
        this.state.connected = true;
        this.state.messages.push(this.createMessage("user", text, undefined, images));
        this.persist();
        this.emit();
        this.armReplyTimeout();

        // ── 私人知识库检索（一次检索，两条路共用）──
        // 上行组网时带给主机；本地回答时注入引擎，跳过重复检索。
        // 失败静默降级为空 —— 知识库只是提高准确度的加分项，绝不能阻断聊天。
        let kbContext: RetrievedPassage[] = [];
        if (this.localKnowledge && text) {
            try {
                kbContext = await this.localKnowledge.search(text);
            } catch (e) {
                console.warn("[chat] 知识库检索失败（已忽略）：", (e as Error)?.message || e);
            }
        }

        // ── 组网：本机是叶子且已连上主机 ──
        // 请求上行给主机，由主机（唯一出口）调用模型并把结果广播回来。
        // 本地**不**再调模型 —— 这正是「一条消息只有一份回复」的落地方式。
        if (this.relaySender && this.relaySender(text, images, kbContext)) {
            return true; // 等 applyRelayResult 收尾
        }

        const controller = new AbortController();
        this.abortController = controller;

        try {
            const result = await engine.chat({
                settings: settings!,
                sessionId: this.state.sessionId,
                text,
                images,
                persona: frontendTools.collectBasePersona() || null,
                skillPrompts: frontendTools.collectSkillPrompts(),
                kbContext: kbContext.length > 0 ? kbContext : null,
                signal: controller.signal,
            });
            if (this.disposed) return true;

            this.clearReplyTimeout();
            this.state.waitingForReply = false;
            this.state.lastError = "";
            // 情绪标签：仅接受白名单值，避免脏数据破坏前端状态机
            const emotion: PetEmotion | null =
                result.emotion === "happy" || result.emotion === "wave" ? result.emotion : null;
            const replyImages = Array.isArray(result.images)
                ? result.images.filter((x: string) => typeof x === "string" && x.trim())
                : [];
            this.state.messages.push(
                this.createMessage("pet", result.speech, emotion, replyImages),
            );
            this.state.bubbleMessage = result.speech.length <= 10 ? result.speech : LONG_REPLY_PROMPT;
            this.state.bubbleInteractive = result.speech.length > 10;
            this.persist();
            this.emit();
            return true;
        } catch (e) {
            if (this.disposed) return true;
            const err = e as Error & { name?: string };
            const aborted = err?.name === "AbortError" || /abort/i.test(err?.message || "");
            this.clearReplyTimeout();
            this.state.waitingForReply = false;
            // 用户主动停止：不算错误，只清等待态，不给红色提示
            this.state.lastError = aborted ? "" : this.describeError(err);
            this.emit();
            return false;
        } finally {
            if (this.abortController === controller) this.abortController = null;
        }
    }

    /**
     * 显示主机广播回来的回复。
     *
     * 活锁模型下，回复由主机生成一次、广播给全网，所以**每台设备都会收到** ——
     * 包括别人问的问题（这是组网的社交感来源），也包括自己刚问的那条。
     * 请求方的发言本地已经显示过了，这里只补上回复。
     */
    applyRelayResult(frame: RelayResultFrame): void {
        if (this.disposed) return;
        const text = String(frame.speech || "").trim();
        if (!text) return;
        // 同一 requestId 只显示一次：重连重放、主机重复广播都不会刷屏
        if (this.shownRelayReplies.has(frame.requestId)) return;
        this.shownRelayReplies.add(frame.requestId);
        // 只保留最近 200 条，防止 Set 无限增长
        if (this.shownRelayReplies.size > 200) {
            const keep = [...this.shownRelayReplies].slice(-100);
            this.shownRelayReplies.clear();
            for (const id of keep) this.shownRelayReplies.add(id);
        }

        this.clearReplyTimeout();
        const emotion: PetEmotion | null =
            frame.emotion === "happy" || frame.emotion === "wave" ? frame.emotion : null;
        this.state.messages.push(this.createMessage("pet", text, emotion));
        this.state.waitingForReply = false;
        this.state.lastError = "";
        this.state.bubbleMessage = text.length <= 10 ? text : LONG_REPLY_PROMPT;
        this.state.bubbleInteractive = text.length > 10;
        this.persist();
        this.emit();
    }

    /** 主机拒绝了这次请求（排队满 / 正在关停），给出可操作提示而不是干等 */
    notifyRelayBusy(reason: string): void {
        if (this.disposed) return;
        this.clearReplyTimeout();
        this.state.waitingForReply = false;
        this.state.lastError = reason || "主机现在忙不过来，稍后再试";
        this.emit();
    }

    /** 组网相关的告知（如自动退出组网），显示在聊天区顶部 */
    notifyNotice(message: string): void {
        if (this.disposed) return;
        this.state.lastError = message;
        this.emit();
    }

    /** 用户点「停止生成」：中断当前模型请求。 */
    stopGeneration(): void {
        if (this.abortController) {
            try {
                this.abortController.abort();
            } catch {
                // 已结束的请求忽略
            }
            this.abortController = null;
        }
    }

    // 跨端同步：把「主人在其他协议端（如 QQ）发起的对话」注入到桌宠聊天框。
    // 仅由 AdapterManager 在 isOwner 时调用；guest 账号保持隔离，不调用本方法。
    // 语义与桌面自身收发一致：user 消息置 waitingForReply，pet 回复清 waiting 并更新气泡，
    // 并复用 lastPetSpeech 去重，避免重连/重试导致同一句刷屏。
    injectExternalMessage(msg: {
        author: ChatAuthor;
        text: string;
        images?: string[];
        emotion?: PetEmotion | null;
    }): void {
        const text = (msg.text || "").trim();
        const images = Array.isArray(msg.images)
            ? msg.images.filter((x) => typeof x === "string" && x.trim())
            : [];
        if (!text && images.length === 0) {
            return;
        }

        if (msg.author === "user") {
            this.state.messages.push(this.createMessage("user", text, undefined, images));
            this.state.waitingForReply = true;
            this.state.lastError = "";
            this.persist();
            this.emit();
            this.armReplyTimeout();
            return;
        }

        if (msg.author === "pet") {
            if (text === this.lastPetSpeech) {
                return;
            }
            this.lastPetSpeech = text;
            const emotion =
                msg.emotion === "happy" || msg.emotion === "wave" ? msg.emotion : undefined;
            this.state.messages.push(this.createMessage("pet", text, emotion, images));
            this.state.waitingForReply = false;
            this.state.bubbleMessage = text.length <= 10 ? text : LONG_REPLY_PROMPT;
            this.state.bubbleInteractive = text.length > 10;
            this.persist();
            this.emit();
        }
    }

    // 清空聊天记录（UI 的"清空"）：同时清 UI 历史与内核上下文历史。
    /**
     * 清空聊天记录（UI 的"清空"）。
     *
     * 同时清三处：内核上下文（旧会话的 db 行）、界面列表、以及数据库里的历史。
     * 旧实现只清了引擎（走 chat-session.json 时那份文件靠整体重写覆盖），
     * 现在数据库是真源，必须显式删掉旧 session_id 的行，否则清完刷新又全回来了。
     */
    async clearHistory(): Promise<void> {
        await engine.clearHistory(this.state.sessionId);
        try {
            await db.clearSession(this.state.sessionId);
        } catch (e) {
            console.warn("[chat-session] 清空数据库历史失败（不影响继续用）:", (e as Error)?.message || e);
        }
        // ⚠️ 不再换 sessionId。以前这里会重掷一个随机 id，等于「清空」顺便把会话
        //    也换了族 —— 核心版控制台、组网补传都按本机会话 id 找记录，换了就各说各话。
        //    清空就是清空：会话还是那一个，只是里面的消息没了。
        this.state.messages = [];
        this.lastPetSpeech = "";
        this.welcomePersisted = false;
        this.ensureBubbleState();
        this.persist();
        this.emit();
    }

    dispose() {
        this.disposed = true;
        this.stopGeneration();
        this.clearReplyTimeout();
    }

    /**
     * 让内核进入可用状态：注入前端托管工具（MCP / skill）与私有知识库，
     * 并检查大脑配置是否齐全。
     *
     * 原先这里是建立 WebSocket 连接并注册工具；进程内引擎不需要连接，
     * 改成本进程直接注入——省掉一次网络往返和"重连时要不要重新注册"的复杂度。
     */
    private prepareEngine() {
        try {
            const schemas = frontendTools.collectToolSchemas();
            const count = engine.registerFrontendTools(schemas, (name, args) =>
                frontendTools.executeTool(name, args),
            );
            if (count > 0) {
                console.log(`[chat-session] 已装载 ${count} 个额外能力`);
            }
        } catch (e) {
            console.warn("[chat-session] 装载额外能力失败:", e instanceof Error ? e.message : String(e));
        }

        // 私有知识库：本地检索直接进入内核，不再经"后端反向请求前端"
        if (this.localKnowledge) {
            engine.registerPrivateKnowledge(async (query, opts) => {
                const rows = await this.localKnowledge!.search(query, opts?.topK ?? 5);
                // 本地库的 tier 是自由字符串，内核只接受 A/B/C，这里做一次收敛
                return rows.map((r) => ({
                    text: r.text || "",
                    source: r.source,
                    score: r.score,
                    url: r.url,
                    tier: r.tier === "A" || r.tier === "B" || r.tier === "C" ? r.tier : undefined,
                    priority: r.priority,
                }));
            });
        }

        const settings = this.readSettings();
        const ready = engine.isConfigured(settings);
        this.state.connected = ready;
        this.state.lastError = ready ? "" : NOT_CONFIGURED_HINT;
    }

    /** 设置页改了大脑配置 / MCP / skill 后调用：重新装载能力并刷新就绪状态。 */
    refreshEngine(): void {
        if (this.disposed) return;
        this.prepareEngine();
        this.emit();
    }

    /** 设置页变更 MCP / skill 后重新装载（无需重启）。保留旧方法名，供主进程调用。 */
    reRegisterTools(): void {
        this.refreshEngine();
    }

    // 去重缓存：记录上一条 pet 消息的文本，防止同一句重复刷屏。
    private lastPetSpeech = "";

    /** 把内核/引擎异常翻译成用户看得懂的话。按项目规范不裸露技术术语。 */
    private describeError(err: Error): string {
        const msg = err?.message || "";
        if (/未配置|尚未配置|还没连接|还没填写|还没选择/.test(msg)) return msg;
        if (/401|403|invalid api key|unauthorized|Incorrect API/i.test(msg)) {
            return "大脑的钥匙不对或者过期了，去设置里重新填一下";
        }
        if (/429|quota|insufficient|余额/i.test(msg)) {
            return "大脑的额度用完了，换个钥匙或者等它恢复";
        }
        if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|network/i.test(msg)) {
            return "连不上大脑，检查一下网络或者接口地址";
        }
        if (/timeout|超时/i.test(msg)) {
            return "大脑想太久了没答上来，再问一次试试";
        }
        return "小灵没答上来，稍后再试一次吧";
    }

    private ensureBubbleState() {
        if (!this.state.messages.length) {
            this.state.messages.push(this.createMessage("pet", WELCOME_MESSAGE));
            this.state.bubbleMessage = WELCOME_MESSAGE;
            this.state.bubbleInteractive = false;
            this.persist();
            return;
        }

        if (!this.state.bubbleMessage) {
            const lastPetMessage = [...this.state.messages].reverse().find((message) => message.author === "pet");
            if (lastPetMessage) {
                const shortReply = lastPetMessage.text.trim().length <= 10;
                this.state.bubbleMessage = shortReply ? lastPetMessage.text.trim() : LONG_REPLY_PROMPT;
                this.state.bubbleInteractive = !shortReply;
            } else {
                this.state.bubbleMessage = WELCOME_MESSAGE;
                this.state.bubbleInteractive = false;
            }
        }
    }

    // 启动回复超时：发送消息后置 waitingForReply 时调用，给内核一个最迟回应期限。
    private armReplyTimeout() {
        this.clearReplyTimeout();
        this.replyTimeout = setTimeout(() => this.onReplyTimeout(), REPLY_TIMEOUT_MS);
    }

    private clearReplyTimeout() {
        if (this.replyTimeout) {
            clearTimeout(this.replyTimeout);
            this.replyTimeout = null;
        }
    }

    // 超时兜底：内核未在规定时间内回应。清除等待态并给出可见错误，避免 UI 永久卡在"思考中"。
    private onReplyTimeout() {
        this.replyTimeout = null;
        if (!this.state.waitingForReply) {
            return;
        }
        this.state.waitingForReply = false;
        this.state.lastError = "小灵想太久了，先停一下，你可以再问一次";
        this.emit();
    }

    private createMessage(author: ChatAuthor, text: string, emotion?: PetEmotion | null, images?: string[]): ChatMessage {
        return {
            id: crypto.randomUUID(),
            author,
            text,
            timestamp: Date.now(),
            emotion: emotion ?? null,
            images: images && images.length ? images : undefined,
        };
    }

    private cloneState(): ChatStateSnapshot {
        return {
            sessionId: this.state.sessionId,
            connected: this.state.connected,
            lastError: this.state.lastError,
            waitingForReply: this.state.waitingForReply,
            messages: this.state.messages.map((message) => ({ ...message })),
            bubbleMessage: this.state.bubbleMessage,
            bubbleInteractive: this.state.bubbleInteractive,
        };
    }

    private emit() {
        this.emitState(this.cloneState());
    }

    /**
     * 把当前状态落库。
     *
     * 2026-10-12 起聊天记录的**唯一真源是数据库**（用户拍板），不再写 chat-session.json。
     * 消息的入库由各产生点直接调 db.saveMessage 完成（engine.chat 存对话双方、
     * applyRelayResult 存广播回复、injectExternalMessage 存跨端注入）——
     * 那样情绪和图片能一并写进扩展列，走 UI 消息列表反推会丢掉这些字段。
     *
     * 所以这里只剩两件事要做：
     *   1. 保证会话在库里有记录（新会话的首条欢迎语也得有个落脚点）；
     *   2. 欢迎语这种「界面独有、不经引擎」的消息补一条入库。
     * 其余消息不重复写 —— 双写会让历史里每条出现两次。
     */
    private persist() {
        // 欢迎语：界面生成的兜底话，不经引擎，需要在这里补库
        const welcome = this.state.messages.find((m) => m.author === "pet" && m.text === WELCOME_MESSAGE);
        if (welcome && !this.welcomePersisted) {
            this.welcomePersisted = true;
            void db.saveMessage(this.state.sessionId, "assistant", WELCOME_MESSAGE).catch((e) => {
                console.warn("[chat-session] 写入欢迎语失败（不影响聊天）:", (e as Error)?.message || e);
                this.welcomePersisted = false;
            });
        }
    }
}
