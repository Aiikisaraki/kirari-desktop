// electron/ai/services/locationService.ts
// 用户位置服务：天气/时间等强地区相关查询依赖位置信息。
//
// 设计原则（隐私优先、少侵入）：
//   1. 不主动收集（不调用浏览器定位、不在启动时索取）。
//   2. 位置来自「用户在对话中自己提供」，持久化到本机数据库。
//   3. 若用户从未提供过位置：首次遇到地区相关问题时问一次；若仍不提供，
//      下次直接按公网 IP 归属地查询。
//   4. 用户之后在对话中说「更新位置/我在X」等，则更新持久化记录。
//
// 由 kirari-core/src/services/locationService.js 迁入。
// 改动：db 调用换成精简后的本地存储（位置统一落在 bot_locations，按 scope 隔离）。

import * as db from "../db/storage";
import { geocode, geocodeCandidates } from "../tools";
import type { GeoCandidate } from "../tools";

/** 用地理编码结果拼出可读的行政区划标签（如「北京市, 中国」） */
function buildLabel(c: GeoCandidate | null): string | null {
    if (!c) return null;
    const parts: string[] = [];
    if (c.name) parts.push(c.name);
    if (c.admin1 && c.admin1 !== c.name) parts.push(c.admin1);
    if (c.country) parts.push(c.country);
    return parts.join(", ");
}

/** 判断 IP 是否为私有/回环地址（IPv4 / IPv4-mapped IPv6 / 常见保留段） */
export function isPrivateOrLoopback(ip: string | null | undefined): boolean {
    if (!ip) return true;
    let s = String(ip).trim();
    if (s.includes(":")) {
        if (s === "::1" || s === "::") return true;
        if (s.toLowerCase().startsWith("::ffff:")) s = s.slice(7);
    }
    if (s === "127.0.0.1" || s === "localhost" || s === "0.0.0.0") return true;
    if (/^10\./.test(s)) return true;
    if (/^192\.168\./.test(s)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
    if (/^169\.254\./.test(s)) return true;
    return false;
}

const _ipCache = new Map<string, { ts: number; data: IpLocation }>();
const IP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

export type IpLocation = {
    location: string;
    timezone: string | null;
    latitude: number | null;
    longitude: number | null;
};

/**
 * 通过免费、免 key 的 ipapi.co 查询 IP 归属地（含时区/经纬度）。
 * 为避免网络抖动/离线卡死，内部强制 5 秒超时。
 */
export async function lookupIpLocation(clientIp?: string, signal?: AbortSignal): Promise<IpLocation | null> {
    const cacheKey = !clientIp || isPrivateOrLoopback(clientIp) ? "__server__" : String(clientIp).trim();
    const cached = _ipCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < IP_CACHE_TTL_MS) return cached.data;

    const useServerIp = !clientIp || isPrivateOrLoopback(clientIp);
    const url = useServerIp
        ? "https://ipapi.co/json/"
        : `https://ipapi.co/json/${encodeURIComponent(clientIp)}/`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const combinedSignal =
        signal && typeof AbortSignal.any === "function"
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal;

    try {
        const res = await fetch(url, { headers: { "User-Agent": "kirari-pet/0.8" }, signal: combinedSignal });
        clearTimeout(timeoutId);
        if (!res.ok) return null;
        const d = (await res.json()) as Record<string, unknown>;
        if (!d || d.error) return null;
        const city = (d.city as string) || (d.region as string) || "";
        const country = (d.country_name as string) || (d.country as string) || "";
        const location = city || country;
        if (!location) return null;
        const data: IpLocation = {
            location,
            timezone: (d.timezone as string) || null,
            latitude: (d.latitude as number) ?? null,
            longitude: (d.longitude as number) ?? null,
        };
        _ipCache.set(cacheKey, { ts: Date.now(), data });
        return data;
    } catch (err) {
        clearTimeout(timeoutId);
        console.warn("[location] IP 归属地查询失败：", (err as Error)?.message || err);
        return null;
    }
}

