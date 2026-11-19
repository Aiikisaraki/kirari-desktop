// electron/ai/services/memory.ts
// 长期记忆引擎（与核心版 src/services/memory.js 逐条对应，改一边必须同步另一边）。
//
// 为什么需要它（2026-11-19 用户原话）：
//   「有些记忆不应该是完全撕裂的，不能你新开一个对话，她就像不认识你一样……
//     记忆机制可以更加灵活一点，允许针对每一个不同对话者有不同的记忆池以及联想。」
//   「身份不应该粗暴地被分为主人和非主人，应该每一个用户在她那都有一套独立的记忆，
//     这些记忆可以随着人际关系的拓展而产生互相关联。
//     主人只是对这个 ai 智能体有最高管理权的用户角色。」
//
// 因此这里有两个正交的轴，不要混：
//   归属轴 subject —— 这条记忆存在谁的池子里，决定「谁会想起它」。
//   内容轴 aboutPerson —— 这条记忆说的是谁的事。A 转述「B 失恋了」时，
//                     池子是 A 的，内容关于 B。
//
// 以及一个独立的权限轴 role（people 表）：owner / admin / user ——
// 只表达管理权限，绝不参与记忆归属与可见性判断。

import * as db from "../db/storage";
import type { MemoryRow, PersonRow } from "../db/storage";

// ── subject 构造 ──────────────────────────────────────────────────────
/** 某个人自己的记忆池。 */
export const PERSON = (key: number | string) => `person::${key}`;
/** 她自己的 / 拥有者共享的长期事实池。 */
export const SELF = (uid: number | string) => `self::${uid}`;
/** 某个场合（群）的公共记忆池。 */
export const SCENE = (scope: string) => `scene::${scope}`;
/** 不属于任何人的常识与约定。 */
export const GLOBAL = "global";

export type MemoryCtx = {
    sessionId?: string;
    uid?: number | string;
    /** 管理权限角色：owner / admin / user。只影响能改什么设置，不影响记得谁。 */
    role?: string | null;
    /** 对话者标识（QQ 号等）；缺省从 sessionId 推导 */
    counterpartId?: string;
    /** 场合 scope（群号等）；缺省从 sessionId 推导 */
    sceneScope?: string;
    isGroup?: boolean;
    displayName?: string | null;
    platform?: string | null;
};

/** 会话是不是多人场合。只影响可见性判断，不影响记忆归属。 */
export function isGroupSession(sessionId?: string): boolean {
    return /(^|[-:_.])(group|channel|dm):/i.test(String(sessionId || ""));
}

/** 从 sessionId 解析场合 scope（群号等）。 */
export function sceneScopeFromSession(sessionId?: string): string {
    const s = String(sessionId || "");
    let m = /(?:^|-)(?:group|channel):([^:]+)/i.exec(s);
    if (m) return m[1];
    m = /group:([^:]+)/i.exec(s);
    if (m) return m[1];
    return s || "unknown";
}

/** 从 sessionId 解析对话者标识。 */
export function counterpartFromSession(sessionId?: string): string {
    const s = String(sessionId || "");
    let m = /(?:private|group|channel|dm):(.*)$/i.exec(s);
    if (m) {
        const parts = m[1].split(":").filter(Boolean);
        return parts[parts.length - 1] || m[1];
    }
    m = /user:([^:]+)/i.exec(s);
    if (m) return m[1];
    return s || "unknown";
}

export type Identity = {
    sessionId: string;
    uid: number | string;
    counterpartId: string;
    role: string | null;
    isGroup: boolean;
    sceneScope: string;
    displayName: string | null;
    platform: string | null;
};

/** 把「此刻在跟谁说话」收敛成唯一可信的身份对象。 */
export function resolveIdentity(ctx: MemoryCtx = {}): Identity {
    const sessionId = String(ctx.sessionId || "");
    return {
        sessionId,
        uid: ctx.uid != null ? ctx.uid : "anon",
        counterpartId: String(ctx.counterpartId || counterpartFromSession(sessionId)),
        role: ctx.role || null,
        isGroup: ctx.isGroup != null ? !!ctx.isGroup : isGroupSession(sessionId),
        sceneScope: ctx.sceneScope || sceneScopeFromSession(sessionId),
        displayName: ctx.displayName || null,
        platform: ctx.platform || null,
    };
}

