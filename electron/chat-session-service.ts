import fs from "fs/promises";
import path from "path";
import { nativeImage } from "electron";
import * as frontendTools from "./frontend-tools";
import * as engine from "./ai/engine";
import type { AiModelSettings } from "./ai/aiContext";
import { readModelConfigFile } from "./model-config";
import type { LocalKnowledge } from "../src/knowledge/localKnowledge";

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

type PersistedChatState = {
    sessionId: string;
    messages: ChatMessage[];
    bubbleMessage: string;
    bubbleInteractive: boolean;
};

type ChatSessionOptions = {
    userid: number;
    emitState: (state: ChatStateSnapshot) => void;
    // 私人知识库：发消息前本地检索，结果直接进入内核的私有知识库通道
    localKnowledge?: LocalKnowledge;
    // 模型配置读取器。缺省直接读 userData/config.json。
    readSettings?: () => AiModelSettings | null;
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
        const out = resized.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
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
    private storagePath = "";
    private persistenceQueue: Promise<void> = Promise.resolve();
    private initialized = false;
    private disposed = false;
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
        this.localKnowledge = options.localKnowledge;
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

    async init(storagePath: string) {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        this.storagePath = storagePath;
        await this.loadFromDisk();
        this.ensureBubbleState();
        // 进程内引擎：把前端托管工具与私有知识库注入内核，并检查大脑是否就绪
        this.prepareEngine();
        this.emit();
    }

    getSnapshot() {
        return this.cloneState();
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
    async clearHistory(): Promise<void> {
        await engine.clearHistory(this.state.sessionId);
        this.state.sessionId = crypto.randomUUID();
        this.state.messages = [];
        this.lastPetSpeech = "";
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

    private snapshotForDisk(): PersistedChatState {
        return {
            sessionId: this.state.sessionId,
            messages: this.state.messages.map((message) => ({ ...message })),
            bubbleMessage: this.state.bubbleMessage,
            bubbleInteractive: this.state.bubbleInteractive,
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

    private persist() {
        if (!this.storagePath) {
            return;
        }

        const payload = `${JSON.stringify(this.snapshotForDisk(), null, 2)}\n`;
        this.persistenceQueue = this.persistenceQueue
            .then(() => fs.mkdir(path.dirname(this.storagePath), { recursive: true }))
            .then(() => fs.writeFile(this.storagePath, payload, "utf-8"))
            .catch((error) => {
                console.error("❌ 保存聊天会话失败:", error);
            });
    }

    private async loadFromDisk() {
        try {
            const fileText = await fs.readFile(this.storagePath, "utf-8");
            const persisted = JSON.parse(fileText) as PersistedChatState;
            if (persisted.sessionId) {
                this.state.sessionId = persisted.sessionId;
            }
            if (Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                this.state.messages = persisted.messages.map((message) => ({ ...message }));
            }
            if (typeof persisted.bubbleMessage === "string") {
                this.state.bubbleMessage = persisted.bubbleMessage;
            }
            if (typeof persisted.bubbleInteractive === "boolean") {
                this.state.bubbleInteractive = persisted.bubbleInteractive;
            }
        } catch {
            this.persist();
        }
    }
}