/** 非地名词黑名单（extractSetLocation / extractMergedLocation / extractLeadCity 共用） */
const NEG_WORDS = ["地图", "这儿", "那儿", "这里", "那里", "哪里", "哪儿", "哪", "此处", "该处"];

function cleanPlace(s: string | undefined | null): string | null {
    const v = (s || "").trim();
    if (!v) return null;
    if (NEG_WORDS.some((w) => v.includes(w))) return null;
    return v;
}

/**
 * 从「设置/更新位置」类语句中提取地点名；无则返回 null。
 * 「我在X」允许裸地名，靠后续地理编码校验真伪，避免把「我在吃饭」误判为地点。
 */
export function extractSetLocation(text: string): string | null {
    const t = String(text || "").trim();
    // 标注式：「我的位置/地址/坐标是 X」
    const labeled = t.match(
        /(?:我的)?(?:位置|地址|坐标)[是为在]?[:：]?\s*([\u4e00-\u9fa5A-Za-z·\s]{2,16}?)(?:市|省|县|区|旗|市辖区)?/,
    );
    if (labeled) {
        const v = cleanPlace(labeled[1]);
        if (v) return v;
    }
    // 「我在/位于/住在/家在 X」：地名后遇到语气词、标点、句尾即截断
    const at = t.match(
        /我(?:在|位于|住在|家在)\s*([\u4e00-\u9fa5A-Za-z·\s]{2,16}?)(?:市|省|县|区|旗|市辖区|~|！|!|。|，|,|\s|呀|呢|啊|哦|哈|呐|吧|嘛|咩|～|…|\.|\?|？|$)/,
    );
    if (at) {
        const v = cleanPlace(at[1]);
        if (v) return v;
    }
    return null;
}

/** 合并句「我在X + 查询」提取：如「我在北京现在几点」 */
export function extractMergedLocation(text: string): string | null {
    const t = String(text || "").trim();
    if (NEG_WORDS.some((w) => t.includes(w))) return null;
    const m = t.match(
        /我(?:在|位于|家在|住在)\s*([\u4e00-\u9fa5A-Za-z·]{2,12}?)(?:市|省|县|区|旗|市辖区|现在|此刻|当前|今天|明天|这|那|今|几|什么|查询|查|天气|时间|气温|温度|几点|几号|星期|下雨|下雪|晴天|阴天|怎么|如何|多少|啥|呀|呢|啊|吗|~|，|,|\s|$)/,
    );
    if (m) {
        const v = (m[1] || "").trim();
        if (v && !NEG_WORDS.some((w) => v.includes(w))) return v;
    }
    return null;
}

/** 句首地名 + 查询词：如「北京现在几点」。仅用于本轮一次性查询（不持久化） */
export function extractLeadCity(text: string): string {
    const t = String(text || "").trim();
    if (NEG_WORDS.some((w) => t.includes(w))) return "";
    const m = t.match(
        /^([\u4e00-\u9fa5]{2,8}?)(?:的)?(?:现在|此刻|当前|今天|明天|昨天|几点|几号|星期|天气|气温|温度|下雨|下雪|阴天|冷不|热不|穿什么|带伞|怎么样|怎样|如何)/,
    );
    if (!m) return "";
    const v = (m[1] || "").trim();
    if (
        !v ||
        ["今天", "明天", "昨天", "现在", "此刻", "当前", "本地", "这里", "这儿", "那儿", "那里", "这", "那", "我"].includes(v)
    )
        return "";
    return v;
}

/** 校验一个名字是否为真实地点（地理编码能解析即视为有效）。带缓存避免重复请求 */
const _geoCache = new Map<string, boolean>();
export async function validateLocation(name: string): Promise<boolean> {
    const n = (name || "").trim();
    if (!n) return false;
    if (_geoCache.has(n)) return _geoCache.get(n)!;
    try {
        const g = await geocode(n);
        const ok = !!(g && (g.latitude != null || g.longitude != null || g.name));
        _geoCache.set(n, ok);
        return ok;
    } catch {
        _geoCache.set(n, false);
        return false;
    }
}

