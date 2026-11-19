// 内置能力：social —— 她对自己人际环境和所处场合的认知（与核心版对称）。
//
// 用户 2026-11-19 原话：
//   「我希望她至少管理会话的能力是完整的，能看到机器人协议端的所有能力接口，
//     看到几个好友，几个群，谁加群了，谁戳一下了，群里有几个人…………一系列。
//     我希望她能完整意识到自己的人际关系和周围的环境。」
//
// 她那时答「我没有能查看『加入了哪些群』的接口」——是真话，因为适配器确实
// 只调过 get_login_info / get_image。协议接口现在接通了，这个工具是把那些
// 事实取出来给她用的唯一入口。
//
// 隐私边界：这里返回协议端公开的群/好友/成员信息（群名、人数、昵称），
// 不含记忆内容；要读记忆请走 memory 能力，两者的可见性闸门互不替代。
import { defineCapability, type Capability } from "kirari-agent";
import * as storage from "../../db/storage";
import * as social from "../../services/social";
// 注意：不要在这里顶层 import adapter-manager。registry 用 eager glob 加载
// builtin/*，会把这个能力文件连带整条适配器依赖链（bot-adapter / onebot /
// bot-backend-client）在能力注册阶段就拉起来，既拖慢启动，也容易绕出循环。
// refresh 动作是极低频路径，用到时再 require 一次即可。

// 枚举内联：registry 用 eager glob 加载 builtin，模块顶层读外部导出的数组
// 容易拿到未初始化值（self_read 踩过这个坑）。
const ACTION_ENUM = ["overview", "groups", "friends", "members", "events", "who", "group", "refresh"];

const capability: Capability = defineCapability({
    id: "social",
    name: "social",
    kind: "tool",
    scope: "builtin",
    description:
        "你的人际环境与所处场合的事实来源（来自机器人协议端，不是猜测）。action：" +
        "overview（我在几个群、几个好友、多少人在周围——先看这个）、" +
        "groups（列出我所在的群：群名/群号/人数/我在群里会不会说话）、" +
        "friends（我的好友列表）、" +
        "members（某个群的成员，需 groupId）、" +
        "events（最近周围发生了什么：谁进群/退群/戳我/加好友/撤回，可给 groupId 过滤）、" +
        "who（查某个人：他是谁、在哪些群、我记不记得他，需 userId）、" +
        "group（某个群的完整档案，需 groupId）、" +
        "refresh（让适配器去协议端重新拉一遍，协议端有新变动时用）。" +
        "遇到「你在几个群」「群里有几个人」「谁刚加群」「谁戳你了」「这个人是谁」这类问题，" +
        "直接调用它拿事实回答，不要说没有接口或答不上来。" +
        "注意：这里只有协议端知道的环境事实（群、人、事件），" +
        "不含你记得的内容——那些用 memory 能力查。",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ACTION_ENUM, description: "要查询/执行的动作。" },
            groupId: { type: "string", description: "群号。members/group 必填；events 可选作过滤。" },
            userId: { type: "string", description: "要查的人的账号（QQ 号）。who 必填。" },
            limit: { type: "number", description: "返回条数上限，缺省按动作取合理值。" },
            adapterId: { type: "string", description: "适配器 id（有多个协议端时指定）。缺省用当前会话的。" },
        },
        required: ["action"],
    },
    tags: ["builtin", "social", "read"],
    timeoutMs: 15000,
    truncateChars: 6000,
});

/** 从会话 id 里猜适配器（bot-<adapterId>-... 形状）。 */
function adapterFromSession(sessionId?: string): string | null {
    const m = String(sessionId || "").match(/^bot-([^-]+)-/);
    return m ? m[1] : null;
}

function humanCount(n: number | null | undefined): string {
    return typeof n === "number" ? `${n} 人` : "人数未知";
}

