// electron/ai/activityStore.ts
// 她此刻在做什么 —— 与核心端共库、同键（settings_kv current_activity:*）。
// 刷B站是低优先级闲时活动，可被中断；问「你在干嘛」时注入 system 让她如实回答。
import { getDb } from "./db/storage";

const KEY = (uid: any) => "current_activity:" + uid;

export function describe(uid: any, now = Date.now()): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings_kv WHERE key = ?").get(KEY(uid)) as { value?: string } | undefined;
    if (!row?.value) return null;
    const v = JSON.parse(row.value);
    if (!v?.name || !Number.isFinite(v.startedAt)) return null;
    if (now - v.startedAt > (v.ttlMs || 10 * 60000)) return null;
    const mins = Math.max(0, Math.round((now - v.startedAt) / 60000));
    return mins < 1 ? "正在" + v.name : "正在" + v.name + "（" + mins + "分钟前开始）";
  } catch { return null; }
}