/** 判断一段文本是否"看起来像一个地名"（用于刚问过位置、用户简短回应时） */
export function looksLikeLocation(text: string): boolean {
    const t = String(text || "").trim();
    if (t.length > 16) return false;
    const NON_PLACES = new Set([
        "时间", "天气", "查时间", "查天气", "东西", "事情", "问题", "名字", "密码", "账号", "电话", "地址",
        "这边", "那边", "这里", "那里", "哪儿", "哪里",
        "你好", "谢谢", "在吗", "嗨", "早安", "晚安", "吃饭", "睡觉", "游戏", "电影", "音乐", "朋友", "家人",
        "不是", "不要", "不行", "不对", "不会", "不能", "不愿", "没空", "没用", "别闹", "别急",
        "可以", "好的", "行吧", "好吧", "是的", "对的", "没错", "对呀", "好呀", "好哒",
        "知道", "明白", "了解", "懂了", "嗯嗯", "哦哦",
        "拜拜", "再见", "干嘛", "干啥",
        "哈哈", "呵呵", "嘻嘻", "哎呀", "哎哟",
        "怎么", "什么", "为什么", "谁呀", "因为", "所以", "然后", "但是", "如果",
        "no", "yes", "ok", "hi", "bye", "nah", "nope", "sure", "wait", "ya",
    ]);
    // 去掉句末语气词/标点后再比对一次，避免"不是啊""不要呀"漏网
    const base = t.replace(/(?:了|啦|咯|嘞|啊|呀|呢|吧|嘛|哦|哈|呐|咩|噻|~|～|！|!|。|，|、|．|\.|\?|？|…)+$/g, "");
    const lower = t.toLowerCase();
    if (NON_PLACES.has(t) || NON_PLACES.has(lower) || NON_PLACES.has(base) || NON_PLACES.has(base.toLowerCase())) {
        return false;
    }
    if (/^[\u4e00-\u9fa5]{2,8}(市|省|县|区|旗|市辖区)?(?:~|～|！|!|。|，|、|．|\.|\?|？|呀|呢|啊|哦|哈|呐|吧|嘛|咩|…)*$/.test(t)) return true;
    if (/^[A-Za-z]{2,20}(?:~|～|！|!|。|\.|\?|？)*$/.test(t)) return true;
    return false;
}

const DECLINE_WORDS = [
    "不知道", "不清楚", "不用了", "算了", "随便", "没有", "不想", "暂不", "稍后",
    "等下", "之后", "再说", "不告诉", "不提供", "隐私", "不用", "别问",
];

/** 用户用「不知道/不用了」等委婉拒绝提供位置 → 视为未提供，走 IP 兜底 */
export function isDecline(text: string): boolean {
    const t = String(text || "").trim();
    if (t.length > 20) return true;
    return DECLINE_WORDS.some((w) => t.includes(w));
}

export type SavedLocation = {
    location: string;
    raw: string;
    ambiguous: boolean;
    candidates: GeoCandidate[];
};

/**
 * 保存用户提供的位置。把原始输入地理编码为规范行政区划并固化坐标，
 * 保证位置唯一且正确（"北京"/"北京市"/"Beijing" 都能归一），而非存原始字符串。
 */
export async function saveUserLocation(
    userid: number,
    location: string,
    scope: string = db.LOCAL_SCOPE,
): Promise<SavedLocation | null> {
    const name = (location || "").trim();
    if (!name) return null;
    const cands = await geocodeCandidates(name, 5);
    if (!cands.length) {
        // 无法地理编码（地名不存在 / 离线）：仅记录原始输入，待用户纠正
        await db.setUserLocation(userid, { location: name, raw: name, source: "user" }, scope);
        return { location: name, raw: name, ambiguous: false, candidates: [] };
    }
    const top = cands[0];
    // 歧义检测：存在多个不同「省/国家」的同名地点（如「朝阳」→ 北京/辽宁）
    const distinct = new Set(cands.map((c) => `${c.admin1 || ""}|${c.country || ""}`));
    const ambiguous = distinct.size > 1;
    const label = buildLabel(top);
    await db.setUserLocation(
        userid,
        {
            location: label,
            raw: name,
            name: top.name,
            admin1: top.admin1 || null,
            country: top.country || null,
            countryCode: top.country_code || null,
            latitude: top.latitude,
            longitude: top.longitude,
            timezone: top.timezone || null,
            source: "user",
        },
        scope,
    );
    return { location: label || name, raw: name, ambiguous, candidates: cands.slice(0, 5) };
}

