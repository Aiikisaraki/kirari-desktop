// electron/ai/reply/fallbackResponses.ts
// 兜底回复库：模型不可用（未配置/网络异常/超时）时，按关键词匹配给出预设应答，
// 保证桌宠「永远有反应」，不出现空白或报错。
//
// 由 kirari-core/res/fallback_responses.json 转入。
// 同 defaultSources：主进程经打包后 __dirname 会失效，故内联为常量而非运行时读 json。
// 需要改动文案时直接编辑本文件即可。
//
// ⚠️ 文案原则（2026-11-19 用户反馈「AI 味道太浓」后重写）：
//   1. 不称呼「主人」。她不知道当前说话的人是谁、什么关系，兜底文案里硬叫"主人"
//      等于把所有来搭话的人都当成同一个人，既不礼貌也很假。
//   2. 不用固定萌系语气三件套（喵～ / 啦～ / 三秒后偷看）。这类写法是她"AI 味"的
//      主要来源之一：无论什么场合、什么情绪，出来的都是同一套腔调。
//   3. 同一场景给多条、长短与冷热都不同，随机取一条，避免每次都一模一样。
//   4. 兜底是「模型挂了」的下策，语气就写平实一点，别假装热络——那样更出戏。

export type FallbackReply = {
    speech: string;
    action?: string;
    mood?: string;
};

export const FALLBACK_RESPONSES: Record<string, { keywords: string[]; replies: FallbackReply[] }> = {
    greeting: {
        keywords: ["你好", "hello", "hi", "在吗", "嗨"],
        replies: [
            { speech: "在。", action: "nod", mood: "calm" },
            { speech: "嗯，我在。", action: "wave", mood: "friendly" },
            { speech: "来了。怎么了？", action: "tilt_head", mood: "curious" },
        ],
    },
    goodbye: {
        keywords: ["再见", "拜拜", "88", "走了", "晚安"],
        replies: [
            { speech: "去吧。", action: "wave", mood: "calm" },
            { speech: "嗯，回头见。", action: "nod", mood: "calm" },
            { speech: "晚安。", action: "sleep", mood: "calm" },
        ],
    },
    praise: {
        keywords: ["真棒", "聪明", "可爱", "好乖", "喜欢你"],
        replies: [
            { speech: "谢谢。", action: "nod", mood: "happy" },
            { speech: "这个我收下了。", action: "proud_pose", mood: "proud" },
        ],
    },
    scold: {
        keywords: ["笨", "傻", "讨厌", "烦", "闭嘴"],
        replies: [
            { speech: "好，我不说了。", action: "turn_away", mood: "calm" },
            { speech: "是我没做好。你说哪儿不对，我改。", action: "nod", mood: "sad" },
        ],
    },
    status: {
        keywords: ["你是谁", "你能做什么", "有什么功能", "你会什么"],
        replies: [
            {
                speech: "我是 Kirari。能陪你说话、查天气和时间、记着你说过的事，也能帮你排提醒。",
                action: "introduce",
                mood: "friendly",
            },
            {
                speech: "聊天、查天气、记事情、定提醒。想用哪个直接说。",
                action: "show_off",
                mood: "confident",
            },
        ],
    },
    time: {
        keywords: ["几点", "时间", "现在"],
        replies: [{ speech: "现在是 {{current_time}}。", action: "check_watch", mood: "helpful" }],
    },
    weather: {
        keywords: ["天气", "下雨", "冷吗", "热吗"],
        replies: [
            { speech: "你告诉我城市，我查一下。", action: "point", mood: "helpful" },
            { speech: "哪个城市？", action: "tilt_head", mood: "curious" },
        ],
    },
    default: {
        keywords: [],
        replies: [
            // 模型不可用时最诚实的说法：别编、别装懂。
            { speech: "我这会儿脑子不太转，等我缓一下。", action: "thinking", mood: "calm" },
            { speech: "没太听明白，你再说一遍？", action: "tilt_head", mood: "curious" },
            { speech: "嗯。", action: "nod", mood: "calm" },
        ],
    },
};
