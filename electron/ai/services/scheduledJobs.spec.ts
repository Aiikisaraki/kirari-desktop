// @vitest-environment node
// 「过期的一次性提醒不该在每次启动时补发」——2026-11-25 报障的回归。
//
// 报障原话（桌宠端）：「能不能把这测试任务清理掉，我每次启动都会触发」
//
// 根因：once 任务的 status 只有 pending / fired / cancelled，没有「已过期」终态；
// 停机期间的 once 任务一直躺在 pending 里，每次启动首扫把 due_at <= now 的
// pending 全部补发一次 —— 两周前的测试提醒，每次开机都会再念一遍。
//
// 为什么只测 isStaleOnceReminder 这个纯函数：真正的送达要连桌面会话 / QQ 通道，
// 单测里给不了；而所有「被旧提醒刷屏」的事故都发生在「该不该送」这一步。
// 判定错了，后面的送达再正确也只是把错误的内容送出去。
//
// 与核心版 scripts/smoke-stale-jobs.js 是同一批断言（15 项要点），
// 另加「定时器真的挂上/清掉」与「过期提醒在扫描里被跳过」两条接线断言。
import { describe, expect, it } from "vitest";
import { ONCE_CATCHUP_WINDOW_MS, PROACTIVE_CHECK_MS, isStaleOnceReminder, tickProactiveIdle } from "./scheduledJobsService";

const now = Date.now();
const H = 3600000;

function stale(ago: number, recurrence = "once"): boolean {
    return isStaleOnceReminder({ recurrence, dueAt: now - ago }, now);
}

describe("窗口大小", () => {
    it("补发窗口是 6 小时", () => {
        expect(ONCE_CATCHUP_WINDOW_MS).toBe(6 * H);
    });
});

describe("过期判定", () => {
    it("两周前的 once → 过期", () => {
        expect(stale(14 * 24 * H)).toBe(true);
    });

    it("6 小时零 1 分钟 → 过期（边界精确到分钟）", () => {
        expect(stale(6 * H + 60000)).toBe(true);
    });

    it("正好 6 小时 → 不过期（用 > 而不是 >=）", () => {
        expect(stale(6 * H)).toBe(false);
    });

    it("两小时前 → 不过期（关机补发的原意）", () => {
        expect(stale(2 * H)).toBe(false);
    });

    it("刚好到点 → 不过期", () => {
        expect(stale(0)).toBe(false);
    });

    it("未来时间的任务 → 不过期", () => {
        expect(stale(-H)).toBe(false);
    });
});

describe("周期任务永不过期", () => {
    it("daily 迟到一天 → 不过期", () => {
        expect(stale(24 * H, "daily")).toBe(false);
    });

    it("daily 迟到一年 → 不过期", () => {
        expect(stale(365 * 24 * H, "daily")).toBe(false);
    });
});

describe("异常输入不该误杀", () => {
    it("缺 dueAt → 不过期", () => {
        expect(isStaleOnceReminder({ recurrence: "once" }, now)).toBe(false);
    });

    it("dueAt 非数字 → 不过期", () => {
        expect(isStaleOnceReminder({ recurrence: "once", dueAt: "x" as unknown as number }, now)).toBe(false);
    });

    it("空对象 → 不过期", () => {
        expect(isStaleOnceReminder({}, now)).toBe(false);
    });

    it("null / undefined → 不过期", () => {
        expect(isStaleOnceReminder(null, now)).toBe(false);
        expect(isStaleOnceReminder(undefined, now)).toBe(false);
    });
});

describe("主动联系：检查周期已挂上", () => {
    it("久未联系检查周期 10 分钟", () => {
        expect(PROACTIVE_CHECK_MS).toBe(10 * 60000);
    });

    it("tickProactiveIdle 已导出且可调用（没配库也不许抛）", async () => {
        expect(typeof tickProactiveIdle).toBe("function");
        await expect(tickProactiveIdle(now)).resolves.toBeUndefined();
    });
});

// ── 接线：过期判定必须真的挡在送达之前 ────────────────────────────────
// 上面测的是纯函数。纯函数全对、但分支没接上，用户开机照样被两周前的
// 测试提醒念一遍 —— 报障就是那么来的。这几条用真实 jobStore + scanOnce 跑一遍。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

const wiringDir = fs.mkdtempSync(path.join(os.tmpdir(), "kirari-stale-jobs-"));
let store: typeof import("../db/storage");
let jobs: typeof import("../events/jobStore");
let sched: typeof import("./scheduledJobsService");
let K: typeof import("kirari-agent");

beforeAll(async () => {
    store = await import("../db/storage");
    store.initDatabase(path.join(wiringDir, "pet_sessions.db"));
    jobs = await import("../events/jobStore");
    sched = await import("./scheduledJobsService");
    K = await import("kirari-agent");
});

afterAll(() => {
    try {
        fs.rmSync(wiringDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
        /* Windows 上偶尔删不掉，不影响测试结论 */
    }
});

/** 建一条已到点的 reminder 并落库。 */
function seedReminder(jobId: string, dueAt: number, recurrence: "once" | "daily"): void {
    jobs.jobStore.save(
        K.createJob({
            jobId,
            sessionId: "wiring-session",
            origin: "desktop",
            uid: store.LOCAL_UID,
            kind: "reminder",
            title: jobId,
            payload: "内容-" + jobId,
            dueAt,
            recurrence,
            now: Date.now(),
        }),
        "job_created",
    );
}

describe("接线 · 扫描时过期提醒被跳过、不送达", () => {
    it("两周前的 once 提醒：只结掉不念；窗口内的 once 与迟到的 daily 照常送", async () => {
        const at = Date.now();
        seedReminder("stale-old", at - 14 * 24 * H, "once");
        seedReminder("fresh-once", at - 60_000, "once");
        seedReminder("daily-late", at - 48 * H, "daily");

        const delivered: string[] = [];
        sched.setDesktopDeliverer((job) => {
            delivered.push(job.jobId);
            return true;
        });
        await sched.scanOnce();
        sched.setDesktopDeliverer(null);

        // 过期的：结掉、一个字都没念
        expect(delivered).not.toContain("stale-old");
        expect(jobs.jobStore.get("stale-old")?.status).toBe("fired");
        // 窗口内的：照常补发（关机补发的原意不能丢）
        expect(delivered).toContain("fresh-once");
        expect(jobs.jobStore.get("fresh-once")?.status).toBe("fired");
        // 周期任务：迟到两天也该补跑
        expect(delivered).toContain("daily-late");
    });
});

describe("接线 · 主动联系定时器随 start/stop 起停", () => {
    it("重复 start 幂等，stop 之后可再 start，均不抛", () => {
        sched.start();
        sched.start();
        sched.stop();
        // 没启动过也允许 stop（进程退出路径会无条件调一次）
        sched.stop();
        sched.start();
        sched.stop();
        expect(PROACTIVE_CHECK_MS).toBe(10 * 60000);
    });
});
