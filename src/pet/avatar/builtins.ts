// 「一套皮肤一个头像」：每个角色皮肤（形象）对应一张聊天窗口头像图。
//
// 首选来源是形象配置自身的 chatAvatar 字段：
//   - 内置默认皮肤由主进程（electron/main.ts 的 DEFAULT_AVATAR）注入；
//   - 自定义皮肤可在自己的 frames.json 顶层声明 "chatAvatar": "avatar.jpg"
//     （相对皮肤文件夹的文件名，扫描时会被转成 avatar://<皮肤目录>/avatar.jpg）。
//
// 这里只保留兜底映射：旧版持久化数据（没有 chatAvatar 字段）按皮肤 id 补全，
// 以及历史上误绑主题时期写入的 id 迁移。

export const SKIN_CHAT_AVATAR_FALLBACK: Record<string, string> = {
  // 内置默认皮肤（Kirari 精灵）
  "custom-kirari": "/avatars/kirari.jpg",
  // 旧版（误把头像绑到主题时期）持久化的 image 型形象，迁移到同一张图
  "aurora-kirari": "/avatars/kirari.jpg",
};

/** 解析某套皮肤对应的聊天头像图；没有则返回 undefined（渲染层回退为首字母）。 */
export function resolveChatAvatar(cfg: { id?: string; chatAvatar?: string }): string | undefined {
  if (cfg.chatAvatar && typeof cfg.chatAvatar === "string") return cfg.chatAvatar;
  if (cfg.id && SKIN_CHAT_AVATAR_FALLBACK[cfg.id]) return SKIN_CHAT_AVATAR_FALLBACK[cfg.id];
  return undefined;
}
