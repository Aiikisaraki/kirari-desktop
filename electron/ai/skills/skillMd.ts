// electron/ai/skills/skillMd.ts
// 阶段 D：SKILL.md 渐进披露装载器（桌宠端侧）。与 kirari-core/src/skills/skillMd.js 对称。
//
// 目录约定：<userData>/skills/<skillId>/SKILL.md。解析与拼装纯逻辑来自共享包；
// 本文件只做文件扫描 + 缓存。为可测试，支持 setSkillMdRoot() 注入隔离目录。

import fs from "node:fs";
import path from "node:path";
import { parseSkillMarkdown, skillCatalogLine, type ParsedSkill } from "kirari-agent";

let overrideRoot: string | null = null;

/** 注入自定义 skills 根目录（测试用，传 null 恢复默认 userData）。 */
export function setSkillMdRoot(root: string | null): void {
    overrideRoot = root;
    cache = null;
}

function defaultRoot(): string {
    if (overrideRoot) return overrideRoot;
    try {
        // 主进程运行时惰性取 userData；测试中未装 electron 时回退到临时目录。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require("electron") as typeof import("electron");
        return path.join(app.getPath("userData"), "skills");
    } catch {
        return path.join(process.cwd(), ".tmp-test", "skills");
    }
}

let cache: ParsedSkill[] | null = null;

function scan(): ParsedSkill[] {
    const root = defaultRoot();
    const parsed: ParsedSkill[] = [];
    if (fs.existsSync(root)) {
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            entries = [];
        }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const file = path.join(root, ent.name, "SKILL.md");
            if (!fs.existsSync(file)) continue;
            try {
                parsed.push(parseSkillMarkdown(fs.readFileSync(file, "utf8"), file));
            } catch (e) {
                console.warn(`[skillMd] 解析失败（跳过）：${file} — ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    // 兼容旧 skills.json 的 prompt 型技能。
    const json = path.join(path.dirname(root), "skills.json");
    if (fs.existsSync(json)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(json, "utf8"));
            for (const s of Array.isArray(cfg.skills) ? cfg.skills : []) {
                if (s.enabled === false || !s.prompt || !String(s.prompt).trim()) continue;
                const name = String(s.name || s.id || "skill").slice(0, 64);
                const description = String(s.description || "").slice(0, 200) || name;
                const md = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n${s.prompt}`;
                try {
                    parsed.push(parseSkillMarkdown(md, `skills.json:${name}`));
                } catch {
                    /* 单个坏技能跳过 */
                }
            }
        } catch {
            /* skills.json 损坏则忽略 */
        }
    }
    return parsed;
}

export function getSkills(): ParsedSkill[] {
    if (!cache) cache = scan();
    return cache;
}

export function invalidate(): void {
    cache = null;
}

/** 进 system 的目录摘要（不含正文）。 */
export function catalogBlock(): string {
    const skills = getSkills();
    if (!skills.length) return "";
    return "\n\n# 可用技能（需要时用 load_skill 加载完整说明）\n" + skills.map(skillCatalogLine).join("\n");
}

export function loadBody(name: string): string | undefined {
    return getSkills().find((s) => s.meta.name === name)?.body;
}
