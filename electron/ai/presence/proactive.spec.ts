// @vitest-environment node
// 主动联系的「时机」层：聊完补话 / 久未联系。
//
// 与核心版 scripts/smoke-proactive.js 是同一批断言（33 项要点）。这份文件同时充当
// 「两端一致」的机器闸门：核心版改了措辞而桌宠版没跟上，这里会红。
//
// 钉死三件事，因为任意一件做错，主动联系就退化成定时通知：
//   1. 时机判断：刚聊完才有补话、久没聊才算想起，不是随时都能说；
//   2. 三重叠加防刷屏：日上限 + 安静时段 + 专注模式，三个时机共用一份账本；
//   3. 措辞：必须给许可不是任务，且明确「不想说就跳过」——
//      少了这句，她会为了完成任务硬找话，那比不主动更糟。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    FOLLOWUP_MAX_MS,
    FOLLOWUP_MIN_MS,
    IDLE_CHECK_MS,
    IDLE_MIN_MS,
    buildPermissionBlock,
    gate,
    markUsed,
    pickTiming,
    roll,
    usedToday,
} from "./proactive";
import { localDateKey } from "./purpose";

const now = 1795600000000;
const H = 3600000;
const MIN = 60000;
const today = "2026-11-25";

describe("时机判断：两个新时机", () => {
    it("刚聊完 40 秒 → 补话时机", () => {
        const fu = pickTiming({ now, lastUserAt: now - 40 * 1000, lastTurnEndAt: now - 40 * 1000, lastSelfAt: now - 5 * H });
        expect(fu?.timing).toBe("followup");
    });

    it("才过 10 秒 → 还不到补话窗口", () => {
        expect(pickTiming({ now, lastUserAt: now - 10 * 1000, lastTurnEndAt: now - 10 * 1000, lastSelfAt: now - 5 * H })).toBeNull();
    });

    it("过了 5 分钟 → 补话窗口已过", () => {
        expect(pickTiming({ now, lastUserAt: now - 5 * MIN, lastTurnEndAt: now - 5 * MIN, lastSelfAt: now - 5 * H })).toBeNull();
    });

    it("4 小时没说话 → 想起你", () => {
        const idle = pickTiming({ now, lastUserAt: now - 4 * H, lastSelfAt: 0 });
        expect(idle?.timing).toBe("idle");
        expect(idle?.reason).toContain("4 小时");
    });

    it("才 1 小时 → 不算久未联系", () => {
        expect(pickTiming({ now, lastUserAt: now - 1 * H, lastSelfAt: 0 })).toBeNull();
    });

    it("对方正在输入 → 一律不插嘴", () => {
        expect(pickTiming({ now, lastUserAt: now - 4 * H, lastSelfAt: 0, userActive: true })).toBeNull();
    });

    it("她半小时前刚开过口 → 不连发", () => {
        expect(pickTiming({ now, lastUserAt: now - 4 * H, lastSelfAt: now - 30 * MIN })).toBeNull();
    });
});

describe("三重闸门：三个时机共用一份账本", () => {
    const cfg = { enabled: true, focus: false, dailyMax: 3 };

    it("白天 + 没说过 + 必中 → 可以说", () => {
        const v = gate({ cfg, ledger: null, today, inQuietHours: false, focus: false, now, chance: 1 });
        expect(v.fire).toBe(true);
    });

    it("安静时段 → 不说", () => {
        const v = gate({ cfg, ledger: null, today, inQuietHours: true, focus: false, now, chance: 1 });
        expect(v.fire).toBe(false);
        expect(v.reason).toBe("安静时段");
    });

    it("专注模式 → 不打扰", () => {
        const v = gate({ cfg, ledger: null, today, inQuietHours: false, focus: true, now, chance: 1 });
        expect(v.fire).toBe(false);
        expect(v.reason).toContain("专注模式");
    });

    it("今天已说满 3 次 → 不再说", () => {
        const v = gate({ cfg, ledger: { date: today, count: 3 }, today, inQuietHours: false, focus: false, now, chance: 1 });
        expect(v.fire).toBe(false);
        expect(v.reason).toContain("3 次");
    });

    it("概率没掷中 → 不说", () => {
        const v = gate({ cfg, ledger: null, today, inQuietHours: false, focus: false, now, chance: 0, rng: () => 0.99 });
        expect(v.fire).toBe(false);
        expect(v.reason).toContain("没掷中");
    });

    it("总开关关着 → 不说", () => {
        const v = gate({ cfg: { enabled: false }, ledger: null, today, inQuietHours: false, focus: false, now, chance: 1 });
        expect(v.fire).toBe(false);
        expect(v.reason).toContain("关着");
    });
});

