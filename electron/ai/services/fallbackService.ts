// electron/ai/services/fallbackService.ts
// 兜底回复：模型不可用（还没配置大脑 / 网络异常 / 超时）时，按关键词匹配预设应答，
// 保证桌宠永远有反应，不会出现空白或报错弹窗。
//
// 由 kirari-core/src/services/fallbackService.js 迁入。
// 改动：
//  1. 回复库由运行时读 res/fallback_responses.json 改为内联常量（打包路径会失效）
//  2. 原实现在分类缺失时会直接崩（categoryData.replies 未判空），这里补齐容错
//  3. 支持 {{current_time}} 动态变量

import { FALLBACK_RESPONSES } from "../reply/fallbackResponses";
import type { FallbackReply } from "../reply/fallbackResponses";

/** 关键词 → 分类。顺序即优先级，首个命中生效。 */
const RESPONSE_CATEGORIES: { name: string; keywords: string[] }[] = [
    { name: "greeting", keywords: ["你好", "hello", "hi", "在吗", "嗨"] },
    { name: "goodbye", keywords: ["再见", "拜拜", "88", "走了", "晚安"] },
    { name: "praise", keywords: ["真棒", "聪明", "可爱", "好乖", "喜欢你"] },
    { name: "scold", keywords: ["笨", "傻", "讨厌", "烦", "闭嘴"] },
    { name: "status", keywords: ["你是谁", "你能做什么", "有什么功能", "你会什么"] },
    { name: "time", keywords: ["几点", "时间", "现在"] },
    { name: "weather", keywords: ["天气", "下雨", "冷吗", "热吗"] },
];

/** 按分类附带情绪标签，供前端"情绪优先"动画使用 */
const CATEGORY_EMOTION: Record<string, string> = {
    greeting: "wave",
    praise: "happy",
    goodbye: "wave",
    scold: "sad",
};

export type FallbackResult = {
    speech: string;
    action?: string;
    mood?: string;
    emotion?: string | null;
};

/**
 * 取一条兜底回复。
 * @param content 用户消息
 * @param persona 保留参数（兜底语不区分人格，仅为签名兼容）
 */
export function getReply({ content = "" }: { content?: string; persona?: string | null } = {}): FallbackResult {
    // 1. 匹配分类（未命中走 default）
    let categoryName = "default";
    for (const category of RESPONSE_CATEGORIES) {
        if (category.keywords.some((k) => content.includes(k))) {
            categoryName = category.name;
            break;
        }
    }

    // 2. 该分类下随机一条（分类缺失或为空 → 回退到 default，再缺则硬兜底）
    const bucket = FALLBACK_RESPONSES[categoryName] || FALLBACK_RESPONSES.default;
    const replies: FallbackReply[] = bucket?.replies || [];
    if (!replies.length) {
        return { speech: "（歪头）我好像没听清，再说一次好不好？", emotion: null };
    }
    const pick = replies[Math.floor(Math.random() * replies.length)];
    const reply: FallbackResult = { ...pick };

    // 3. 动态变量
    if (reply.speech.includes("{{current_time}}")) {
        const now = new Date();
        const timeString = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        reply.speech = reply.speech.replace("{{current_time}}", timeString);
    }

    reply.emotion = CATEGORY_EMOTION[categoryName] || null;
    return reply;
}
