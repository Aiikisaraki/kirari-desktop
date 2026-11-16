// 阶段 D：任务工具 schema 独立成无依赖模块，供 taskRuntime 与 capabilities/builtin 共用。
// 放在这里是为了避免 conversationService → registry → builtin/plan → taskRuntime 的
// 顶层循环依赖（eager glob 在模块加载期读 taskRuntime.PLAN_TOOL 会拿到 undefined）。

export const PLAN_TOOL = {
    type: "function" as const,
    function: {
        name: "plan",
        description:
            "当用户的请求包含多个连续动作（例如“先查天气再提醒我带伞”）时，先调用本工具把它拆成线性步骤逐一完成。一步一步来，每完成一步继续下一步，最后再给主人一句自然总结。单个简单请求无需调用。",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "任务的一句话标题。" },
                steps: {
                    type: "array",
                    description: "按顺序执行的步骤（1~20 步）。",
                    items: {
                        type: "object",
                        properties: {
                            kind: { type: "string", enum: ["tool", "reminder", "text"], description: "tool=调用工具；reminder=设置定时提醒；text=仅文字确认。" },
                            label: { type: "string", description: "步骤简短描述。" },
                            toolName: { type: "string", description: "kind=tool 时的工具名，如 get_weather / web_search。" },
                            toolArgs: { type: "object", description: "kind=tool 时的工具参数。" },
                            text: { type: "string", description: "kind=reminder 时的提醒内容。" },
                            delayMs: { type: "number", description: "kind=reminder 时，相对当前时间的毫秒数。" },
                            dueAt: { type: "number", description: "kind=reminder 时，绝对毫秒时间戳（与 delayMs 二选一）。" },
                        },
                        required: ["kind", "label"],
                    },
                },
            },
            required: ["title", "steps"],
        },
    },
};

export const REMINDER_TOOL = {
    type: "function" as const,
    function: {
        name: "schedule_reminder",
        description:
            "设置一个定时提醒，到点后宠物会主动提醒主人。例如“明天早上 8 点提醒我带伞”“30 分钟后提醒我喝水”。给出标题、内容与时间（绝对 dueAt 或相对 delayMs 二选一）。",
        parameters: {
            type: "object",
            properties: {
                title: { type: "string", description: "提醒的简短标题。" },
                text: { type: "string", description: "到点要提醒的具体内容。" },
                delayMs: { type: "number", description: "相对当前时间多少毫秒后提醒。" },
                dueAt: { type: "number", description: "绝对毫秒时间戳（与 delayMs 二选一）。" },
            },
            required: ["title", "text"],
        },
    },
};
