// 内置能力：web_search（阶段 D，一个能力一个文件）。
import { defineCapability, type Capability } from "kirari-agent";
import { webSearch } from "../../tools";

const capability: Capability = defineCapability({
    id: "web_search",
    name: "web_search",
    kind: "tool",
    scope: "builtin",
    description: "联网搜索实时信息、新闻或资料。当用户问最新新闻、实时股价、模糊事实、或天气/时间之外的实时信息时，优先使用。",
    parameters: {
        type: "object",
        properties: {
            query: { type: "string", description: "搜索关键词或问题。" },
            topic: { type: "string", enum: ["general", "news"], description: "general=综合搜索，news=新闻。默认 general。" },
        },
        required: ["query"],
    },
    tags: ["builtin"],
});

async function dispatch(args: any, ctx: any): Promise<string> {
    return await webSearch(args || {}, ctx || {});
}

export { capability, dispatch };
