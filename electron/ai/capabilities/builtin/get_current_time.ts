// 内置能力：get_current_time（阶段 D，一个能力一个文件）。
import { defineCapability, type Capability } from "kirari-agent";
import { getCurrentTime } from "../../tools";

const capability: Capability = defineCapability({
    id: "get_current_time",
    name: "get_current_time",
    kind: "tool",
    scope: "builtin",
    description: "获取当前日期和时间。当用户问“现在几点”“今天几号”“现在是什么时间”等时使用。",
    parameters: {
        type: "object",
        properties: {
            timezone: { type: "string", description: "IANA 时区名，如 Asia/Shanghai；留空用系统本地时区。" },
        },
        required: [],
    },
    tags: ["builtin", "preflight"],
});

async function dispatch(args: any): Promise<string> {
    return await getCurrentTime(args || {});
}

export { capability, dispatch };
