// @vitest-environment node
//
// 时间基准上下文：确保「当前时间」带明确时区标签，不再出现
// 「把 UTC 05:54 当成主人本地凌晨、误判还不睡」的错位。

import { describe, expect, it } from "vitest";
import { buildTimeContext, defaultTimezone } from "./timeContext";

describe("时间基准上下文", () => {
    it("默认时区绝不是裸 UTC", () => {
        // 进程可能跑在 UTC 容器里；此时也要退到东八区，而不是 UTC。
        expect(defaultTimezone()).not.toBe("UTC");
    });

    it("UTC 时刻按东八区显示，并带 UTC 偏移标签", () => {
        const fixed = new Date("2026-11-19T05:54:00Z"); // UTC 05:54 = 北京 13:54
        const ctx = buildTimeContext({ timezone: "Asia/Shanghai", now: fixed, locationLabel: "上海" });

        expect(ctx).toContain("13:54");
        expect(ctx).not.toContain("05:54");
        expect(ctx).toContain("Asia/Shanghai");
        expect(ctx).toContain("UTC+08:00");
        expect(ctx).toContain("上海");
        expect(ctx).toContain("不要把它的裸读数当成主人这里的当前时间");
    });

    it("空时区也用默认时区兜底，绝不输出 UTC 裸时钟", () => {
        const fixed = new Date("2026-11-19T05:54:00Z");
        const ctx = buildTimeContext({ now: fixed });
        expect(ctx).not.toContain("时区 UTC /");
        expect(ctx).not.toContain("05:54");
    });
});
