// electron/ai/reply/timeContext.ts
// 统一「时间基准」上下文：把「现在是什么时间、这是哪个时区的时间」明确、唯一地告诉模型。
//
// 与核心版 kirari-core/src/services/reply/timeContext.js 逐字对应，改一边必须同步改另一边。
//
// 背景：桌宠曾在同一轮对话里给出三个互相矛盾的「当前时间」——
//   1) 按用户语境推理出的「晚上 7 点」；
//   2) get_current_time 工具按 IANA 时区读出的本地时间（正确，如 13:52）；
//   3) 「系统本地时间」原文——进程跑在 UTC，读出来是凌晨 05:54。
// 根因不是单纯「时区没换算」，而是模型没有一条带标签、唯一可信的时间基准，
// 于是把 UTC 时钟、工具时间、语境时间当成同一个「现在」来用，才会反复改口。

/** 默认时区：取机器 IANA 时区；取不到退到东八区。绝不退回裸 UTC。 */
export function defaultTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz !== "UTC") return tz;
  } catch {
    /* ignore */
  }
  return "Asia/Shanghai";
}

interface TimeParts {
  year?: string;
  month?: string;
  day?: string;
  weekday?: string;
  hour?: string;
  minute?: string;
}

function partsInZone(date: Date, timezone: string): TimeParts {
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const out: TimeParts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") (out as Record<string, string>)[p.type] = p.value;
  }
  return out;
}

function offsetLabel(date: Date, timezone: string): string | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    const part = dtf.formatToParts(date).find((p) => p.type === "timeZoneName");
    if (part && /^GMT[+-]\d{2}:\d{2}$/.test(part.value)) {
      return part.value.replace("GMT", "UTC");
    }
  } catch {
    /* ignore */
  }
  return null;
}

export interface TimeContextOptions {
  timezone?: string | null;
  now?: Date;
  locationLabel?: string;
}

/** 生成时间基准 system 注入段。 */
export function buildTimeContext({ timezone, now, locationLabel }: TimeContextOptions = {}): string {
  const tz = typeof timezone === "string" && timezone.trim() ? timezone.trim() : defaultTimezone();
  const date = now instanceof Date ? now : new Date();
  const p = partsInZone(date, tz);
  const offset = offsetLabel(date, tz);
  const where = locationLabel ? `（主人所在地：${locationLabel}）` : "";
  const tzLabel = offset ? `${tz} / ${offset}` : tz;

  return (
    "\n\n【时间基准 · 最高优先级】" +
    `\n- 当前对主人来说是：${p.year}年${p.month}月${p.day}日 ${p.weekday} ${p.hour}:${p.minute}（时区 ${tzLabel}）${where}。` +
    "\n- 上面这个时刻是「主人所在地的时间」。系统时钟/服务器可能跑在 UTC 或别的时区，不要把它的裸读数当成主人这里的当前时间。" +
    "\n- 凡涉及「现在几点 / 今天 / 早上中午晚上 / 该不该睡 / 设提醒」等与时间有关的判断，一律以本段为准。" +
    "\n- 若 get_current_time 工具返回的时间与本段不一致，以工具返回为准，但它说的是哪个时区就按哪个时区理解，不要混用。" +
    "\n- 回答里不要把时区 ID、UTC 偏移或 ISO 时间戳原样念出来，用「凌晨/早上/上午/中午/下午/晚上」自然表达即可。"
  );
}
