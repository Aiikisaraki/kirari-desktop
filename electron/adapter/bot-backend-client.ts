import type { PetBackendResponse } from "./types";
import type { LocalKnowledge } from "../../src/knowledge/localKnowledge";
import * as engine from "../ai/engine";
import type { AiModelSettings } from "../ai/aiContext";
import { readModelConfigFile } from "../model-config";
import { collectBasePersona, collectSkillPrompts } from "../frontend-tools";

type ResponseListener = (resp: PetBackendResponse) => void;

/**
 * 机器人适配器用的对话通道。
 *
 * 原来是「连后端 WebSocket，按 session_id 把 pet_response 分发给对应适配器」。
 * 现在 AI 内核跑在本进程内，这个类的对外接口（connect / send / onResponse / onStatus）
 * 完全保留，内部改为直接调用本地引擎——AdapterManager 与各协议适配器无需改动。
 *
 * 语义差异：
 *  - send() 现在是「等到回复生成完」而非「发出即返回」；
 *  - connected 表示「大脑配置齐全」，不再是「网络已连上后端」。
 */
export class BotBackendClient {
    private readonly localKnowledge: LocalKnowledge | undefined;
    private disposed = false;
    private listeners = new Map<string, ResponseListener>();
    private statusCbs: ((connected: boolean) => void)[] = [];

    constructor(_deprecatedUrl?: unknown, _deprecatedToken?: unknown, localKnowledge?: LocalKnowledge) {
        // 前两个参数（后端地址、令牌）已废弃：内核在本进程内，不再有连接地址与令牌。
        // 保留形参数位只为兼容既有调用点，不参与任何逻辑。
        this.localKnowledge = localKnowledge;
    }

    onStatus(cb: (connected: boolean) => void): void {
        this.statusCbs.push(cb);
    }

    /** 读取本机模型配置（大脑凭证由用户自持，存在 config.json）。 */
    private readSettings(): AiModelSettings | null {
        const cfg = readModelConfigFile();
        return {
            model: cfg.model || "",
            endpoint: cfg.endpoint || "",
            key: cfg.key || "",
            searchProvider: cfg.searchProvider,
            searchKey: cfg.searchKey,
            searchEndpoint: cfg.searchEndpoint,
        };
    }

    connect(): void {
        if (this.disposed) return;
        const ready = engine.isConfigured(this.readSettings());
        if (ready) {
            console.log("[bot-backend] 大脑已就绪");
        } else {
            console.warn("[bot-backend] 大脑还没配置好，机器人暂时无法回复");
        }
        this.statusCbs.forEach((cb) => cb(ready));
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
        const settings = this.readSettings();
        if (!engine.isConfigured(settings)) return false;

        const { content, images, sessionId, locationScope } = payload;
        try {
            const result = await engine.chat({
                settings: settings!,
                sessionId,
                text: content,
                images: Array.isArray(images) ? images : [],
                locationScope: locationScope ?? null,
                persona: collectBasePersona() || null,
                skillPrompts: collectSkillPrompts(),
            });
            const cb = this.listeners.get(sessionId);
            if (cb) {
                cb({
                    speech: result.speech,
                    emotion: result.emotion,
                    images: Array.isArray(result.images) ? result.images : [],
                    sessionId,
                });
            }
            return true;
        } catch (e) {
            console.error("[bot-backend] 生成回复失败:", e instanceof Error ? e.message : String(e));
            return false;
        }
    }

    disconnect(): void {
        this.disposed = true;
        this.listeners.clear();
    }

    /** 私有知识库检索（保留原语义：机器人侧也走本地库）。 */
    async searchKnowledge(query: string): Promise<unknown[]> {
        if (!this.localKnowledge) return [];
        return this.localKnowledge.search(query, 5);
    }
}
