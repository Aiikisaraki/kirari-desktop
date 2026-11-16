// 内置能力：load_skill（阶段 D，一个能力一个文件）。SKILL.md 按需加载正文入口。
import { defineCapability, type Capability } from "kirari-agent";
import * as skillMd from "../../skills/skillMd";

const capability: Capability = defineCapability({
    id: "load_skill",
    name: "load_skill",
    kind: "tool",
    scope: "builtin",
    description: "按名字加载一个技能的完整说明。当你判断某项任务需要用到「可用技能」目录里列出的某个技能时，先调用本工具取得它的详细步骤，再按步骤执行。不需要的技能不要加载。",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "技能名，取自可用技能目录里的名字。" },
        },
        required: ["name"],
    },
    tags: ["builtin", "skill-loader"],
    timeoutMs: 10000,
    truncateChars: 20000,
});

async function dispatch(args: any): Promise<string> {
    const name = typeof args?.name === "string" ? args.name.trim() : "";
    if (!name) return "error: 缺少技能名 name";
    const body = skillMd.loadBody(name);
    if (body === undefined) {
        const names = skillMd.getSkills().map((s) => s.meta.name);
        return `error: 没有名为「${name}」的技能。可用技能：${names.length ? names.join("、") : "（无）"}`;
    }
    return `# 技能：${name}\n${body}`;
}

export { capability, dispatch };
