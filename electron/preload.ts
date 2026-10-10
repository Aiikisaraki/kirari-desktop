import { contextBridge, ipcRenderer } from "electron";
import type { AdapterStatus } from "./adapter/types";

// 模型配置文件（config.json）的结构：设置界面与用户外部编辑共用。
type ModelConfigFile = {
  endpoint?: string;
  model?: string;
  key?: string;
  searchKey?: string;
  searchEndpoint?: string;
  searchProvider?: string;
  basePersona?: string;
  seeded?: boolean;
};

// 桌宠不设账户、也不连远程服务端：设置窗口只需要读写本机配置。
contextBridge.exposeInMainWorld("tokenApi", {
  getModelConfig: (): Promise<ModelConfigFile> => ipcRenderer.invoke("config:get"),
  setModelConfig: (patch: Partial<ModelConfigFile>): Promise<ModelConfigFile> =>
    ipcRenderer.invoke("config:set", patch),
  onModelConfigChanged: (cb: (cfg: ModelConfigFile) => void): void => {
    ipcRenderer.on("config:changed", (_event, cfg: ModelConfigFile) => cb(cfg));
  },
});

// ── 组网（活锁模型）────────────────────────────────────────────
// 桌宠既可以当主机（为其他设备提供出口），也可以当叶子（把请求上行给主机）。
// 角色由用户在设置里选，随时可换；退出不清除任何配置。
type NetRole = "off" | "host" | "leaf";

type NetSnapshot = {
    role: NetRole;
    deviceId: string;
    deviceName: string;
    address: string;
    port: number;
    hostName?: string;
    pairings: { id: string; name: string; expiresAt: number; remaining: string; usedBy: string | null; revoked: boolean }[];
    members: { deviceId: string; name: string; online: boolean; since: number }[];
    leafStatus?: string;
    pendingBackfill?: number;
    relay?: { running: number; queued: number; maxConcurrent: number; maxQueue: number } | null;
};

