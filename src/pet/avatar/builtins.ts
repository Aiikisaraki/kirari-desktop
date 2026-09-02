// 「一套皮肤一个头像」：每个角色皮肤（形象）对应一张聊天窗口头像图。
//
// 头像来源是皮肤配置自身（主进程扫描后写入 clientConfig.avatar.chatAvatar）：
//   - 内置默认皮肤：frames.json 顶层声明 "chatAvatar": "kirari.jpg"，
//     主进程启动时从 userData/avatars/<皮肤>/ 经 avatar:// 协议对外服务。
//   - 自定义皮肤：自己的 frames.json 声明 chatAvatar（皮肤目录内文件名），同样走 avatar://。
// 因此换一套皮肤，头像随之变化。此处只做透传解析，不再硬编码任何图片路径。

/** 解析某套皮肤对应的聊天头像图。
 * - 皮肤未声明 chatAvatar（或声明为空）→ 返回 undefined；
 * - 皮肤声明了 chatAvatar 但图片加载失败 → 由渲染层 <img @error> 捕获，同样退化。
 * 两种情况最终都由 ChatWindow 渲染层回退到首字母占位，不会显示破图。 */
export function resolveChatAvatar(cfg: { id?: string; chatAvatar?: string }): string | undefined {
  if (cfg.chatAvatar && typeof cfg.chatAvatar === "string") return cfg.chatAvatar;
  return undefined;
}
