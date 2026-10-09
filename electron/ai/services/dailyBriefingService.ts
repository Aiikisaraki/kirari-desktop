// electron/ai/services/dailyBriefingService.ts
// 每日简报（"主动感知"当日世界）：惰性采集天气与新闻，
// 用 LLM 压缩为 3-5 条要点存入 daily_memory，对话时注入 system prompt 让回答更有底。
//
// 由 kirari-core/src/services/dailyBriefingService.js 迁入。
// 改动：db 调用换成精简后的本地存储；用户标识统一走 userid（本机固定 1）。

import * as db from "../db/storage";
import { runTool } from "../tools";
import type { AiContext } from "../aiContext";

/** 本地日期 YYYY-MM-DD（避免 toISOString 的 UTC 偏移导致跨日错位） */
export function todayStr(): string {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
}

/** 进程内缓存：同一天同一用户只生成一次（进程重启后由 DB 兜底） */
const cache = new Map<string, string>();

export async function getTodayBrief(aiContext: AiContext): Promise<string | null> {
    const date = todayStr();
    const key = `${aiContext.userid}:${date}`;
    if (cache.has(key)) return cache.get(key)!;
    const row = await db.getDailyBrief(aiContext.userid, date);
    if (row && row.briefText) {
        cache.set(key, row.briefText);
        return row.briefText;
    }
    return null;
}

/** 采集 + 压缩 + 落库。返回简报文本或 null。 */
export async function generateDailyBrief(aiContext: AiContext): Promise<string | null> {
    const date = todayStr();
    const userid = aiContext.userid;
    const ctx = {
        searchProvider: aiContext.searchProvider,
        searchKey: aiContext.searchKey,
        searchEndpoint: aiContext.searchEndpoint,
    };

    const parts: string[] = [];

    // 1. 天气（基于已存位置）
    try {
        const loc = await db.getUserLocation(userid);
        if (loc && (loc.latitude != null || (loc.location && loc.location.trim()))) {
            const w = await runTool(
                "get_weather",
                {
                    location: loc.location || "",
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    displayName: loc.location || "",
                },
                ctx,
            );
            if (w && !/缺少|失败|找不到/.test(w)) parts.push(`[天气] ${w}`);
        }
    } catch (e) {
        console.warn("[dailyBrief] 天气获取失败：", (e as Error)?.message || e);
    }

    // 2. 新闻热点
    try {
        const news = await runTool("web_search", { query: "今日热点新闻 科技 游戏 动漫 综合", topic: "news" }, ctx);
        if (news) parts.push(`[新闻] ${news}`);
    } catch (e) {
        console.warn("[dailyBrief] 新闻搜索失败：", (e as Error)?.message || e);
    }

    if (parts.length === 0) {
        console.warn("[dailyBrief] 无任何原始数据，跳过生成");
        return null;
    }

    const raw = parts.join("\n\n");
    const prompt =
        "你是桌宠 Kirari 的「每日简报」生成器。下面是从网上获取的今日原始信息（天气 + 新闻热点）。\n" +
        "请压缩整理成 3-5 条简洁要点，每条 1-2 句，用中文。只保留最有价值、主人可能关心的信息。\n" +
        "不要编造，不要添加原文没有的内容。条目前用数字编号。直接输出要点列表，不要输出 JSON 或代码块。\n\n" +
        `原始信息：\n${raw}`;

    let brief = "";
    try {
        const completion = await aiContext.openai.chat.completions.create({
            model: aiContext.model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 600,
            temperature: 0.3,
        });
        brief = (completion.choices?.[0]?.message?.content || "").trim();
    } catch (e) {
        console.warn("[dailyBrief] LLM 压缩失败，回退原始摘要：", (e as Error)?.message || e);
        brief = raw.replace(/搜索结果：/g, "").replace(/\[天气\]/g, "天气：").slice(0, 800);
    }

    if (!brief) return null;
    await db.upsertDailyBrief(userid, date, brief, []);
    cache.set(`${userid}:${date}`, brief);
    console.log(`[dailyBrief] 生成完成 user=${userid} date=${date} len=${brief.length}`);
    return brief;
}

/** 确保当天简报已就绪：命中缓存/DB 直接返回，否则生成。任何异常静默降级。 */
export async function ensureDailyBrief(aiContext: AiContext): Promise<string | null> {
    if (!aiContext || aiContext.closed || !aiContext.openai) return null;
    try {
        const existing = await getTodayBrief(aiContext);
        if (existing) return existing;
        return await generateDailyBrief(aiContext);
    } catch (e) {
        console.warn("[dailyBrief] ensure 失败：", (e as Error)?.message || e);
        return null;
    }
}
