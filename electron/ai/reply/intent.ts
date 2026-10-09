// electron/ai/reply/intent.ts
// 意图预检 + 工具前置：在 LLM 调用前根据关键词预判是否需要联网工具，并处理位置设置/追问接续。
//
// 兼容不支持 function calling 的模型/端点：
//   时间/天气（direct=true）→ 先调工具 → 结果交给 LLM 润色（见 conversationService 的 direct 路径）
//   搜索（direct=false）    → 先调工具 → 结果注入 system prompt，由 LLM 总结
//
// 由 kirari-core/src/services/reply/intent.js 迁入。
// 改动：sessionManager 去掉存储模式分支（桌宠固定走本地库），直接调 db 层；
//       前端工具执行改为进程内注入（见 tools/bridge）。

import { mergeTools, runTool, geocode } from "../tools";
import * as locationSvc from "../services/locationService";
import { getRecentMessages } from "../db/storage";
import { GREETING_MESSAGE } from "./promptBuilder";

/**
 * 联网工具：web_search 默认可用（内置 uapis 免 key 源），始终暴露；
 * 同时合并前端托管工具（MCP / skill 提供的工具），这些由主进程实际执行。
 */
export function buildTools() {
    return mergeTools();
}

// ── 纠正/质疑意图 ──
// 用户指出"你记错了 / 她没说过 / 根本没有"等，是对桌宠先前陈述的否定。
// 命中后进入"有限搜索"模式：web_search 仍可用（让宠物去搜出真正的正确答案），
// 但用 webSearchCap 兜底（纠正模式限 2 次），达上限即强制纯文本收尾。
const CORRECTION_PATTERNS = [
    /根本没有|根本没|没说过|没说过的|你记错|你说错|哪有|压根没有|不是吧|真的有吗|真的说过吗|胡说|瞎说|编的吧|编出来|杜撰|自己编|你编的|撒谎|造的吧|乱讲|扯淡|你搞错|记反了|搞反了|张冠李戴|胡扯|无中生有/,
];

export function detectCorrectionIntent(text: string): boolean {
    const t = String(text || "").trim();
    if (!t) return false;
    return CORRECTION_PATTERNS.some((re) => re.test(t));
}

// ── 意图预检模式 ──
export const INTENT_PATTERNS: { name: string; pattern: RegExp; direct: boolean }[] = [
    {
        name: "get_current_time",
        pattern: /几点|什么时间|现在几点|当前时间|日期|今天几号|星期几|现在什么时候|查时间|^时间$|^现在呢$|^几点了$/,
        direct: true,
    },
    {
        name: "get_weather",
        pattern: /天气|气温|温度|下雨|下雪|晴(?!朗)|阴天|湿度|风速|外面.*怎|冷不|热不|穿什么|带伞|查天气/,
        direct: true,
    },
    {
        name: "web_search",
        pattern: /搜[索一下]*|查[一一下]|新闻|最新.*消息|最近.*发生|热搜/,
        direct: false,
    },
];

/**
 * 从天气类语句里提取用户"本轮"明确提到的城市（仅本次查询使用，不覆盖已存默认）。
 * 优先匹配带行政区划后缀的地名，其次「X天气 / X的天气」（X 排除时间词）。
 */
export function extractExplicitCity(text: string): string {
    let m = text.match(/([\u4e00-\u9fa5]{2,8}(?:市|省|县|区|旗|市辖区))/);
    if (m) return m[1];
    m = text.match(/([\u4e00-\u9fa5]{2,4})(?:的)?天气/);
    if (m) {
        const cand = m[1];
        if (!/^(今天|明天|昨天|现在|此刻|当前|本地|这里|这儿|那儿|那里|这|那)$/.test(cand)) return cand;
    }
    return "";
}

/** 检测文本命中哪些 direct 意图（时间/天气），返回意图名数组 */
export function detectDirectIntents(text: string): string[] {
    const t = String(text || "");
    return INTENT_PATTERNS.filter((intent) => intent.direct && intent.pattern.test(t)).map((i) => i.name);
}

/**
 * 上下文接续检测：桌宠上轮因为缺位置而追问，本轮用户补充了地点。
 * 取「最近一条 assistant 消息」之前的「最近一条 user 消息」作为待接续的原始请求。
 * 无则返回 null。
 */
async function inferPendingLocationIntent(sessionId: string): Promise<string | null> {
    if (!sessionId) return null;
    const msgs = await getRecentMessages(sessionId, 8);
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (String(msgs[i].role) !== "assistant") continue;
        for (let j = i - 1; j >= 0; j--) {
            if (String(msgs[j].role) === "user") {
                const txt = String(msgs[j].content || "").trim();
                if (txt && txt !== GREETING_MESSAGE) return txt;
            }
        }
        return null;
    }
    return null;
}

