// electron/extensions/contracts/tts.ts
//
// 「语音合成」这个**消费方契约**。
//
// 它故意不在宿主核心里：宿主只知道"有个叫 speech.tts 的服务"，
// 不知道语音是什么。这个文件是消费方（协议端回发、设置页）需要的类型，
// 也是扩展包作者实现 sidecar 时要对齐的方法名。
//
// sidecar 侧需要实现（宿主只认识这两个方法）：
//   service.call { serviceId: "speech.tts", method: "listVoices", params: { args: [] } }
//     → { voices: VoiceInfo[] }
//   service.call { serviceId: "speech.tts", method: "synthesize", params: { args: [TtsRequest] } }
//     → VoiceAudio
//
// 想接云端 TTS、本地 ONNX、自研模型，都只是换一个包。

import { getService } from "../host";

export type AudioFormat = "mp3" | "wav" | "opus";

/** 包内可选音色。音色是数据，不是代码 —— 换音色不该需要重新发版。 */
export interface VoiceInfo {
    id: string;
    label: string;
    language?: string;
    /** 情绪/风格标签；引擎不支持就留空 */
    styles?: string[];
    /** 试听样本，宿主只透传给设置页 */
    previewUrl?: string;
}

/** 合成结果。dataUrl 与图片同一种内联约定，宿主不需要落地成文件。 */
export interface VoiceAudio {
    dataUrl: string;
    format: AudioFormat;
    durationMs: number;
}

/** 合成请求：文本 + 可选音色参数。 */
export interface TtsRequest {
    text: string;
    voiceId?: string;
    format?: AudioFormat;
    /** 期望采样率；多数协议端按 24000 处理语音条 */
    sampleRate?: number;
    speed?: number;
    /** 情绪提示，引擎不认识就忽略 */
    emotion?: string;
}

/** 语音服务接口（宿主侧视角）。 */
export interface TtsService {
    listVoices(): Promise<VoiceInfo[]>;
    synthesize(req: TtsRequest): Promise<VoiceAudio>;
}

/** 服务 id 是契约的一部分，改名等于破坏兼容。 */
export const TTS_SERVICE_ID = "speech.tts";

/** 取语音服务；没有扩展提供时返回 null（调用方必须处理）。 */
export function getTtsService(): TtsService | null {
    return getService<TtsService>(TTS_SERVICE_ID);
}