describe("账本：只记真的说出去的那次", () => {
    it("跨日重置", () => {
        expect(usedToday({ date: "2026-11-24", count: 3 }, today)).toBe(0);
    });

    it("当天累计", () => {
        expect(usedToday({ date: today, count: 2 }, today)).toBe(2);
    });

    it("记账 +1", () => {
        const marked = markUsed({ date: today, count: 2 }, today, now);
        expect(marked.count).toBe(3);
        expect(marked.date).toBe(today);
    });

    it("没账本时从 1 开始", () => {
        expect(markUsed(null, today, now).count).toBe(1);
    });
});

describe("授权措辞：许可，不是任务（与核心版逐字一致）", () => {
    it("补话块非空，且写明「不想说就跳过」「别连发」，不要求汇报", () => {
        const followup = buildPermissionBlock({ timing: "followup" });
        expect(followup.length).toBeGreaterThan(0);
        expect(followup).toContain("不想说就跳过");
        expect(followup).toContain("别连发");
        expect(followup).not.toContain("汇报");
    });

    it("久未联系块带小时数、说清「不是任务」、给足退出的余地", () => {
        const idleBlock = buildPermissionBlock({ timing: "idle", hours: 4 });
        expect(idleBlock).toContain("4 个多小时");
        expect(idleBlock).toContain("不是任务");
        expect(idleBlock).toContain("完全没问题");
        // 禁掉「你在忙吗」这种试探开场（写进提示里，不是靠模型自觉）
        expect(idleBlock).toContain("你在忙吗");
        // 禁掉「汇报看了什么」
        expect(idleBlock).toContain("汇报");
    });

    it("两个块都点明「是你自己想起来他了」", () => {
        expect(buildPermissionBlock({ timing: "followup" })).toContain("是你自己想起来他了");
        expect(buildPermissionBlock({ timing: "idle", hours: 4 })).toContain("是你自己想起来他了");
    });

    it("时机非法 / 无参数 → 空串（不该给授权）", () => {
        expect(buildPermissionBlock({ timing: "whatever" })).toBe("");
        expect(buildPermissionBlock()).toBe("");
    });
});

describe("常量：窗口与门槛", () => {
    it("补话窗口 30~90 秒", () => {
        expect(FOLLOWUP_MIN_MS).toBe(30 * 1000);
        expect(FOLLOWUP_MAX_MS).toBe(90 * 1000);
    });

    it("久未联系门槛 3 小时", () => {
        expect(IDLE_MIN_MS).toBe(3 * H);
    });

    it("检查周期 10 分钟", () => {
        expect(IDLE_CHECK_MS).toBe(10 * MIN);
    });
});

describe("掷骰子：0 / 1 / 非法值都不能放行", () => {
    it("0 与负数一律不发，1 一定发", () => {
        expect(roll(0, () => 0)).toBe(false);
        expect(roll(-1, () => 0)).toBe(false);
        expect(roll(1, () => 0.99)).toBe(true);
    });

    it("非法概率不发", () => {
        expect(roll(Number.NaN, () => 0)).toBe(false);
    });
});
// ── 调度层：闸门与账本必须和 presence tick 共用，不能开新口子 ──────────
// 上面测的是纯函数；下面这几条测「接上了没有」—— 纯函数全对、但调度层没接上，
// 用户感知就是「她根本不会主动找我」。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-proactive-"));
let ps: typeof import("./presenceSchedule");
let states: typeof import("./stateStore");
let store: typeof import("../db/storage");

/** 固定一个「今天 14:00」，避开安静时段（23:30~08:00），也不随本机时钟漂移。 */
const day = new Date(2026, 10, 25, 14, 0, 0, 0).getTime();
const dayKey = localDateKey(day);

beforeAll(async () => {
    store = await import("../db/storage");
    store.initDatabase(path.join(tmpDir, "pet_sessions.db"));
    ps = await import("./presenceSchedule");
    states = await import("./stateStore");
});

afterAll(() => {
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
        /* Windows 上偶尔删不掉，不影响测试结论 */
    }
});

/** 把账本清掉或设成指定值（空串 = 没有账本）。 */
function setLedger(uid: number, ledger: { date: string; count: number; at?: number } | null): void {
    store.setSetting(`proactive_ledger:${uid}`, ledger ? JSON.stringify(ledger) : "");
}

/** 造一个指定「多久之前说过话」的状态并落盘。 */
async function seedState(uid: number, input: { lastUserAt: number; lastSelfAt?: number }): Promise<void> {
    const { createInitialState } = await import("./purpose");
    states.savePresenceState({ ...createInitialState(day), ...input }, uid);
}

describe("调度层 · 账本读写（settings_kv 单键 JSON）", () => {
    it("写进去读得出来；没写过的 uid 返回 null", () => {
        setLedger(1, null);
        ps.writeLedger(1, { date: dayKey, count: 2, at: day });
        expect(ps.readLedger(1)).toMatchObject({ date: dayKey, count: 2 });
        setLedger(999, null);
        expect(ps.readLedger(999)).toBeNull();
    });
});