async function runDirectToolsByIntents(
    intents: string[],
    userid: number,
    clientIp: string,
    searchCtx: SearchCtx,
    scope: string | null,
): Promise<string | null> {
    const loc = await locationSvc.resolveForQuery(userid, clientIp, "", undefined, scope || undefined);
    if (loc.needAsk || !loc.location) return null;
    const results: string[] = [];
    for (const intentName of intents) {
        try {
            let args: Record<string, unknown> = {};
            if (intentName === "get_weather") {
                if (loc.source === "fallback" || loc.latitude == null || loc.longitude == null) {
                    results.push("我还不知道你具体在哪个城市，告诉我城市名才能帮你查天气哦~");
                    continue;
                }
                args = {
                    location: loc.displayName || loc.location || "",
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    displayName: loc.displayName || loc.location,
                };
            } else if (intentName === "get_current_time") {
                args = { timezone: loc.timezone || null };
            }
            const result = await runTool(intentName, args, {
                searchKey: searchCtx.searchKey,
                searchEndpoint: searchCtx.searchEndpoint,
            });
            results.push(result);
        } catch (e) {
            results.push(`${intentName} error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return results.length ? results.join("；") : null;
}

async function maybeContinuePendingLocationQuery(
    sessionId: string,
    userid: number,
    clientIp: string,
    searchCtx: SearchCtx,
    saved: locationSvc.SavedLocation,
    scope: string | null,
): Promise<PreflightResult | null> {
    if (!sessionId || !saved) return null;
    const pendingText = await inferPendingLocationIntent(sessionId);
    if (!pendingText) return null;
    const intents = detectDirectIntents(pendingText);
    if (!intents.length) return null;
    const combined = await runDirectToolsByIntents(intents, userid, clientIp, searchCtx, scope);
    if (!combined) return null;
    return {
        direct: { speech: combined, emotion: "happy", raw: combined, userText: pendingText },
        injected: null,
        needLocation: false,
        setLocation: { location: saved.location, ambiguous: saved.ambiguous },
    };
}

export type SearchCtx = {
    userid?: number;
    searchKey?: string;
    searchEndpoint?: string;
};

export type PreflightResult = {
    direct: { speech: string; emotion: string; raw?: string; userText?: string } | null;
    injected: string[] | null;
    needLocation: boolean;
    setLocation: { location: string; ambiguous?: boolean } | null;
};

export async function preflightTools(
    content: string,
    searchCtx: SearchCtx = {},
    clientIp = "",
    sessionId = "",
    locationScope: string | null = null,
): Promise<PreflightResult> {
    const scope = locationScope || null;
    const text = String(content || "").trim();
    const userid = searchCtx?.userid;

    // —— A. 纯「设置/更新位置」语句（无查询意图）：持久化后直接确认 ——
    const setLoc = locationSvc.extractSetLocation(text);
    if (setLoc) {
        const valid = await locationSvc.validateLocation(setLoc);
        if (!valid) {
            // 校验失败：当作普通对话处理，避免把「我在吃饭」之类误当位置保存
        } else {
            const saved = await locationSvc.saveUserLocation(userid as number, setLoc, scope || undefined);
            if (saved) {
                const continued = await maybeContinuePendingLocationQuery(
                    sessionId,
                    userid as number,
                    clientIp,
                    searchCtx,
                    saved,
                    scope,
                );
                if (continued) return continued;
                return {
                    direct: null,
                    injected: null,
                    needLocation: false,
                    setLocation: { location: saved.location, ambiguous: saved.ambiguous },
                };
            }
        }
    }

    // —— A2. 冷启动裸地名：用户没加"我在"前缀、也没有查询意图，直接丢了个短地名 ——
    //   注意：若当前存在「已追问但未获得位置」的 pending 状态，让给 D 分支处理（支持上下文接续）
    if (userid != null && !setLoc && detectDirectIntents(text).length === 0) {
        const rec = await locationSvc.getUserLocation(userid, scope || undefined);
        if (rec && rec.askedAt && !rec.location) {
            // pending 存在，交给 D 分支
        } else {
            const bareLooksLike = locationSvc.looksLikeLocation(text);
            const bareDecline = locationSvc.isDecline(text);
            if (bareLooksLike && !bareDecline) {
                const bareOk = await locationSvc.validateLocation(text);
                if (bareOk) {
                    const saved = await locationSvc.saveUserLocation(userid, text, scope || undefined);
                    if (saved) {
                        return {
                            direct: null,
                            injected: null,
                            needLocation: false,
                            setLocation: { location: saved.location, ambiguous: saved.ambiguous },
                        };
                    }
                }
            }
        }
    }

    // —— B. 解析本轮要用的位置 ——
    let queryLoc = "";
    let setLocInfo: { location: string; ambiguous?: boolean } | null = null;
    const merged = locationSvc.extractMergedLocation(text);
    if (merged) {
        const mergedValid = await locationSvc.validateLocation(merged);
        if (mergedValid) {
            if (userid != null) {
                const saved = await locationSvc.saveUserLocation(userid, merged);
                queryLoc = ""; // 已持久化为规范记录（含坐标），交给 resolveForQuery 读存储
                setLocInfo = saved ? { location: saved.location, ambiguous: saved.ambiguous } : null;
            } else {
                queryLoc = merged;
            }
        }
    } else {
        const oneOff = extractExplicitCity(text) || locationSvc.extractLeadCity(text);
        if (oneOff) {
            const oneOffValid = await locationSvc.validateLocation(oneOff);
            if (oneOffValid) {
                queryLoc = oneOff;
                // 已追问过位置、用户用「X+查询」回应 → 一并设为默认位置，避免下次再问
                if (userid != null) {
                    const rec = await locationSvc.getUserLocation(userid, scope || undefined);
                    if (rec && rec.askedAt && !rec.location) {
                        const saved = await locationSvc.saveUserLocation(userid, oneOff, scope || undefined);
                        if (saved) setLocInfo = { location: saved.location, ambiguous: saved.ambiguous };
                    }
                }
            }
        }
    }

    // —— C. 意图匹配（时间/天气/搜索）——
    const matched = INTENT_PATTERNS.filter((intent) => intent.pattern.test(text));

    // —— D. 对「位置追问」的回复：此前已问过、用户本轮简短地名回应 ——
    if (userid != null && !queryLoc && matched.length === 0) {
        const rec = await locationSvc.getUserLocation(userid, scope || undefined);
        if (rec && rec.askedAt && !rec.location) {
            const looksLike = locationSvc.looksLikeLocation(text);
            const decline = locationSvc.isDecline(text);
            if (looksLike && !decline) {
                const ok = await locationSvc.validateLocation(text);
                if (ok) {
                    const saved = await locationSvc.saveUserLocation(userid, text, scope || undefined);
                    if (saved) {
                        const continued = await maybeContinuePendingLocationQuery(
                            sessionId,
                            userid,
                            clientIp,
                            searchCtx,
                            saved,
                            scope,
                        );
                        if (continued) return continued;
                        return {
                            direct: null,
                            injected: null,
                            needLocation: false,
                            setLocation: { location: saved.location, ambiguous: saved.ambiguous },
                        };
                    }
                }
            }
            // 拒绝提供或非法地名：不持久化，落到底下走 IP 兜底
        }
    }

    if (matched.length === 0) {
        return { direct: null, injected: null, needLocation: false, setLocation: setLocInfo };
    }

    const allDirect = matched.every((m) => m.direct);
    const results: string[] = [];
    let needLocation = false;

    for (const intent of matched) {
        try {
            let args: Record<string, unknown> = {};
            if (intent.name === "get_weather" || intent.name === "get_current_time") {
                const loc = await locationSvc.resolveForQuery(
                    userid as number,
                    clientIp,
                    queryLoc,
                    undefined,
                    scope || undefined,
                );
                if (loc.needAsk) {
                    needLocation = true;
                    break;
                }
                if (!loc.location && loc.latitude == null && loc.longitude == null) {
                    results.push("缺少地点参数（location）");
                    continue;
                }
                if (intent.name === "get_weather") {
                    // IP 兜底失败时只有时区没有坐标，无法查天气，友好提示补充城市
                    if (loc.source === "fallback" || loc.latitude == null || loc.longitude == null) {
                        results.push("我还不知道你具体在哪个城市，告诉我城市名才能帮你查天气哦~");
                        continue;
                    }
                    args.location = loc.displayName || loc.location || "";
                    args.latitude = loc.latitude;
                    args.longitude = loc.longitude;
                    args.displayName = loc.displayName || loc.location || "";
                } else {
                    args.timezone = loc.timezone;
                    // 兜底补全时区（存储记录缺失时区且地理编码可用时）
                    if (!args.timezone && loc.location) {
                        try {
                            const g = await geocode(loc.location);
                            if (g && g.timezone) args.timezone = g.timezone;
                        } catch {
                            /* ignore */
                        }
                    }
                }
            }
            const result = await runTool(intent.name, args, {
                searchKey: searchCtx.searchKey,
                searchEndpoint: searchCtx.searchEndpoint,
            });
            results.push(result);
        } catch (e) {
            results.push(`${intent.name} error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    if (needLocation) {
        return { direct: null, injected: null, needLocation: true, setLocation: setLocInfo };
    }

    if (allDirect) {
        // direct 工具（时间/天气）：原始数据交给 LLM 润色；raw 保存原文供润色失败后回退
        const combined = results.join("；");
        return {
            direct: { speech: combined, emotion: "happy", raw: combined },
            injected: null,
            needLocation: false,
            setLocation: setLocInfo,
        };
    }

    // 非 direct 工具（如搜索）：收集结果用于注入 system prompt
    return { direct: null, injected: results.map((r) => `[tool] ${r}`), needLocation: false, setLocation: setLocInfo };
}
