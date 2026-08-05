import { contextBridge, ipcRenderer } from "electron";
import type { AdapterStatus } from "./adapter/types";

type SettingsRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
};

type DeployConfig = {
  mode: "local" | "remote";
  server: { wsUrl: string; httpUrl: string };
  builtinToken?: string;
};

// 模型配置文件（config.json）的结构：本地模式下设置界面与用户外部编辑共用。
type ModelConfigFile = {
  endpoint?: string;
  model?: string;
  key?: string;
  seeded?: boolean;
};

contextBridge.exposeInMainWorld("tokenApi", {
  getDeployConfig: (): Promise<DeployConfig> => ipcRenderer.invoke("deploy:get-config"),
  getCapabilities: (): Promise<{ localAvailable: boolean }> => ipcRenderer.invoke("deploy:get-capabilities"),
  setDeployServer: (
    server: { wsUrl: string; httpUrl: string },
  ): Promise<{ ok: boolean; server: { wsUrl: string; httpUrl: string } }> =>
    ipcRenderer.invoke("deploy:set-server", server),
  setSession: (token: string | null): Promise<void> => ipcRenderer.invoke("deploy:set-session", token),
  // 切换部署模式（本地部署 ⇄ 连接远程服务端）；主进程会清除对方模式残留并重启。
  switchMode: (target: "local" | "remote"): Promise<void> =>
    ipcRenderer.invoke("deploy:switch-mode", target),
  login: (username: string, password: string): Promise<{ ok: boolean; uid?: number; message?: string }> =>
    ipcRenderer.invoke("token:login", { username, password }),
  register: (username: string, password: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("token:register", { username, password }),
  request: (request: SettingsRequest): Promise<{ status: number; data: Record<string, unknown> }> =>
    ipcRenderer.invoke("token:request", request),
  // 本地模式：直接读写模型配置文件（config.json），外部编辑会实时同步。
  getModelConfig: (): Promise<ModelConfigFile> => ipcRenderer.invoke("config:get"),
  setModelConfig: (patch: Partial<ModelConfigFile>): Promise<ModelConfigFile> =>
    ipcRenderer.invoke("config:set", patch),
  onModelConfigChanged: (cb: (cfg: ModelConfigFile) => void): void => {
    ipcRenderer.on("config:changed", (_event, cfg: ModelConfigFile) => cb(cfg));
  },
});

// 自定义窗口控件（配合主进程 `window:control`）：最小化 / 关闭 / 最大化。
contextBridge.exposeInMainWorld("windowApi", {
  minimize: (): void => ipcRenderer.send("window:control", "minimize"),
  close: (): void => ipcRenderer.send("window:control", "close"),
  toggleMaximize: (): void => ipcRenderer.send("window:control", "toggle-maximize"),
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
