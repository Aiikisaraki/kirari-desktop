// electron/biliIpc.ts
// B站互动开关的 IPC 层（桌宠端）。与核心版 /api/bili/interaction 读写同一个 settings_kv 键，
// 命令（大模型经 capability）和设置界面共用同一真相源 —— 双向同步。
import { getDb } from "./ai/db/storage";

const KEY = "bili_interaction";
// enabled = 总闸；autoBrowse = 允许闲时自主刷（默认都关）。
const DEFAULTS = { enabled: false, autoBrowse: false, comment: false, dynamic: false, dm: false, like: false, coin: false, favorite: false };
type Settings = typeof DEFAULTS;

export function readInteraction(): Settings {
  try {
    const row = getDb().prepare("SELECT value FROM settings_kv WHERE key = ?").get(KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...DEFAULTS };
    const v = JSON.parse(row.value);
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) out[k] = !!v[k];
    return out;
  } catch { return { ...DEFAULTS }; }
}

export function writeInteraction(patch: Partial<Settings>): Settings {
  const next = { ...readInteraction() };
  for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (typeof patch[k] === "boolean") next[k] = patch[k] as boolean;
  }
  getDb().prepare("INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
  return next;
}
