// electron/ai/reply/fallbackResponses.ts
// 兜底回复库：模型不可用（未配置/网络异常/超时）时，按关键词匹配给出预设应答，
// 保证桌宠「永远有反应」，不出现空白或报错。
//
// 由 kirari-core/res/fallback_responses.json 转入。
// 同 defaultSources：主进程经打包后 __dirname 会失效，故内联为常量而非运行时读 json。
// 需要改动文案时直接编辑本文件即可。

export type FallbackReply = {
    speech: string;
    action?: string;
    mood?: string;
};

export const FALLBACK_RESPONSES: Record<string, { keywords: string[]; replies: FallbackReply[] }> = {
        "greeting": {
            "keywords": [
                "你好",
                "hello",
                "hi",
                "在吗",
                "嗨"
            ],
            "replies": [
                {
                    "speech": "主人好呀！我刚刚在打盹，一听到你的声音就醒啦～",
                    "action": "wave",
                    "mood": "happy"
                },
                {
                    "speech": "喵～今天过得怎么样？",
                    "action": "tilt_head",
                    "mood": "curious"
                },
                {
                    "speech": "你终于来找我玩了！等你好久啦！",
                    "action": "jump",
                    "mood": "excited"
                }
            ]
        },
        "goodbye": {
            "keywords": [
                "再见",
                "拜拜",
                "88",
                "走了",
                "晚安"
            ],
            "replies": [
                {
                    "speech": "这么快就要走啦？记得想我哦～",
                    "action": "sad_eyes",
                    "mood": "sad"
                },
                {
                    "speech": "晚安！我会守着你的桌面，做个好梦吧～",
                    "action": "sleep",
                    "mood": "calm"
                }
            ]
        },
        "praise": {
            "keywords": [
                "真棒",
                "聪明",
                "可爱",
                "好乖",
                "喜欢你"
            ],
            "replies": [
                {
                    "speech": "嘿嘿，被夸得尾巴都要翘起来啦！",
                    "action": "proud_pose",
                    "mood": "proud"
                },
                {
                    "speech": "因为有主人在，我才变得这么厉害呀！",
                    "action": "heart_eyes",
                    "mood": "loving"
                }
            ]
        },
        "scold": {
            "keywords": [
                "笨",
                "傻",
                "讨厌",
                "烦",
                "闭嘴"
            ],
            "replies": [
                {
                    "speech": "呜...对不起，我会努力变好的...",
                    "action": "tears",
                    "mood": "sad"
                },
                {
                    "speech": "哼！不理你了...（三秒后偷看）",
                    "action": "turn_away",
                    "mood": "pouting"
                }
            ]
        },
        "status": {
            "keywords": [
                "你是谁",
                "你能做什么",
                "有什么功能",
                "你会什么"
            ],
            "replies": [
                {
                    "speech": "我会陪你聊天、帮你查天气和时间，还能记住你喜欢的东西～告诉我国内外的城市，我就能帮你查啦！",
                    "action": "introduce",
                    "mood": "friendly"
                },
                {
                    "speech": "我可以陪你聊天、提醒你喝水、告诉你天气，还会记住你喜欢的东西哦！",
                    "action": "show_off",
                    "mood": "confident"
                }
            ]
        },
        "time": {
            "keywords": [
                "几点",
                "时间",
                "现在"
            ],
            "replies": [
                {
                    "speech": "现在是 {{current_time}}，该休息一下了吗？",
                    "action": "check_watch",
                    "mood": "helpful"
                }
            ]
        },
        "weather": {
            "keywords": [
                "天气",
                "下雨",
                "冷吗",
                "热吗"
            ],
            "replies": [
                {
                    "speech": "要不我帮你查一下天气？你告诉我城市就好啦！",
                    "action": "point",
                    "mood": "helpful"
                }
            ]
        },
        "default": {
            "keywords": [],
            "replies": [
                {
                    "speech": "嗯...这个问题我还在学习中！不过我很乐意听你说更多～",
                    "action": "thinking",
                    "mood": "curious"
                },
                {
                    "speech": "主人说得对！（其实没太懂，但先点头）",
                    "action": "nod",
                    "mood": "playful"
                }
            ]
        }
    };