/**
 * 当前这一轮该读哪些记忆池，顺序即优先级。
 *
 * 「每人一套独立记忆」就是在这里落实的：只把自己的池 + 当前场合的池 +
 * 自己的常识池放进来，别人的 person 池根本不在查询范围内。
 */
export function resolveSubjects(ctx: MemoryCtx = {}, identity?: Identity): string[] {
    const id = identity || resolveIdentity(ctx);
    const subs: string[] = [];
    subs.push(SELF(id.uid));
    if (id.isGroup) subs.push(SCENE(id.sceneScope));
    if (id.counterpartId && id.counterpartId !== "unknown") subs.push(PERSON(id.counterpartId));
    subs.push(GLOBAL);
    return [...new Set(subs)];
}

/**
 * 单条记忆在**此刻这个场合、面对这个人**是否可读。隐私的唯一闸门。
 *   1) 池子隔离：只能读自己池里的
 *   2) 场合隔离：群聊里 private/secret 一律不给看
 *   3) 内容归属：secret 只给当事人本人
 */
export function isMemoryVisible(mem: MemoryRow, identity: Identity): boolean {
    const subject = String(mem.subject || "");
    const vis = String(mem.visibility || "private");
    const cp = identity.counterpartId;

    // (1) 池子隔离：person::X 只对 X 本人开放
    if (subject.startsWith("person::") && subject.slice("person::".length) !== cp) return false;

    // self:: 池是「她与拥有者共享的长期事实」
    if (subject.startsWith("self::")) {
        if (identity.role !== "owner" && vis !== "public") return false;
    }

    // (2) 场合隔离：群里只给 public
    if (identity.isGroup && vis !== "public") return false;

    // (3) 内容归属：secret 只给当事人本人
    if (vis === "secret") {
        const about = mem.aboutPerson == null ? null : String(mem.aboutPerson);
        if (about && about !== cp) return false;
        if (!about) {
            const own =
                (subject.startsWith("person::") && subject.slice("person::".length) === cp) ||
                (subject.startsWith("self::") && identity.role === "owner");
            if (!own) return false;
        }
    }

    return true;
}

/** 兼容旧调用点：当前场合能读到哪些 visibility（粗粒度）。 */
export function allowedVisibility(ctx: MemoryCtx = {}): string[] {
    const id = resolveIdentity(ctx);
    if (id.isGroup) return ["public"];
    return ["public", "private", "secret"];
}