describe("调度层 · 与 presence tick 共用同一道闸门与账本", () => {
    it("日上限已满 → 新通道也发不出去（不然刷完B站就成了刷屏后门）", async () => {
        await seedState(1, { lastUserAt: day - 4 * H, lastSelfAt: 0 });
        let calls = 0;
        ps.setPresenceRunner(async () => {
            calls++;
            return true;
        });
        setLedger(1, { date: dayKey, count: 4 });
        const res = await ps.proactiveWithTiming(1, day, { prompt: "想说点什么", chance: 1 });
        expect(res.fired).toBe(false);
        expect(res.reason).toContain("今天已经主动说过 4 次");
        expect(calls).toBe(0);
        ps.setPresenceRunner(null);
    });

    it("概率没中 → 不发、不记账", async () => {
        await seedState(1, { lastUserAt: day - 4 * H, lastSelfAt: 0 });
        let calls = 0;
        ps.setPresenceRunner(async () => {
            calls++;
            return true;
        });
        setLedger(1, null);
        const res = await ps.proactiveWithTiming(1, day, { prompt: "想说点什么", chance: 0 });
        expect(res.fired).toBe(false);
        expect(calls).toBe(0);
        expect(ps.readLedger(1)).toBeNull();
        ps.setPresenceRunner(null);
    });

    it("没给 prompt → 直接拒绝，连闸门都不进", async () => {
        let calls = 0;
        ps.setPresenceRunner(async () => {
            calls++;
            return true;
        });
        setLedger(1, null);
        const res = await ps.proactiveWithTiming(1, day, { prompt: "   ", chance: 1 });
        expect(res.fired).toBe(false);
        expect(res.reason).toBe("no prompt");
        expect(calls).toBe(0);
        ps.setPresenceRunner(null);
    });

    it("久未联系 4 小时 → 说出来了，并把账本 +1", async () => {
        await seedState(1, { lastUserAt: day - 4 * H, lastSelfAt: 0 });
        let seen = "";
        ps.setPresenceRunner(async ({ prompt }) => {
            seen = prompt;
            return true;
        });
        setLedger(1, null);
        const res = await ps.tickProactive(1, day, { chance: 1 });
        expect(res.fired).toBe(true);
        expect(res.timing).toBe("idle");
        // 授权段真的拼进提示词了（不然模型不知道「可以说」）
        expect(seen).toContain("有点想起他");
        expect(seen).toContain("完全没问题");
        const ledger = ps.readLedger(1);
        expect(ledger?.date).toBe(dayKey);
        expect(ledger?.count).toBe(1);
        ps.setPresenceRunner(null);
    });

    it("刚聊完 40 秒 → 走补话时机，措辞是补话那块", async () => {
        const t = day + 5000;
        await seedState(1, { lastUserAt: t - 40 * 1000, lastSelfAt: t - 5 * H });
        let seen = "";
        ps.setPresenceRunner(async ({ prompt }) => {
            seen = prompt;
            return true;
        });
        setLedger(1, null);
        const res = await ps.tickProactive(1, t, { chance: 1 });
        expect(res.fired).toBe(true);
        expect(res.timing).toBe("followup");
        expect(seen).toContain("可以再补一句");
        expect(seen).toContain("别连发");
        ps.setPresenceRunner(null);
    });

    it("正在输入 → 连时机都不算，不该打扰", async () => {
        await seedState(1, { lastUserAt: day - 4 * H, lastSelfAt: 0 });
        let calls = 0;
        ps.setPresenceRunner(async () => {
            calls++;
            return true;
        });
        setLedger(1, null);
        const res = await ps.tickProactive(1, day, { chance: 1, userActive: true });
        expect(res.fired).toBe(false);
        expect(res.reason).toContain("不是主动联系的时机");
        expect(calls).toBe(0);
        ps.setPresenceRunner(null);
    });

    it("安静时段 → 到点也不说（半夜三点找人很怪）", async () => {
        const night = new Date(2026, 10, 25, 3, 0, 0, 0).getTime();
        const { createInitialState } = await import("./purpose");
        states.savePresenceState({ ...createInitialState(night), lastUserAt: night - 4 * H, lastSelfAt: 0 }, 1);
        let calls = 0;
        ps.setPresenceRunner(async () => {
            calls++;
            return true;
        });
        setLedger(1, null);
        const res = await ps.tickProactive(1, night, { chance: 1 });
        expect(res.fired).toBe(false);
        expect(res.reason).toBe("安静时段");
        expect(calls).toBe(0);
        ps.setPresenceRunner(null);
    });

    it("投递失败不记账（失败的下次还有机会，不吃额度）", async () => {
        await seedState(1, { lastUserAt: day - 4 * H, lastSelfAt: 0 });
        ps.setPresenceRunner(async () => false);
        setLedger(1, null);
        const res = await ps.tickProactive(1, day, { chance: 1 });
        expect(res.fired).toBe(false);
        expect(res.reason).toBe("runner failed");
        expect(ps.readLedger(1)).toBeNull();
        ps.setPresenceRunner(null);
    });
});
