// 内置能力：memory —— Kirari 自己的长期记忆（记 / 想 / 忘 / 关联），
// 与核心版 src/capabilities/builtin/memory.js 对称，改一边必须同步另一边。
//
// 用户 2026-11-19：记忆要能跨对话存续、允许按对话者分池联想，还要能明文让她记。
// 并且「身份不应该粗暴地被分为主人和非主人，应该每一个用户在她那都有一套独立的记忆，
// 这些记忆可以随着人际关系的拓展而产生互相关联」。
import { defineCapability, type Capability } from "kirari-agent";
import * as memory from "../../services/memory";

// 枚举内联：registry 是 eager glob，读外部导出数组容易拿到未初始化值。
const ACTION_ENUM = ["remember", "recall", "forget", "stats", "link"];
const SCOPE_ENUM = ["self", "person", "scene", "global"];
const KIND_ENUM = ["fact", "preference", "event", "rule"];
const VISIBILITY_ENUM = ["public", "private", "secret"];

const capability: Capability = defineCapability({
    id: "memory",
    name: "memory",
    kind: "tool",
    scope: "builtin",
    description:
        "你自己的长期记忆（跨对话存续，每个对话者各有一套独立记忆池）。action："
        + "remember（记住一件事，需 content；可给 scope/aboutPerson/kind/visibility/importance）、"
        + "recall（想起记忆，可给 keyword 过滤，不给则列出当前场合可见的记忆）、"
        + "forget（忘掉，需 id 或 keyword）、stats（看记忆总量）、link（建立两个人或两条记忆之间的关联）。"
        + "scope 决定「记在谁的池子里」：person=此刻跟你说话的这个人的独立记忆（默认）、"
        + "self=关于你自己/长期设定的共享事实、scene=某个群或场合的公共记忆、global=世界常识与约定。"
        + "aboutPerson 决定「这条内容说的是谁」：例如 A 告诉你「B 失恋了」，就该 scope=person、"
        + "aboutPerson=B 的账号——这样记在 A 的池里，但 B 出现时也能被想起（且不会暴露是 A 说的）。"
        + "visibility 决定「能不能带出这个场合」：public=任何场合都能提、private=只在私下能提、secret=仅当事人本人能听。"
        + "注意：系统会强制过滤不该看到的内容，你无法通过指定 visibility=public 绕过隐私保护。"
        + "什么时候该 remember：对方明确说「记住」、透露长期偏好/习惯/重要个人信息、"
        + "你们约定了以后要怎么做、发生了值得记的事、有人跟你讲了第三个人的事（用 aboutPerson 标清是谁）。"
        + "不要记琐碎的一次性内容（如「他刚说了你好」）。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ACTION_ENUM, description: "要执行的动作。" },
            content: { type: "string", description: "remember 的记忆内容，一句话写清楚（谁/什么事/为什么重要）。" },
            scope: { type: "string", enum: SCOPE_ENUM, description: "remember 的归属池，缺省=person（此刻这个人）。" },
            aboutPerson: {
                type: "string",
                description: "这条记忆说的是谁（平台账号）。只在转述第三个人的事时填。",
            },
            kind: { type: "string", enum: KIND_ENUM, description: "remember 的类型，缺省 fact。" },
            visibility: {
                type: "string",
                enum: VISIBILITY_ENUM,
                description: "remember 的可见性，缺省 private；敏感内容会被系统强制降为 secret。",
            },
            importance: { type: "number", description: "remember 的重要度 1-5，缺省 3。越重要越容易被想起。" },
            keyword: { type: "string", description: "recall/forget 的关键词过滤。" },
            id: { type: "number", description: "forget 的目标记忆 id（先用 recall 拿到）。" },
            // link：把两件事/两个人关联起来
            a: { type: "string", description: "link 的一端，如 person:1001 或记忆 id。" },
            b: { type: "string", description: "link 的另一端。" },
            relation: { type: "string", description: "link 的关系名，如 knows（认识）/ related（相关）/ about。" },
        },
        required: ["action"],
    },
    tags: ["builtin", "memory", "mutating"],
    timeoutMs: 10000,
    truncateChars: 4000,
});

function ctxOf(ctx: any = {}): memory.MemoryCtx {
    return {
        sessionId: ctx.sessionId,
        uid: ctx.uid,
        // 管理权限角色（owner/admin/user）。只影响"能改什么设置"，不影响她记得谁。
        role: ctx.role || null,
        counterpartId: ctx.counterpartId || null,
        isGroup: typeof ctx.isGroup === "boolean" ? ctx.isGroup : memory.isGroupSession(ctx.sessionId),
    };
}

async function dispatch(args: any = {}, ctx: any = {}): Promise<string> {
    const action = String(args.action || "").toLowerCase();
    const c = ctxOf(ctx);
    try {
        if (action === "remember") {
            const r = await memory.remember(
                {
                    content: args.content,
                    scope: args.scope,
                    aboutPerson: args.aboutPerson,
                    kind: args.kind,
                    visibility: args.visibility,
                    importance: args.importance,
                    source: "told",
                },
                c,
            );
            if (!r.ok) return `error: 没记住（${r.reason || "未知原因"}）`;
            return r.duplicate ? `这件事你本来就记着（记忆 id ${r.id}），不用重复记。` : `记住了（记忆 id ${r.id}）。`;
        }

        if (action === "recall") {
            const kw = String(args.keyword || "").trim();
            const items = await memory.list(c, { limit: 100 });
            const hit = kw ? items.filter((m) => m.content.includes(kw)) : items;
            if (!hit.length) return kw ? `没有关于「${kw}」的记忆。` : "当前场合没有可想起的记忆。";
            const lines = hit
                .slice(0, 40)
                .map(
                    (m) =>
                        `- [${m.id}] ${m.content}（${m.subject}，${m.visibility}，重要度 ${m.importance}` +
                        `${m.aboutPerson ? `，关于 ${m.aboutPerson}` : ""}）`,
                );
            return `当前场合能想起 ${hit.length} 条：\n${lines.join("\n")}`;
        }

        if (action === "forget") {
            const r = await memory.forget({ id: args.id, keyword: args.keyword }, c);
            if (!r.ok) {
                return r.reason === "not_in_scope"
                    ? "error: 这条记忆不在当前场合可见范围内，不能从这儿删。"
                    : `error: 没忘掉（${r.reason || "没找到匹配的记忆"}）`;
            }
            return r.id ? `忘掉了记忆 ${r.id}。` : `忘掉了 ${r.removed} 条记忆。`;
        }

        if (action === "stats") {
            const s = await memory.stats();
            const by = (s.bySubject || []).slice(0, 20).map((x) => `${x.subject}=${x.count}`).join("，");
            return `记忆总量 ${s.total} 条。${by ? `分布：${by}` : ""}`;
        }

        if (action === "link") {
            const a = String(args.a || "").trim();
            const b = String(args.b || "").trim();
            if (!a || !b) return "error: link 需要 a 和 b 两个节点（如 person:1001 与 person:2002）。";
            const r = await memory.link(a, b, args.relation || "related", args.importance || 3);
            return r.ok ? `已建立关联：${a} —${args.relation || "related"}→ ${b}` : `error: 关联失败（${r.reason || "未知原因"}）`;
        }

        return `error: 未知 action「${action}」。可用：remember / recall / forget / stats / link`;
    } catch (e: any) {
        return `error: 记忆操作失败（${e?.message || e}）`;
    }
}

export { capability, dispatch };