contextBridge.exposeInMainWorld("netApi", {
    getState: (): Promise<NetSnapshot> => ipcRenderer.invoke("net:get-state"),
    addresses: (): Promise<string[]> => ipcRenderer.invoke("net:addresses"),
    startHost: (expiry: string): Promise<{ ok: boolean; code?: string; error?: string; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:start-host", expiry),
    issuePairing: (expiry: string): Promise<{ ok: boolean; code?: string; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:issue-pairing", expiry),
    join: (pairingText: string): Promise<{ ok: boolean; error?: string; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:join", pairingText),
    resume: (): Promise<{ ok: boolean; error?: string; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:resume"),
    stop: (): Promise<{ ok: boolean; snapshot?: NetSnapshot }> => ipcRenderer.invoke("net:stop"),
    revokePairing: (id: string): Promise<{ ok: boolean; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:revoke-pairing", id),
    prunePairings: (): Promise<{ ok: boolean; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:prune-pairings"),
    removeDevice: (deviceId: string): Promise<{ ok: boolean; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:remove-device", deviceId),
    leaveHost: (): Promise<{ ok: boolean; snapshot?: NetSnapshot }> => ipcRenderer.invoke("net:leave-host"),
    renameSelf: (name: string): Promise<{ ok: boolean; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:rename-self", name),
    flushBackfill: (): Promise<{ ok: boolean; snapshot?: NetSnapshot }> =>
        ipcRenderer.invoke("net:flush-backfill"),
    onState: (cb: (s: NetSnapshot) => void): void => {
        ipcRenderer.on("net:state", (_e, s: NetSnapshot) => cb(s));
    },
    onNotice: (cb: (message: string) => void): void => {
        ipcRenderer.on("net:notice", (_e, message: string) => cb(message));
    },
});

// 自定义窗口控件（配合主进程 `window:control`）：最小化 / 关闭 / 最大化。
contextBridge.exposeInMainWorld("windowApi", {
  minimize: (): void => ipcRenderer.send("window:control", "minimize"),
  close: (): void => ipcRenderer.send("window:control", "close"),
  toggleMaximize: (): void => ipcRenderer.send("window:control", "toggle-maximize"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  // 主题：读取 / 设置 / 订阅跨窗口变更广播
  getTheme: (): Promise<string> => ipcRenderer.invoke("theme:get"),
  setTheme: (name: string): Promise<string> => ipcRenderer.invoke("theme:set", name),
  onThemeChanged: (cb: (name: string) => void): void => {
    ipcRenderer.on("theme:changed", (_event, name: string) => cb(name));
  },
  // 桌宠形象：读取 / 设置 / 订阅 / 导入
  getAvatar: (): Promise<unknown> => ipcRenderer.invoke("avatar:get"),
  getCustomAvatars: (): Promise<unknown> => ipcRenderer.invoke("avatar:custom-get"),
  setAvatar: (cfg: Record<string, unknown>): Promise<void> => ipcRenderer.invoke("avatar:set", cfg),
  importAvatarFolder: (): Promise<unknown> => ipcRenderer.invoke("avatar:import-folder"),
  importAvatarZip: (): Promise<unknown> => ipcRenderer.invoke("avatar:import-zip"),
  rescanAvatars: (): Promise<unknown> => ipcRenderer.invoke("avatar:rescan"),
  openAvatarsFolder: (): Promise<void> => ipcRenderer.invoke("avatar:open-folder"),
  onAvatarChanged: (cb: (payload: unknown) => void): void => {
    ipcRenderer.on("avatar:changed", (_event, payload: unknown) => cb(payload));
  },
  // 用系统默认浏览器打开外部链接（避免 Electron 内置窗口打开）
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("app:open-external", url),
  // 开机自启动：读取 / 设置登录项
  getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke("app:get-auto-launch"),
  setAutoLaunch: (enabled: boolean): Promise<void> => ipcRenderer.invoke("app:set-auto-launch", enabled),
  // 桌宠备注名：读取 / 设置 / 订阅跨窗口变更广播
  getPetName: (): Promise<string> => ipcRenderer.invoke("pet-name:get"),
  setPetName: (name: string): Promise<void> => ipcRenderer.invoke("pet-name:set", name),
  onPetNameChanged: (cb: (name: string) => void): void => {
    ipcRenderer.on("pet-name:changed", (_event, name: string) => cb(name));
  },
  // 聊天图片：复制 / 另存为（由主进程执行，绕过渲染进程 CORS 限制）
  copyImage: (source: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("chat:copy-image", source),
  saveImageAs: (
    source: string,
  ): Promise<{ ok: boolean; error?: string; canceled?: boolean }> =>
    ipcRenderer.invoke("chat:save-image-as", source),
  // 用户（聊天对话方）头像：仅本地存储，不上传服务器。
  // 选择图片 / 读取当前 / 移除 / 订阅变更广播。
  getUserAvatar: (): Promise<string | null> => ipcRenderer.invoke("user-avatar:get"),
  pickUserAvatar: (): Promise<string | null> => ipcRenderer.invoke("user-avatar:pick"),
  clearUserAvatar: (): Promise<void> => ipcRenderer.invoke("user-avatar:clear"),
  onUserAvatarChanged: (cb: (url: string | null) => void): void => {
    ipcRenderer.on("user-avatar:changed", (_event, url: string | null) => cb(url));
  },
});

// 机器人适配器（OneBot / QQ 官方机器人）管理接口
contextBridge.exposeInMainWorld("botAdapterApi", {
  list: (): Promise<AdapterStatus[]> => ipcRenderer.invoke("adapter:list"),
  add: (cfg: unknown): Promise<AdapterStatus> => ipcRenderer.invoke("adapter:add", cfg),
  update: (id: string, patch: unknown): Promise<AdapterStatus> =>
    ipcRenderer.invoke("adapter:update", id, patch),
  remove: (id: string): Promise<void> => ipcRenderer.invoke("adapter:remove", id),
  connect: (id: string): Promise<void> => ipcRenderer.invoke("adapter:connect", id),
  disconnect: (id: string): Promise<void> => ipcRenderer.invoke("adapter:disconnect", id),
  setOwner: (adapterId: string, accountKey: string): Promise<void> =>
    ipcRenderer.invoke("adapter:set-owner", adapterId, accountKey),
  onStatus: (cb: (status: AdapterStatus[]) => void): void => {
    ipcRenderer.on("adapter:status", (_event, status: AdapterStatus[]) => cb(status));
  },
});

// 前端托管的 MCP server 管理：列出 / 保存（保存后后端会自动重新加载工具）。
contextBridge.exposeInMainWorld("mcpApi", {
  list: (): Promise<unknown[]> => ipcRenderer.invoke("mcp:list"),
  save: (list: unknown[]): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:save", list),
});

// 前端托管的 skill（技能）管理：列出 / 保存。skill 可含行为模板（注入 system）与可调用工具。
contextBridge.exposeInMainWorld("skillApi", {
  list: (): Promise<unknown[]> => ipcRenderer.invoke("skill:list"),
  save: (list: unknown[]): Promise<{ ok: boolean }> => ipcRenderer.invoke("skill:save", list),
});

// 私人知识库本地存储 API
contextBridge.exposeInMainWorld("kbApi", {
  list: (category?: string): Promise<unknown[]> => ipcRenderer.invoke("kb:list", category),
  add: (entry: { title: string; content: string; category?: string; tags?: string[]; source?: string }): Promise<{ ok: boolean; id: number }> => 
    ipcRenderer.invoke("kb:add", entry),
  delete: (id: number): Promise<{ ok: boolean }> => ipcRenderer.invoke("kb:delete", id),
  addRemote: (source: { name: string; url: string; sourceType: string; enabled?: boolean; priority?: number }): Promise<{ ok: boolean; id: number }> =>
    ipcRenderer.invoke("kb:add-remote", source),
  updateRemote: (id: number, updates: any): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("kb:update-remote", id, updates),
});

// 媒体查看器：在独立 BrowserWindow 中打开媒体（替代应用内 overlay）。
// src 可为 data: URL / http(s) URL / avatar:// / pet:// / 本地路径；kind 可选 image|video。
//
// 保存与复制采用「渲染进程 fetch 字节 + 主进程写文件/剪贴板」模式：
// 既然 viewer 里的 <img>/<video> 已经能渲染 src，浏览器一定已经把字节加载到内存，
// 渲染进程用 fetch(src) 就能拿到 Blob → ArrayBuffer，再通过 IPC 传给主进程。
// 主进程完全不关心 src 是什么协议，只负责 dialog.showSaveDialog + fs.writeFile
// 或 nativeImage.createFromBuffer + clipboard.writeImage。
// 这样「能显示就能保存」成立，规避主进程对 avatar:// / pet:// / 鉴权 URL 重新拉取失败的问题。
//
// saveMedia 对图片和视频通用（主进程只写字节，不解析内容）；
// copyImage 仅图片可用（nativeImage 无法处理视频字节）。
contextBridge.exposeInMainWorld("viewerApi", {
  open: (src: string, kind?: "image" | "video"): Promise<void> =>
    ipcRenderer.invoke("viewer:open", src, kind),
  // bytes 必须是 ArrayBuffer（主进程会 Buffer.from(bytes)）。ext 不含点号，如 "png" / "mp4"。
  saveMedia: (
    bytes: ArrayBuffer,
    ext: string,
  ): Promise<{ ok: boolean; path?: string; error?: string; canceled?: boolean }> =>
    ipcRenderer.invoke("viewer:save-media-bytes", bytes, ext),
  // 仅图片：写入系统剪贴板（视频字节无法 createFromBuffer）。
  copyImage: (bytes: ArrayBuffer): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("viewer:copy-image-bytes", bytes),
  // viewer 窗口已打开时再点新媒体：主进程通过此事件推送 src/kind 让当前窗口更新内容，
  // 而不是再开一个窗口。
  onUpdate: (cb: (src: string, kind?: string) => void): void => {
    ipcRenderer.on("viewer:update", (_event, src: string, kind?: string) => cb(src, kind));
  },
});