export type ResolvedLocation = {
    location: string | null;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
    displayName: string | null;
    source: string | null;
    needAsk: boolean;
    askedNow: boolean;
};

/**
 * 解析一次天气/时间查询应使用的位置。
 *   - 本轮消息里明确带了城市 → 仅本次使用（不覆盖已存默认）
 *   - 已存位置 → 直接用固化坐标
 *   - 问过一次但用户没给 → 公网 IP 归属地兜底并落库
 *   - 从未问过 → 标记已问，返回 needAsk（由调用方追问一次）
 */
export async function resolveForQuery(
    userid: number,
    clientIp: string,
    explicitLocation: string,
    signal?: AbortSignal,
    scope: string = db.LOCAL_SCOPE,
): Promise<ResolvedLocation> {
    if (explicitLocation && explicitLocation.trim()) {
        const g = await geocode(explicitLocation.trim());
        if (g) {
            return {
                location: g.name || explicitLocation,
                latitude: g.latitude ?? null,
                longitude: g.longitude ?? null,
                timezone: g.timezone || null,
                displayName: buildLabel(g),
                source: "text",
                needAsk: false,
                askedNow: false,
            };
        }
        // 显式城市地理编码失败 → 走后续兜底
    }

    const rec = await db.getUserLocation(userid, scope);
    if (rec && rec.location) {
        return {
            location: rec.location,
            latitude: rec.latitude ?? null,
            longitude: rec.longitude ?? null,
            timezone: rec.timezone || null,
            displayName: rec.location,
            source: rec.source || "user",
            needAsk: false,
            askedNow: false,
        };
    }

    if (rec && rec.askedAt) {
        // 之前已问过、用户未提供 → 按公网 IP 归属地兜底
        const ipLoc = await lookupIpLocation(clientIp, signal);
        if (ipLoc && ipLoc.location) {
            await db.setUserLocation(
                userid,
                {
                    location: ipLoc.location,
                    raw: ipLoc.location,
                    name: ipLoc.location,
                    latitude: ipLoc.latitude ?? null,
                    longitude: ipLoc.longitude ?? null,
                    timezone: ipLoc.timezone || null,
                    source: "ip",
                    askedAt: rec.askedAt,
                },
                scope,
            );
            return {
                location: ipLoc.location,
                latitude: ipLoc.latitude ?? null,
                longitude: ipLoc.longitude ?? null,
                timezone: ipLoc.timezone || null,
                displayName: ipLoc.location,
                source: "ip",
                needAsk: false,
                askedNow: false,
            };
        }
        // IP 定位也失败：不卡死、不反复追问，用本机时区临时兜底回答时间；
        // 天气需要坐标，这里无法兜底，返回 source=fallback 由调用方提示补充城市。
        console.warn("[location] IP 查询失败，回退本机时区（无坐标，无法查天气）");
        const fallbackTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        return {
            location: "本地",
            latitude: null,
            longitude: null,
            timezone: fallbackTz,
            displayName: "本地（本机时区）",
            source: "fallback",
            needAsk: false,
            askedNow: false,
        };
    }

    // 从未问过 → 先问一次，并打上 askedAt 标记
    await db.setUserLocation(userid, { askedAt: new Date().toISOString() }, scope);
    return {
        location: null,
        latitude: null,
        longitude: null,
        timezone: null,
        displayName: null,
        source: null,
        needAsk: true,
        askedNow: true,
    };
}

/** 读取已存位置记录 */
export function getUserLocation(userid: number, scope: string = db.LOCAL_SCOPE) {
    return db.getUserLocation(userid, scope);
}