async function dispatch(args: any = {}, ctx: any = {}): Promise<string> {
    const action = String(args?.action || "").toLowerCase();
    const adapterId = args?.adapterId ? String(args.adapterId) : adapterFromSession(ctx?.sessionId);
    // limit 缺省 = 不截断（0）。注意别写成 Math.max(1, Number(...)||0)，
    // 那会让"没传 limit"变成 1，查询只剩一条。
    const limit = args?.limit ? Math.min(200, Math.max(1, Number(args.limit) || 0)) : 0;

    try {
        if (action === "overview") {
            const o = await storage.socialOverview(adapterId || null);
            if (!o.groups && !o.contacts && !o.events) {
                return (
                    "协议端还没同步过社交环境（可能没连上，或这个适配器不支持查群/好友）。" +
                    "如果刚连上，等十几秒再 refresh 一次。"
                );
            }
            return [
                `你所在的群：${o.groups} 个。`,
                `你的好友：${o.contacts} 个。`,
                `这些群里一共有 ${o.members} 个不同的人。`,
                `真正跟你说过话的有 ${o.people} 个人。`,
                `记录到的环境事件：${o.events} 条。`,
            ].join("\n");
        }

        if (action === "groups") {
            let groups = await storage.listSocialGroups(adapterId || null);
            if (!groups.length) return "没有查到你在任何群里（可能还没同步，或协议端这个账号还没进群）。";
            if (limit) groups = groups.slice(0, limit);
            const lines = groups.map((g) => {
                const reply = g.replyEnabled ? "群里会回话" : "群里不回话";
                const notes = g.notes ? `，备注：${g.notes}` : "";
                return `- ${g.groupName || `群 ${g.groupId}`}（群号 ${g.groupId}，${humanCount(g.memberCount)}，${reply}${notes}）`;
            });
            return `你在 ${groups.length} 个群里：\n${lines.join("\n")}`;
        }

        if (action === "friends") {
            let contacts = await storage.listSocialContacts(adapterId || null);
            if (!contacts.length) return "好友列表是空的（可能还没同步，或协议端不支持查好友）。";
            if (limit) contacts = contacts.slice(0, limit);
            const lines = contacts.map((f) => {
                const nick = f.nickname || f.remark || "（无昵称）";
                return `- ${nick}（${f.userId}）${f.remark && f.nickname ? `，备注：${f.remark}` : ""}`;
            });
            return `你的好友（${contacts.length} 个）：\n${lines.join("\n")}`;
        }

        if (action === "members") {
            const gid = String(args?.groupId || "").trim();
            if (!gid) return "error: members 需要 groupId（群号）。先用 groups 查到群号。";
            const group = adapterId ? await storage.getSocialGroup(adapterId, gid) : null;
            const members = adapterId ? await storage.listGroupMembers(adapterId, gid, limit || 200) : [];
            if (!members.length) {
                return group
                    ? `群 ${group.groupName || gid} 的成员表还是空的（协议端没返回，或人数太多跳过了同步）。`
                    : `没查到群 ${gid}（先确认群号，或 refresh 一次）。`;
            }
            const shown = members.slice(0, limit || 60);
            const lines = shown.map((m) => {
                const name = m.card || m.nickname || "（无昵称）";
                const role = m.role === "owner" ? "（群主）" : m.role === "admin" ? "（管理员）" : "";
                return `- ${name}${role} ${m.userId}`;
            });
            const head = group
                ? `群 ${group.groupName || gid}（群号 ${gid}）里 ${humanCount(group.memberCount ?? members.length)}：`
                : `群 ${gid} 里 ${members.length} 人：`;
            const more = members.length > shown.length ? `\n…还有 ${members.length - shown.length} 人` : "";
            return `${head}\n${lines.join("\n")}${more}`;
        }

        if (action === "events") {
            const gid = args?.groupId ? String(args.groupId) : null;
            const events = await storage.listSocialEvents({
                adapterId: adapterId || null,
                groupId: gid,
                limit: limit || 20,
            });
            if (!events.length) return gid ? `群 ${gid} 最近没什么动静。` : "最近周围没什么值得说的事。";
            const lines = events.map((e) => `- ${social.friendlyEventTime(e.createdAt)}：${social.describeEvent(e)}`);
            return `最近周围发生的事（${events.length} 条，新的在前）：\n${lines.join("\n")}`;
        }

        if (action === "who") {
            const uid = String(args?.userId || "").trim();
            if (!uid) return "error: who 需要 userId（对方的账号/QQ 号）。";
            const p = await social.personProfile(adapterId || null, uid);
            if (!p) return `没查到 ${uid} 这个人的信息。`;
            const lines = [`账号：${uid}`];
            if (p.contact) {
                lines.push(
                    `好友里的人：${p.contact.nickname || "（无昵称）"}` +
                        `${p.contact.remark ? `，备注 ${p.contact.remark}` : ""}`,
                );
            } else {
                lines.push("不是你的好友（或者只在群里见过）。");
            }
            if (p.groups && p.groups.length) {
                lines.push(`和你在同一个群：${p.groups.map((g) => g.groupName || `群 ${g.groupId}`).join("、")}`);
            }
            if (p.person) {
                const roleText =
                    p.person.role === "owner"
                        ? "拥有者（最高管理权）"
                        : p.person.role === "admin"
                          ? "可信任的人"
                          : "普通对话者";
                lines.push(`你对他的档案：${p.person.displayName || p.person.personKey}，${roleText}`);
                if (p.person.alias) lines.push(`你平时叫他：${p.person.alias}`);
                if (p.person.notes) lines.push(`你对他的备注：${p.person.notes}`);
                lines.push(
                    `第一次见到：${p.person.firstSeenAt || "未知"}；最近一次：${p.person.lastSeenAt || "未知"}`,
                );
            } else {
                lines.push("他还没直接跟你说过话，所以没有单独档案。");
            }
            return lines.join("\n");
        }

        if (action === "group") {
            const gid = String(args?.groupId || "").trim();
            if (!gid) return "error: group 需要 groupId（群号）。";
            if (!adapterId) return "error: 不知道用哪个适配器查（缺 adapterId）。";
            const p = await social.groupProfile(adapterId, gid);
            if (!p) return `没查到群 ${gid}（先 groups 确认群号，或 refresh 一次）。`;
            const lines = [
                `群名：${p.groupName || "（未知）"}`,
                `群号：${p.groupId}`,
                `人数：${humanCount(p.memberCount)}${p.maxMemberCount ? ` / 上限 ${p.maxMemberCount}` : ""}`,
                `你在群里${p.replyEnabled ? "会回话" : "不会主动回话"}`,
            ];
            if (p.notes) lines.push(`你对这个群的印象：${p.notes}`);
            const owners = p.members.filter((m) => m.role === "owner");
            const admins = p.members.filter((m) => m.role === "admin");
            if (owners.length) lines.push(`群主：${owners.map((m) => m.card || m.nickname || m.userId).join("、")}`);
            if (admins.length) lines.push(`管理员：${admins.map((m) => m.card || m.nickname || m.userId).join("、")}`);

            // 群里有几个她认识的人（说过话的）
            try {
                const people = await storage.listPeople(200);
                const memberIds = new Set(p.members.map((m) => m.userId));
                const known = people.filter((x) => memberIds.has(x.personKey));
                if (known.length) {
                    lines.push(`群里已经跟你说过话的：${known.map((x) => x.displayName || x.personKey).join("、")}`);
                }
            } catch {
                /* people 表读失败不影响 */
            }
            lines.push(`最近同步：${p.lastSyncedAt || "未知"}`);
            return lines.join("\n");
        }

        if (action === "refresh") {
            // 主动去协议端重新拉一遍。适配器实例由 adapter-manager 持有。
            // 惰性 require：见文件头注释（避免启动期把适配器链路拖进能力注册）。
            let adapterManager: any = null;
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                adapterManager = require("../../../adapter/adapter-manager");
            } catch (e) {
                return `error: 拿不到适配器管理器（${e instanceof Error ? e.message : String(e)}）`;
            }
            const inst = adapterManager?.getAdapter ? adapterManager.getAdapter(adapterId || undefined) : null;
            if (!inst) return `error: 现在没有在运行的适配器${adapterId ? `（${adapterId}）` : ""}，没法刷新。`;
            const r = await social.syncAdapter(inst as any, (inst as any).config || {});
            if (!r.ok) {
                return `error: 刷新失败（${r.reason === "unsupported" ? "这个适配器不支持查群/好友" : r.reason}）。`;
            }
            return `刷新完了：${r.groups} 个群、${r.friends} 个好友、${r.members} 条群成员记录。`;
        }

        return `error: 未知 action「${action}」。可用：${ACTION_ENUM.join(" / ")}`;
    } catch (e) {
        return `error: 查人际环境失败（${e instanceof Error ? e.message : String(e)}）`;
    }
}

export { capability, dispatch };
