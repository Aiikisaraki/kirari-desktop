// electron/ai/skills/skillMd.ts
// 阶段 D：SKILL.md 渐进披露装载器（桌宠端侧）。与 kirari-core/src/skills/skillMd.js 对称。
//
// 目录约定：<数据根>/skills/<skillId>/SKILL.md（~/.kirari/skills/...）。
// 解析与拼装纯逻辑来自共享包；本文件只做文件扫描 + 缓存。
// 为可测试，支持 setSkillMdRoot() 注入隔离目录。

import fs from "node:fs";
import path from "node:path";
import { parseSkillMarkdown, skillCatalogLine, type ParsedSkill } from "kirari-agent";
import { homePath } from "../../kirari-home";

let overrideRoot: string | null = null;

/** 注入自定义 skills 根目录（测试用，传 null 恢复默认数据根）。 */
export function setSkillMdRoot(root: string | null): void {
    overrideRoot = root;
    cache = null;
}

function defaultRoot(): string {
    if (overrideRoot) return overrideRoot;
    // 直接由布局真源求值，不依赖 electron app 是否已就绪（模块顶层可能更早求值）。
    return homePath("skillsRoot");
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
                // 第三参数 = 兜底名字（目录名）。Claude Code 等实现允许 SKILL.md 只写
                // description、以目录名当技能名；传入后这类技能也能直接用。
                parsed.push(parseSkillMarkdown(fs.readFileSync(file, "utf8"), file, ent.name));
            } catch (e) {
                console.warn(`[skillMd] 解析失败（跳过）：${file} — ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    // 兼容旧 skills.json 的 prompt 型技能（新布局里与 skills/ 同目录：skills/skills.json）。
    // 测试注入 overrideRoot 时仍从注入目录的父级取，避免读到真实数据根、污染用例。
    const json = overrideRoot ? path.join(path.dirname(overrideRoot), "skills.json") : homePath("skillsJson");
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

/**
 * 进 system 的目录摘要（不含正文）。
 *
 * 每条描述截到 160 字：标准技能常写几百字的触发条件，全文进目录会白烧 token，
 * 而目录的用途只是让模型认出「要不要加载」。真正需要全文时走 load_skill。
 * ⚠️ 必须用箭头函数包一层：直接 map(skillCatalogLine) 会把数组索引当第二个
 *    参数传进去，变成「截到第 N 个字」，描述被砍成一个字符。
 */
const CATALOG_DESC_MAX = 160;

export function catalogBlock(): string {
    const skills = getSkills();
    if (!skills.length) return "";
    return (
        "\n\n# 可用技能（需要时用 load_skill 加载完整说明）\n" +
        skills.map((s) => skillCatalogLine(s, CATALOG_DESC_MAX)).join("\n")
    );
}

export function loadBody(name: string): string | undefined {
    return getSkills().find((s) => s.meta.name === name)?.body;
}