/** 中英文粗略切词。 */
export function tokenize(text?: string): Set<string> {
    const s = String(text || "").toLowerCase();
    const out = new Set<string>();
    for (const w of s.split(/[\s，。、；：！？,.;:!?"'()（）\[\]{}<>《》~～|/\\\-]+/)) {
        if (w.length >= 2) out.add(w);
    }
    const cn = s.replace(/[^\u4e00-\u9fa5]/g, "");
    for (let i = 0; i + 2 <= cn.length; i += 1) out.add(cn.slice(i, i + 2));
    return out;
}

/**
 * 相关度打分。纯词面匹配对中文短问句太弱，所以给「同池」记忆一个基础分：
 * 联想本就该先想起关于这个人的事。
 */
function scoreMemory(mem: MemoryRow, queryTokens: Set<string>, ctxSubjects: string[]): number {
    const mt = tokenize(mem.content);
    let overlap = 0;
    for (const t of queryTokens) if (mt.has(t)) overlap += 1;
    const rank = ctxSubjects.indexOf(mem.subject);
    let score = overlap * 10;
    const isContextual = mem.subject !== GLOBAL;
    score += isContextual ? 8 : 2;
    score += Math.max(0, 6 - rank * 2);
    score += (mem.importance || 3) * 2;
    score += Math.min(4, Math.floor((mem.hits || 0) / 3));
    return score;
}

/** 按池分组的中文标签。 */
function groupLabel(subject: string): string {
    if (subject.startsWith("self::")) return "关于你自己和这段关系";
    if (subject.startsWith("person::")) return "关于此刻跟你说话的人";
    if (subject.startsWith("scene::")) return "这个场合里大家的事";
    return "你记得的常识与约定";
}

/**
 * 注入前的脱敏：去掉"谁说的"这类来源信息。
 * 关于 B 的事可能是 A 转述的，B 有权知道内容，但不该知道是 A 在背后说的。
 */
function sanitizeForSubject(content?: string): string {
    return String(content || "")
        .replace(/^[^\s，。]{1,12}(说|告诉我|跟我讲|提到|聊到)[，,]?\s*/, "")
        .replace(/^(听说|有人说|有人告诉我)[，,]?\s*/, "");
}

/** 组装本轮要注入的记忆段。 */
export async function buildMemoryBlock(
    ctx: MemoryCtx = {},
    query = "",
    opts: { limit?: number; expand?: boolean } = {},
): Promise<{ block: string; items: MemoryRow[] }> {
    const identity = resolveIdentity(ctx);
    const subjects = resolveSubjects(identity, identity);
    let rows: MemoryRow[] = [];
    try {
        rows = await db.listMemories(subjects, { limit: 200 });
    } catch {
        return { block: "", items: [] };
    }

    // ── 关联方向一：关于「此刻这个人」的事，哪怕记在别人的池里 ──────────
    const known = new Set(rows.map((m) => m.id));
    if (identity.counterpartId && identity.counterpartId !== "unknown") {
        try {
            const about = await db.listMemoriesAbout(identity.counterpartId, { limit: 60 });
            for (const m of about) {
                if (known.has(m.id)) continue;
                // 群里不浮现别人的转述；一对一才谈"关于你的事"
                if (identity.isGroup) continue;
                rows.push({ ...m, _aboutMe: true } as MemoryRow & { _aboutMe: boolean });
            }
        } catch {
            /* 关联查询失败不影响主流程 */
        }
    }

    // ── 关联方向二：关系网里那些公开的事 ────────────────────────────────
    if (opts.expand !== false && identity.counterpartId && identity.counterpartId !== "unknown") {
        try {
            const links = await db.expandLinks([PERSON(identity.counterpartId)], { depth: 1, minWeight: 3 });
            const extraPersons = links
                .filter((l) => l.relation === "knows" && String(l.other).startsWith("person::"))
                .map((l) => l.other);
            if (extraPersons.length) {
                const extra = await db.listMemories(extraPersons, { limit: 50 });
                const seen2 = new Set(rows.map((m) => m.id));
                rows = rows.concat(
                    extra.filter((m) => !seen2.has(m.id)).map((m) => ({ ...m, _viaLink: true }) as MemoryRow & { _viaLink: boolean }),
                );
            }
        } catch {
            /* 关联查询失败不影响主流程 */
        }
    }

    type Tagged = MemoryRow & { _aboutMe?: boolean; _viaLink?: boolean };
    const usable = (rows as Tagged[]).filter((m) =>
        m._aboutMe ? m.visibility !== "secret" : isMemoryVisible(m, identity),
    );
    if (!usable.length) return { block: "", items: [] };

    const qTokens = tokenize(query);
    const scored = usable
        .map((m) => {
            let s = scoreMemory(m, qTokens, subjects);
            // 通过关系网扩散来的记忆降权：不如本人池直接可靠
            if (m._viaLink) s -= 6;
            return { m, s };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, Math.max(1, Number(opts.limit) || 12));

    if (!scored.length) return { block: "", items: [] };

    const buckets = new Map<string, Tagged[]>();
    for (const { m } of scored) {
        const k = groupLabel(m.subject);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(m);
    }

    const lines: string[] = ["\n\n【你记得的事 · 请自然运用，不要照本宣科】"];
    if (identity.isGroup) {
        lines.push("（以下是你在当前场合被允许想起的内容。别人的私事此刻看不到，也不要去猜。）");
    }
    let hasAboutMe = false;
    for (const [label, items] of buckets) {
        lines.push(`· ${label}：`);
        for (const m of items) {
            if (m._aboutMe) {
                hasAboutMe = true;
                lines.push(`  - ${sanitizeForSubject(m.content)}`);
            } else {
                lines.push(`  - ${m.content}`);
            }
        }
    }
    if (hasAboutMe) {
        lines.push(
            '（其中有几条是关于对方本人的，可能是别处听来的。可以关心，但不要说出是从谁那里知道的——通常对方也不希望别人在背后议论自己。若对方问起"你怎么知道"，就说是自己留意到的，或者说不太记得了，别点别人的名字。）',
        );
    }
    lines.push("用法：这些是背景，不是台词。相关时自然带出，不相关就别硬提；也不要罗列成清单念给对方听。");

    try {
        await db.touchMemory(scored.map((x) => x.m.id));
    } catch {
        /* 计数失败忽略 */
    }
    return { block: lines.join("\n"), items: scored.map((x) => x.m) };
}

/** 去重键：去掉标点空白后比较。 */
function normalizeForDedupe(text?: string): string {
    return String(text || "")
        .replace(/\s+/g, "")
        .replace(/[，。、；：！？,.;:!?"'()（）\[\]{}《》~～]/g, "")
        .toLowerCase();
}

/** 明显不该外泄的内容 → 强制 secret。兜底，主防线是可见性闸门。 */
export function isSensitive(text?: string): boolean {
    const s = String(text || "");
    return /(密码|密钥|api[_ -]?key|token|口令|身份证|银行卡|手机号|住址|家庭住址|抑郁症|病史|工资|薪水|取向|出柜)/i.test(s);
}

export type RememberInput = {
    content?: string;
    subject?: string;
    subjectId?: string;
    scope?: string;
    aboutPerson?: string | null;
    kind?: string;
    visibility?: string;
    importance?: number;
    source?: string;
};

/** 写入一条记忆。默认落进「此刻这个人的池」——这就是"每人一套记忆"。 */
export async function remember(
    input: RememberInput = {},
    ctx: MemoryCtx = {},
): Promise<{ ok: boolean; id?: number; reason?: string; duplicate?: boolean }> {
    const content = String(input.content || "").trim().slice(0, 2000);
    if (!content) return { ok: false, reason: "empty" };

    const identity = resolveIdentity(ctx);
    const cp = identity.counterpartId;

    let subject: string;
    const scope = String(input.scope || "").toLowerCase();
    if (scope === "global") subject = GLOBAL;
    else if (scope === "self") subject = SELF(identity.uid);
    else if (scope === "scene") subject = SCENE(identity.sceneScope);
    else if (scope === "person") subject = PERSON(input.subjectId || cp);
    else if (input.subject) subject = String(input.subject);
    else if (identity.isGroup && !input.subjectId) subject = SCENE(identity.sceneScope);
    else subject = PERSON(cp);

    // 内容归属：显式 aboutPerson 优先；否则一对一里默认就是关于对方
    const aboutPerson =
        input.aboutPerson != null
            ? String(input.aboutPerson)
            : !identity.isGroup && subject.startsWith("person::")
              ? cp
              : null;

    let visibility = ["public", "private", "secret"].includes(String(input.visibility))
        ? String(input.visibility)
        : null;
    if (!visibility) {
        if (subject.startsWith("scene::")) visibility = "public";
        else visibility = "private";
    }
    if (isSensitive(content)) visibility = "secret";

    // 去重
    try {
        const exist = await db.findMemoryByContent(subject, content);
        if (exist) {
            if (input.importance && Number(input.importance) > (exist.importance || 3)) {
                await db.updateMemory(exist.id, { importance: Number(input.importance) });
            }
            return { ok: true, id: exist.id, duplicate: true };
        }
        const before = await db.listMemories([subject], { limit: 200 });
        const norm = normalizeForDedupe(content);
        for (const row of before || []) {
            if (normalizeForDedupe(row.content) === norm) return { ok: true, id: row.id, duplicate: true };
        }
    } catch {
        /* 去重失败就直接写，宁可多一条也别丢 */
    }

    const id = await db.addMemory({
        subject,
        kind: ["fact", "preference", "event", "rule"].includes(String(input.kind)) ? String(input.kind) : "fact",
        content,
        visibility,
        originSession: identity.sessionId || null,
        aboutPerson,
        source: ["self", "told", "observed"].includes(String(input.source)) ? String(input.source) : "told",
        importance: Number(input.importance) || 3,
    });
    return { ok: !!id, id: id || undefined };
}

/** 忘掉记忆（按 id 或关键词）。只软删除，留痕可恢复。 */
export async function forget(
    input: { id?: number; keyword?: string; content?: string } = {},
    ctx: MemoryCtx = {},
): Promise<{ ok: boolean; id?: number; removed?: number; ids?: number[]; reason?: string }> {
    const identity = resolveIdentity(ctx);
    const subjects = resolveSubjects(identity, identity);
    if (input.id != null) {
        const rows = await db.listMemories(subjects, { limit: 500 });
        if (!(rows || []).some((r) => Number(r.id) === Number(input.id))) {
            return { ok: false, reason: "not_in_scope" };
        }
        const ok = await db.deleteMemory(Number(input.id));
        return { ok, id: Number(input.id) };
    }
    const kw = String(input.keyword || input.content || "").trim();
    if (!kw) return { ok: false, reason: "need_id_or_keyword" };
    const rows = await db.listMemories(subjects, { limit: 500 });
    const hit = (rows || []).filter((r) => r.content.includes(kw));
    let n = 0;
    for (const r of hit) {
        if (await db.deleteMemory(r.id)) n += 1;
    }
    return { ok: n > 0, removed: n, ids: hit.map((r) => r.id) };
}

/** 列记忆（当前场合可见）。 */
export async function list(ctx: MemoryCtx = {}, opts: { limit?: number } = {}): Promise<MemoryRow[]> {
    const identity = resolveIdentity(ctx);
    const subjects = resolveSubjects(identity, identity);
    const rows = await db.listMemories(subjects, { limit: opts.limit || 100 });
    return (rows || []).filter((m) => isMemoryVisible(m, identity));
}

/** 记忆统计。 */
export async function stats(): Promise<{ total: number; bySubject: { subject: string; count: number }[] }> {
    try {
        return await db.memoryStats();
    } catch {
        return { total: 0, bySubject: [] };
    }
}

// ── 人物档案与关联 ────────────────────────────────────────────────────

/** 记录「这个人存在」并刷新最后活跃时间。每次收到消息调一次。 */
export async function touchPerson(
    info: {
        personKey?: string;
        role?: string;
        displayName?: string | null;
        platform?: string | null;
    },
    _ctx: MemoryCtx = {},
): Promise<PersonRow | null> {
    const key = String(info.personKey || "").trim();
    if (!key) return null;
    try {
        await db.upsertPerson({
            personKey: key,
            role: info.role || "user",
            displayName: info.displayName || null,
            platform: info.platform || null,
        });
        return await db.getPerson(key);
    } catch {
        return null;
    }
}

/** 查这个人是谁、有什么权限。查不到就当作普通对话者。 */
export async function getPerson(personKey: string): Promise<PersonRow | null> {
    const key = String(personKey || "").trim();
    if (!key) return null;
    try {
        return await db.getPerson(key);
    } catch {
        return null;
    }
}

/** 建立/更新关联（人—人、人—事、事—事）。 */
export async function link(
    a: string,
    b: string,
    relation = "related",
    weight = 3,
): Promise<{ ok: boolean; reason?: string }> {
    try {
        return { ok: await db.addLink(a, b, relation, weight) };
    } catch (e: any) {
        return { ok: false, reason: e?.message || String(e) };
    }
}

/** 取某个节点的关联网络。 */
export async function linksOf(node: string) {
    try {
        return await db.listLinks(node);
    } catch {
        return [];
    }
}
