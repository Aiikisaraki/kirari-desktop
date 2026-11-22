// electron/extensions/voiceOutgoing.ts
//
// 「这次回复要不要带语音条」的唯一判定点。
//
// 为什么单独一层：
//   · adapter 不该知道扩展包存在，更不该知道 TTS 是什么；
//   · 策略（私聊才发、多长就不发）是产品规则，和"能不能合成"是两件事；
//   · 最关键：**没有装扩展包时这里立刻返回 null**，主程序行为与现在完全一致。
//     所以调用点可以无条件写一行 await，然后在有值时把 audio 塞进出站消息。
//
// 失败一律降级为"不发语音"，绝不把异常抛回回复链路 ——
// 语音是锦上添花，不能因为它把文本回复也弄丢。

import { getTtsService, type AudioFormat } from "./contracts/tts";

/** 出站语音（协议端要的就是这三个字段）。 */
export interface BotOutgoingAudio {
    dataUrl: string;
    format: AudioFormat;
    durationMs: number;
}

export interface VoiceOutgoingPolicy {
    /** 总开关 */
    enabled: boolean;
    /** 只在私聊/主人会话里发语音条（群聊默认不发 —— 语音条在群里是负体验） */
    privateOnly: boolean;
    /** 超过这个长度就不发语音条，退回纯文本 */
    maxDurationMs: number;
    /** 合成超时：超时就不等了，文本先发出去 */
    timeoutMs: number;
    /** 指定音色；不填用扩展包的默认音色 */
    voiceId?: string;
    /** 指定输出格式，不填默认 mp3（最通用，协议端自己转 silk） */
    format?: AudioFormat;
}

export const DEFAULT_VOICE_POLICY: VoiceOutgoingPolicy = {
    enabled: true,
    privateOnly: true,
    maxDurationMs: 15000,
    timeoutMs: 8000,
};

export interface VoiceOutgoingContext {
    text: string;
    isGroup: boolean;
    isOwner: boolean;
}

/**
 * 生成一条出站语音。
 * 返回 null 表示"这次不带语音条"，调用方按原样只发文本。
 */
export async function buildVoiceOutgoing(
    ctx: VoiceOutgoingContext,
    policy: VoiceOutgoingPolicy = DEFAULT_VOICE_POLICY,
): Promise<BotOutgoingAudio | null> {
    const tts = getTtsService();
    if (!tts) return null; // 没装扩展：与历史行为完全一致
    if (!policy.enabled) return null;
    if (!ctx.text || !ctx.text.trim()) return null;
    if (policy.privateOnly && ctx.isGroup) return null;

    let timer: NodeJS.Timeout | undefined;
    try {
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), policy.timeoutMs);
            timer.unref?.();
        });
        const audio = await Promise.race([
            tts.synthesize({
                text: ctx.text,
                voiceId: policy.voiceId,
                format: policy.format ?? "mp3",
            }),
            timeout,
        ]);
        if (!audio || !audio.dataUrl) return null;
        if (!Number.isFinite(audio.durationMs) || audio.durationMs <= 0) return null;
        if (audio.durationMs > policy.maxDurationMs) return null; // 太长的语音条没人点
        return { dataUrl: audio.dataUrl, format: audio.format, durationMs: audio.durationMs };
    } catch (err) {
        console.warn("[ext] 语音合成失败，本次退回纯文本：", err instanceof Error ? err.message : err);
        return null;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
