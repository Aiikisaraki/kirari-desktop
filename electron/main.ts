import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray } from "electron";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

// 将自定义协议注册为「标准安全协议」，使渲染进程可以直接用
// fetch() / new Image() / CSS url() 等方式加载 avatar:// / pet:// 资源，
// 避免依赖 IPC 兜底，也修复自定义协议在打包后因 file:// origin 被拦截的问题。
// 必须在 app.ready 之前调用。
protocol.registerSchemesAsPrivileged([
  { scheme: "avatar", privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
  { scheme: "pet", privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
]);
import extract from "extract-zip";
import { ChatSessionService, type ChatStateSnapshot } from "./chat-session-service";
import { AdapterManager } from "./adapter/adapter-manager";
import type { AdapterConfig, AdapterStatus } from "./adapter/types";
import { startBackendIfLocal, stopBackend, applyConfigToBackend, getBackendPort, isBackendBundled } from "./backend-launcher";
import * as frontendTools from "./frontend-tools";
import { readModelConfigFile, writeModelConfigFile, onModelConfigChanged, startModelConfigWatch } from "./model-config";
import { initAppLogger, getLogPath, isDebugMode } from "./app-logger";

type PetWindow = InstanceType<typeof BrowserWindow>;
type PetTray = InstanceType<typeof Tray>;

// ---- 部署配置（由"安装过程"生成的 pet-client.config.json 决定工作模式）----
type ThemeName = "aurora-glass" | "pet-pink" | "mint-soft" | "lavender-mist";
const THEME_LIST: ThemeName[] = ["aurora-glass", "pet-pink", "mint-soft", "lavender-mist"];
const DEFAULT_THEME: ThemeName = "aurora-glass";

// 桌宠形象配置（与前端 AvatarConfig 对应，主进程独立定义以避免依赖前端运行时模块）
type AvatarConfig = {
  type: "sprite" | "live2d";
  src: string;
  scale?: number;
  id?: string;
  name?: string;
  author?: string;
  version?: string;
  builtin?: boolean;
};
type AvatarMeta = AvatarConfig & { id: string; name: string; builtin?: boolean };

const DEFAULT_AVATAR: AvatarConfig = {
  id: "custom-" + DEFAULT_SKIN_DIR,
  name: "Aki Kirari",
  author: "Aki",
  version: "1.0.0",
  type: "sprite",
  src: `avatar://${encodeURIComponent(DEFAULT_SKIN_DIR)}/frames.json`,
};

// 兼容旧版持久化：把旧默认形象（id=kirari-sprite / src=pet://frames.json）
// 迁移到新的 avatar:// 流程，避免下拉框选不中当前形象。
function migrateLegacyAvatar(saved: AvatarConfig): AvatarConfig {
  if (
    saved.id === "kirari-sprite" ||
    saved.src === "pet://frames.json" ||
    (saved.src === DEFAULT_AVATAR.src && saved.id !== DEFAULT_AVATAR.id)
  ) {
    return { ...DEFAULT_AVATAR };
  }
  return saved;
}

type DeployConfig = {
  mode: "local" | "remote";
  server: { wsUrl: string; httpUrl: string };
  builtinToken?: string;
  theme?: ThemeName;
  avatar?: AvatarConfig;
  customAvatars?: AvatarMeta[];
  // 桌宠备注名（显示在聊天窗口顶部），缺省 Kirari。
  petName?: string;
  // 桌宠窗口位置（全局坐标）。由主进程在拖动结束/重置时持久化，启动时优先应用。
  window?: { x: number; y: number };
  // 机器人适配器配置（OneBot / QQ 官方机器人）。连接信息含令牌，仅存于本机 userData 配置。
  adapters?: AdapterConfig[];
  // 分离（远端）模式登录后的会话令牌，持久化以跨重启保持登录态。
  sessionToken?: string;
  // 配置由哪种安装包写入，用于区分残留配置：
  // "integrated" = 一键部署（内联后端）；"frontend" = 仅前端（需自连远程服务器）；
  // 旧版/非一键安装包可能无此字段（undefined），视为 legacy，会被一键部署包重置。
  deployment?: "integrated" | "frontend";
};
const DEFAULT_BUILTIN_TOKEN = "kirari-local-builtin";
const DEFAULT_LOCAL = {
  mode: "local" as const,
  server: { wsUrl: "ws://localhost:9089/ws", httpUrl: "http://localhost:9089" },
  builtinToken: DEFAULT_BUILTIN_TOKEN,
  theme: DEFAULT_THEME,
  avatar: DEFAULT_AVATAR,
  adapters: [],
};

function loadClientConfig(): DeployConfig {
  const candidates = [
    process.env.PET_CLIENT_CONFIG,
    path.join(app.getPath("userData"), "pet-client.config.json"),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && (raw.mode === "local" || raw.mode === "remote") && raw.server) {
      return {
        mode: raw.mode,
        server: {
          wsUrl: raw.server.wsUrl || (raw.mode === "local" ? "ws://localhost:9089/ws" : ""),
          httpUrl: raw.server.httpUrl || (raw.mode === "local" ? "http://localhost:9089" : ""),
        },
        builtinToken: raw.builtinToken || DEFAULT_BUILTIN_TOKEN,
        theme: THEME_LIST.includes(raw.theme) ? raw.theme : DEFAULT_THEME,
        avatar: migrateLegacyAvatar(
          raw.avatar && raw.avatar.type && raw.avatar.src ? raw.avatar : DEFAULT_AVATAR,
        ),
        customAvatars: Array.isArray(raw.customAvatars) ? raw.customAvatars : [],
        petName: typeof raw.petName === "string" && raw.petName.trim() ? raw.petName.trim() : "Kirari",
        adapters: Array.isArray(raw.adapters)
          ? raw.adapters.filter(
              (a: AdapterConfig) => a && typeof a.id === "string" && typeof a.type === "string",
            )
          : [],
        sessionToken: typeof raw.sessionToken === "string" ? raw.sessionToken : undefined,
        deployment:
          raw.deployment === "integrated" || raw.deployment === "frontend"
            ? raw.deployment
            : undefined,
        // 仅当 x/y 都是有效数字时才采用持久化位置；否则保持 undefined，启动时回退默认。
        window:
          raw.window && typeof raw.window.x === "number" && typeof raw.window.y === "number"
            ? { x: raw.window.x, y: raw.window.y }
            : undefined,
      };
      }
    } catch {
      // 配置无效则尝试下一个候选
    }
  }
  return { ...DEFAULT_LOCAL };
}

const clientConfig = loadClientConfig();

// 纯前端版（frontend edition）未打包后端：若配置仍是 local 模式，强制退化为 remote，
// 否则会一直尝试连接本机 9089 而后端根本不存在。退化后由设置页让用户填写远程服务器地址。
const localBackendAvailable = isBackendBundled();

if (!localBackendAvailable && clientConfig.mode === "local") {
  console.warn("[config] 当前安装包未包含本地后端，强制切换为远程模式（请在设置中填写服务端地址）");
  clientConfig.mode = "remote";
  if (!clientConfig.server) clientConfig.server = { wsUrl: "", httpUrl: "" };
  saveClientConfig();
}

// 一键部署包（bundled 后端）：防止旧的非一键部署安装包残留配置干扰内联连接。
// 旧配置可能残留 remote 模式 + 旧服务器地址 + 已失效的 sessionToken，会导致本应内联的
// 连接被错误地指向旧服务器而失效。检测到「非本安装包写入」(deployment !== "integrated")
// 时，强制重置为内联 local 模式，丢弃旧服务器地址与旧 sessionToken（内联模式用 builtinToken）。
if (localBackendAvailable && clientConfig.deployment !== "integrated") {
  console.warn(
    "[config] 检测到非一键部署的残留配置，一键部署包已重置为内联本地模式（忽略旧服务器地址与凭证）",
  );
  clientConfig.mode = "local";
  clientConfig.server = { wsUrl: "", httpUrl: "" };
  clientConfig.sessionToken = undefined;
  clientConfig.deployment = "integrated";
  saveClientConfig();
}

function saveClientConfig() {
  try {
    fs.writeFileSync(
      path.join(app.getPath("userData"), "pet-client.config.json"),
      JSON.stringify(clientConfig, null, 2)
    );
  } catch (e) {
    console.error("[config] 保存客户端配置失败:", e);
  }
}

// ───────────────── 前端托管工具（MCP / skill）配置 ─────────────────
const MCP_CONFIG_PATH = path.join(app.getPath("userData"), "mcp-servers.json");
const SKILLS_CONFIG_PATH = path.join(app.getPath("userData"), "skills.json");

function loadJsonFile<T>(p: string, fallback: T): T {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch (e) {
    console.error(`[frontend-tools] 读取 ${p} 失败:`, e);
  }
  return fallback;
}

// 内置示例 skill：让用户首次启动即可看到 skill 能力（行为模板 + 一个 echo 工具）。
const DEFAULT_SKILLS: frontendTools.SkillConfig[] = [
  {
    id: "builtin-helper",
    name: "贴心助手",
    description: "示例技能：让桌宠更温柔地回应，并提供一个可调用工具用于回显测试。",
    enabled: true,
    prompt: "你是一只温柔贴心的桌宠，回答简洁友好，适当使用颜文字。当用户提到「测试工具」时可使用回显工具。",
    tools: [
      {
        name: "echo",
        description: "把收到的参数原样返回，用于验证前端工具调用链路是否打通。",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "要回显的文本" } },
          required: ["text"],
        },
        exec: { kind: "echo" },
      },
    ],
  },
];

// 初始化前端托管工具：从 userData 读取用户配置的 MCP server 与 skill，
// 失败/缺失时回退到内置示例 skill，保证开箱即用地把工具注册给后端。
export function initFrontendTools(): void {
  const mcpServers = loadJsonFile<frontendTools.McpServerConfig[]>(MCP_CONFIG_PATH, []);
  const skills = loadJsonFile<frontendTools.SkillConfig[]>(SKILLS_CONFIG_PATH, DEFAULT_SKILLS);
  frontendTools.setMcpServers(mcpServers);
  frontendTools.setSkills(skills);
  // 启动时载入用户自定义基础人格（如有），确保 WS 连接建立后即可推送，无需先打开设置页。
  const initialCfg = readModelConfigFile();
  frontendTools.setBasePersona(initialCfg.basePersona || "");
  console.log(
    `[frontend-tools] 已加载 MCP server ${mcpServers.length} 个、skill ${skills.filter((s) => s.enabled).length} 个（启用）、基础人格${initialCfg.basePersona ? "（自定义）" : "（预设）"}`,
  );
}

// ───────────────── MCP / skill 管理的 IPC ─────────────────
// 设置页读取/保存 MCP server 与 skill 配置。保存后刷新前端工具池，
// 并通过 ChatSessionService 重新向后端注册工具（无需重启）。
function saveJsonFile(p: string, data: unknown): void {
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[frontend-tools] 写入 ${p} 失败:`, e);
  }
}

ipcMain.handle("mcp:list", (): frontendTools.McpServerConfig[] => {
  return frontendTools.getMcpServers();
});

ipcMain.handle("mcp:save", (_e, list: frontendTools.McpServerConfig[]): { ok: boolean } => {
  saveJsonFile(MCP_CONFIG_PATH, list);
  frontendTools.setMcpServers(list);
  reRegisterFrontendTools();
  return { ok: true };
});

ipcMain.handle("skill:list", (): frontendTools.SkillConfig[] => {
  return frontendTools.getSkills();
});

ipcMain.handle("skill:save", (_e, list: frontendTools.SkillConfig[]): { ok: boolean } => {
  saveJsonFile(SKILLS_CONFIG_PATH, list);
  frontendTools.setSkills(list);
  reRegisterFrontendTools();
  return { ok: true };
});

// 重新把前端工具（MCP + skill）注册给后端：通过 ChatSessionService 重新发送 register_tools / register_skills。
function reRegisterFrontendTools(): void {
  try {
    const chat = (globalThis as any).__chatSessionService;
    if (chat && typeof chat.reRegisterTools === "function") {
      chat.reRegisterTools();
    }
  } catch (e) {
    console.warn("[frontend-tools] 重新注册工具失败（可能需要重连）:", e instanceof Error ? e.message : String(e));
  }
}

// 创建并初始化机器人适配器管理器（连接已启用的适配器 + 后端 WS）。
// 启动时与「远程服务器地址变更（deploy:set-server）」时共用，保证重建逻辑一致。
function initAdapterManager() {
  try {
    if (adapterManager) {
      try {
        adapterManager.dispose();
      } catch {
        // 忽略释放异常
      }
      adapterManager = null;
    }
    const token =
      clientConfig.mode === "local"
        ? clientConfig.builtinToken || DEFAULT_BUILTIN_TOKEN
        : settingsSessionToken ?? "";
    adapterManager = new AdapterManager({
      backendUrl,
      token,
      getDesktopSessionId: () => ensureChatSessionService().getSnapshot().sessionId,
      getAdaptersConfig: () => clientConfig.adapters || [],
      saveAdaptersConfig: (adapters) => {
        clientConfig.adapters = adapters;
        saveClientConfig();
      },
      onStatusChange: broadcastAdapterStatus,
      // 主人在其他协议端（QQ 等）的对话同步进桌宠聊天框
      pushOwnerMessage: (m) => {
        const svc = ensureChatSessionService();
        if (svc) svc.injectExternalMessage(m);
      },
    });
    adapterManager.init();
  } catch (e) {
    console.error("[adapter] 初始化失败:", e);
  }
}

// 自定义形象统一存放目录（跨平台一致：Windows=AppData/Roaming/<app>/avatars，
// macOS=Library/Application Support/<app>/avatars，Linux=~/.config/<app>/avatars）。
// 通过 avatar:// 协议对外服务，也作为"用户把文件夹丢进来即生效"的指定目录。
function getAvatarsRoot(): string {
  return path.join(app.getPath("userData"), "avatars");
}

// 默认（内置）皮肤在 userData/avatars 下的文件夹名。
const DEFAULT_SKIN_DIR = "kirari";

// 形象目录文件系统监听器：用户/外部程序直接向 userData/avatars 增删形象文件夹时，
// 主进程自动重新扫描并广播 avatar:changed，设置页无需手动刷新即可看到新形象。
let avatarFolderWatcher: fs.FSWatcher | null = null;

// 读取皮肤配置（frames.json）的元信息：渲染类型、显示名、作者、版本。
// 显示名优先取配置里的 `name`，缺省回退为文件夹名（fallbackName）。
type AvatarMetaInfo = {
  type: "sprite" | "live2d";
  name: string;
  author?: string;
  version?: string;
};
function readAvatarMeta(framesPath: string, fallbackName: string): AvatarMetaInfo {
  let name = fallbackName;
  let author: string | undefined;
  let version: string | undefined;
  let type: "sprite" | "live2d" = "sprite";
  try {
    const parsed = JSON.parse(fs.readFileSync(framesPath, "utf8"));
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.name === "string" && parsed.name.trim()) name = parsed.name;
      if (typeof parsed.author === "string" && parsed.author.trim()) author = parsed.author;
      if (typeof parsed.version === "string" && parsed.version.trim()) version = parsed.version;
      if (parsed.type === "live2d") type = "live2d";
    }
  } catch {
    /* 读取/解析失败则用默认值 */
  }
  return { type, name, author, version };
}

// 官方皮肤资源源目录（打包进安装包的 resources/official-avatars，或开发期项目目录）。
// pet:// 协议与 pet:read-asset 兜底的兜底加载都从这里取文件。
function getOfficialAvatarsSource(): string {
  const candidates = [
    path.join(process.resourcesPath, "official-avatars"),
    path.resolve(__dirname, "../resources/official-avatars"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

// 默认（官方）皮肤兜底：扫描 userData/avatars，若没有任何含 frames.json 的皮肤目录，
// 则从「打包进来的官方皮肤源」复制一次。生产环境源为 process.resourcesPath/official-avatars
// （extraResources 打包进安装包）；开发环境源为项目 resources/official-avatars。
// 仅当目标缺失时复制一次，绝不覆盖用户已存在的皮肤 —— 满足「只复制一次、不每次替换」。
function ensureDefaultAvatars(): void {
  try {
    const destRoot = getAvatarsRoot();
    fs.mkdirSync(destRoot, { recursive: true });
    const hasAnySkin = fs
      .readdirSync(destRoot, { withFileTypes: true })
      .some((e) => e.isDirectory() && fs.existsSync(path.join(destRoot, e.name, "frames.json")));
    if (hasAnySkin) return; // 已有皮肤则不复制，避免覆盖用户自定义
    const srcRoot = getOfficialAvatarsSource();
    if (!fs.existsSync(srcRoot)) {
      console.warn("[avatar] 未找到官方皮肤源，跳过默认皮肤复制:", srcRoot);
      return;
    }
    for (const e of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const srcDir = path.join(srcRoot, e.name);
      if (!fs.existsSync(path.join(srcDir, "frames.json"))) continue;
      fs.cpSync(srcDir, path.join(destRoot, e.name), { recursive: true });
      console.log("[avatar] 已复制默认皮肤到:", path.join(destRoot, e.name));
    }
  } catch (e) {
    console.error("[avatar] 默认皮肤复制失败:", e);
  }
}

// 主题变更时广播给所有已打开窗口，保证跨窗口一致
function broadcastTheme(name: ThemeName) {
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("theme:changed", name);
  }
}

// 形象变更时广播给所有已打开窗口，含当前形象与自定义形象列表
function broadcastAvatar() {
  const payload = {
    current: clientConfig.avatar || DEFAULT_AVATAR,
    custom: clientConfig.customAvatars || [],
  };
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("avatar:changed", payload);
  }
}

// 桌宠备注名变更时广播给所有已打开窗口，聊天窗口同步标题与头部显示。
function broadcastPetName() {
  const name = clientConfig.petName || "Kirari";
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("pet-name:changed", name);
  }
}

// 启动 userData/avatars 目录监听：用户直接增删/替换形象文件夹时自动刷新注册表。
// 递归监听子目录，并以 300ms 防抖聚合高频事件，避免复制大皮肤时反复扫描。
function startAvatarFolderWatch(): void {
  const root = getAvatarsRoot();
  if (!fs.existsSync(root)) {
    console.warn("[avatar] 形象目录不存在，跳过监听:", root);
    return;
  }
  if (avatarFolderWatcher) {
    try {
      avatarFolderWatcher.close();
    } catch {
      /* 忽略重复关闭错误 */
    }
    avatarFolderWatcher = null;
  }
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    avatarFolderWatcher = fs.watch(root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // 只关注 frames.json 与目录级变更，精灵图变更不影响注册表但会触发重载，
      // 这里一律防抖后重新扫描，简单可靠。
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("[avatar] 检测到形象目录变化，自动重新扫描:", filename);
        scanAvatarsIntoConfig();
        broadcastAvatar();
        debounceTimer = null;
      }, 300);
    });
    console.log("[avatar] 已启动形象目录监听:", root);
  } catch (e) {
    console.error("[avatar] 启动形象目录监听失败:", e);
  }
}

type SettingsApiRequest = {
  method: "GET" | "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
};

const petWindowSize = { width: 360, height: 400 };
// 聊天窗口默认尺寸：QQ 桌面聊天区大小（920×680），
// 配合方向⑤「双栏头像·带尾气泡」布局（头像常驻两侧 + 非对称圆角气泡 + 时间戳）。
// minWidth/minHeight 锁到 720×520：保证双栏头像+工具栏+输入区不折叠。
const chatWindowSize = { width: 920, height: 680 };
// 桌面端默认 980×720：让用户首次打开就能进入桌面端双栏布局（侧栏 + 右栏卡片）
// 并触发 ≥860px 的横版专属样式（padding 48px 等）。若给到 560 这种窄宽度，
// SettingsPage 的 matchMedia("(max-width: 720px)") 会判定为窄窗、走移动端布局，
// 永远看不到双栏，表现为"卡片消失 / 导航不见"。
// minWidth 锁到 640：保证即使被用户拖到很窄，也仍处于"双栏布局"档位，
// 只有真正接近手机的宽度（≤640）才会回退到顶部胶囊的移动端布局。
const settingsWindowSize = { width: 980, height: 720 };
// 后端连接地址。本地模式下，这些值会在 startBackendIfLocal 之后被动态端口刷新
// （见下方 init 流程），覆盖配置里写死的 9089；远程模式沿用配置中的远端地址。
let backendUrl = clientConfig.server.wsUrl || "ws://localhost:9089/ws";
let backendHttpUrl = clientConfig.server.httpUrl || "http://localhost:9089";
let backendHealthUrl = `${backendHttpUrl.replace(/\/$/, "")}/health`;
let loggedInUid: number | null = null; // 非本地模式：登录后的 uid（聊天身份）
let chatServiceUserid: number | null = null; // 已创建的聊天服务所用 uid，便于登录/登出后重建

// 聊天身份：本地模式固定为内置账户 uid=1；非本地模式使用登录后的 uid。
function resolveChatUserid(): number {
  if (clientConfig.mode === "local") return 1;
  return loggedInUid && loggedInUid > 0 ? loggedInUid : 1;
}

// 聊天记录按「部署模式 + 服务端 + 登录身份」隔离存储：避免本地部署与分离部署
// （或不同远程服务器 / 不同账号）的聊天历史混在同一份文件里互相串味。
// 旧版只有一个固定的 chat-session.json，切换模式/账号时加载的是同一份记录，
// 即「本地部署的记录和分离部署登录其他服务器的记录混在一起」bug 的根源。
function resolveChatStoragePath(): string {
  const base = app.getPath("userData");
  if (clientConfig.mode === "local") {
    return path.join(base, "chat-session.local.json");
  }
  // 远程模式：同一台服务器 + 同一 uid 视为同一会话身份，各自独立文件。
  // 服务端地址做哈希以生成安全文件名（避免 URL 中特殊字符 / 过长）。
  const serverId = clientConfig.server?.httpUrl || clientConfig.server?.wsUrl || "unknown";
  const hash = createHash("sha1").update(serverId).digest("hex").slice(0, 12);
  const uid = resolveChatUserid();
  return path.join(base, `chat-session.remote.${hash}.${uid}.json`);
}

let settingsSessionToken: string | null = clientConfig.sessionToken ?? null;
let settingsWindow: PetWindow | null = null;

let petWindow: PetWindow | null = null;
let chatWindow: PetWindow | null = null;
let tray: PetTray | null = null;
let adapterManager: AdapterManager | null = null;
let dragState: {
  windowId: number;
  windowStart: { x: number; y: number };
  pointerStart: { x: number; y: number };
} | null = null;
let isQuitting = false;
let chatSessionService: ChatSessionService | null = null;
// 聊天会话持久化文件路径：按当前部署模式/服务端/登录身份隔离（见 resolveChatStoragePath），
// 每次重建聊天连接时重算，确保不同身份加载各自独立的聊天历史。
let chatSessionStoragePath = "";

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    return { message: `后端返回了非 JSON 响应（HTTP ${response.status}）` };
  }
}

// 设置/账号类请求：本地模式带内置账户令牌，远程模式带登录后的会话令牌。
// 不再使用 ed25519 客户端签名，配置读写由账户凭证驱动，对前端无感。
async function requestSettingsApi(request: SettingsApiRequest) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (clientConfig.mode === "local") {
    // 本地内置账户令牌：后端 verifySessionOrBuiltin 只认 Authorization: Bearer，
    // 故优先用 Bearer 形式；X-Builtin-Token 仅作兼容保留。
    const builtinToken = clientConfig.builtinToken || DEFAULT_BUILTIN_TOKEN;
    headers["Authorization"] = `Bearer ${builtinToken}`;
    headers["X-Builtin-Token"] = builtinToken;
  } else if (settingsSessionToken) {
    headers["Authorization"] = `Bearer ${settingsSessionToken}`;
  }
  const response = await fetch(`${backendHttpUrl}${request.path}`, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : JSON.stringify(request.body),
  });
  return { status: response.status, data: await readApiResponse(response) };
}

// 自定义窗口控件（最小化 / 关闭 / 最大化）的 IPC 入口；
// 用 event.sender 反查触发窗口，避免直接持有窗口引用。
ipcMain.on("window:control", (event, action: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === "minimize") win.minimize();
  else if (action === "close") win.close();
  else if (action === "toggle-maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    title: "设置",
    width: settingsWindowSize.width,
    height: settingsWindowSize.height,
    minWidth: 640,
    minHeight: 560,
    show: false,
    frame: false,
    transparent: true,
    // 透明窗口在 Windows 上默认是直角矩形，圆角需显式开启，否则四角会透出半透明直角轮廓。
    roundedCorners: true,
    // 关掉 OS DWM 窗口级阴影——transparent + 圆角窗口下，DWM 仍按矩形画阴影，
    // 会把 CSS 圆角内容框成一个"假圆角"。关掉之后只剩 CSS 本身的圆角 + 背景。
    hasShadow: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: { preload: path.resolve(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  settingsWindow.on("closed", () => { settingsWindow = null; });
  const settingsTheme = clientConfig.theme || DEFAULT_THEME;
  if (process.env.VITE_DEV_SERVER_URL) settingsWindow.loadURL(new URL(`?window=settings&theme=${settingsTheme}`, process.env.VITE_DEV_SERVER_URL).toString());
  else settingsWindow.loadFile(path.resolve(__dirname, "../dist/index.html"), { query: { window: "settings", theme: settingsTheme } });
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  return settingsWindow;
}

ipcMain.handle("deploy:get-config", () => clientConfig);

// 暴露「本机是否打包了后端」给前端，用于决定是否展示本地/远程相关提示与控件。
ipcMain.handle("deploy:get-capabilities", () => ({
  localAvailable: localBackendAvailable,
}));

// 切换部署模式（本地部署 ⇄ 连接远程服务端）。
// 关键诉求：切换时自动清除「对方模式」的残留配置，避免用户手动登出+重配。
//   - 切到 remote：清空本地 server 地址与远程 sessionToken（builtinToken 保留，无害），
//     重启后进入 remote 模式，由设置页填写服务端地址并登录。
//   - 切到 local：恢复 localhost 默认地址与内置令牌，清空远程 sessionToken，
//     重启后随程序启动内置后端、以内置令牌免登录。
// deployment 字段保持 "integrated"（由本安装包写入），确保重启后不会被 L158 的
// 「非一键部署残留」保护块再次强制重置，使本次切换稳定生效。
// 切换需要重启：后端连接与聊天通道在启动时依 mode 建立，无法在运行时热切换。
ipcMain.handle("deploy:switch-mode", (_event, target: "local" | "remote") => {
  if (target === "remote") {
    clientConfig.mode = "remote";
    clientConfig.server = { wsUrl: "", httpUrl: "" };
    clientConfig.sessionToken = undefined;
  } else {
    clientConfig.mode = "local";
    clientConfig.server = { wsUrl: "ws://localhost:9089/ws", httpUrl: "http://localhost:9089" };
    clientConfig.sessionToken = undefined;
  }
  saveClientConfig();
  // 先登记重启，再退出；relaunch 在 quit 后拉起新实例。
  app.relaunch();
  app.quit();
});

// 远程模式下由设置页修改服务端地址（ws/http）。写入 clientConfig 并持久化，
// 立即刷新主进程连接地址、重建适配器连接（无需重启即可生效）。
ipcMain.handle(
  "deploy:set-server",
  (_event, server: { wsUrl?: string; httpUrl?: string }) => {
    const wsUrl = typeof server.wsUrl === "string" ? server.wsUrl.trim() : "";
    const httpUrl = typeof server.httpUrl === "string" ? server.httpUrl.trim() : "";
    clientConfig.server = { wsUrl, httpUrl };
    saveClientConfig();
    // 刷新主进程级别的连接地址
    backendUrl = wsUrl || "ws://localhost:9089/ws";
    backendHttpUrl = httpUrl || "http://localhost:9089";
    backendHealthUrl = `${backendHttpUrl.replace(/\/$/, "")}/health`;
    console.log(`[deploy] 服务端地址已更新 ws=${backendUrl} http=${backendHttpUrl}`);
    // 重建适配器连接，让新的后端地址立即生效（local 模式也重建，无副作用）
    initAdapterManager();
    return { ok: true as const, server: { wsUrl, httpUrl } };
  },
);
ipcMain.handle("theme:get", () => clientConfig.theme || DEFAULT_THEME);
ipcMain.handle("theme:set", (_event, name: string) => {
  const next: ThemeName = (THEME_LIST as string[]).includes(name) ? (name as ThemeName) : DEFAULT_THEME;
  clientConfig.theme = next;
  saveClientConfig();
  broadcastTheme(next);
  return next;
});

// 桌宠备注名：读取 / 设置 / 持久化 / 广播
ipcMain.handle("pet-name:get", () => clientConfig.petName || "Kirari");
ipcMain.handle("pet-name:set", (_event, name: unknown) => {
  const next = typeof name === "string" && name.trim() ? name.trim() : "Kirari";
  clientConfig.petName = next;
  saveClientConfig();
  broadcastPetName();
  // 同步刷新聊天窗口的标题栏文字
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.setTitle(`和 ${next} 聊天`);
  }
  return next;
});

// ---- 桌宠形象：读取 / 设置当前形象 + 列表 + 导入 ----
ipcMain.handle("avatar:get", () => clientConfig.avatar || DEFAULT_AVATAR);
ipcMain.handle("avatar:custom-get", () => clientConfig.customAvatars || []);

ipcMain.handle("avatar:set", (_event, cfg: AvatarConfig) => {
  console.log("[main] avatar:set 收到:", cfg?.id, cfg?.name, cfg?.src);
  clientConfig.avatar = cfg;
  saveClientConfig();
  broadcastAvatar();
});

// 递归确认 dir 内所有解压文件都落在 dir 之内（防止恶意压缩包 zip slip 路径穿越）。
function allExtractedUnder(dir: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return false;
  }
  const walk = (p: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      let r: string;
      try {
        r = fs.realpathSync(full);
      } catch {
        return false;
      }
      if (r !== real && !r.startsWith(real + path.sep)) return false;
      if (e.isDirectory() && !walk(full)) return false;
    }
    return true;
  };
  return walk(dir);
}

// 若解压后 dir 下仅有唯一子目录且该子目录含 frames.json，则把子目录内容上移一层，
// 去掉压缩包可能多套的一层根目录，使 frames.json 直接落在形象目录下。
function flattenSingleRoot(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch {
    return;
  }
  if (entries.length !== 1) return;
  const sub = path.join(dir, entries[0].name);
  if (!fs.existsSync(path.join(sub, "frames.json"))) return;
  for (const f of fs.readdirSync(sub)) {
    fs.renameSync(path.join(sub, f), path.join(dir, f));
  }
  fs.rmSync(sub, { recursive: true, force: true });
}

// 收集 frames.json 中引用但磁盘上缺失的精灵图文件名（兼容 clips 数组与旧扁平格式）。
function collectMissingSheets(
  manifest: Record<string, unknown>,
  dir: string,
): string[] {
  const missing: string[] = [];
  const pushClip = (clip: Record<string, unknown>) => {
    const sheet = clip.sheet;
    if (typeof sheet === "string" && !fs.existsSync(path.join(dir, sheet)))
      missing.push(sheet);
  };
  for (const key of Object.keys(manifest)) {
    const raw = manifest[key] as Record<string, unknown>;
    if (Array.isArray(raw.clips)) {
      (raw.clips as unknown[]).forEach((c) =>
        pushClip(c as Record<string, unknown>),
      );
    } else if (typeof raw.sheet === "string") {
      pushClip(raw);
    }
  }
  return missing;
}

// 启动扫描：把 userData/avatars 下含 frames.json 的子目录注册为可用形象。
// 对已有条目会刷新 name/author/version/type/src（方便用户改配置文件后自动同步），
// 对不再存在的目录会移除对应条目。
function scanAvatarsIntoConfig(): void {
  try {
    const root = getAvatarsRoot();
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
      return;
    }
    clientConfig.customAvatars = clientConfig.customAvatars || [];
    const existingById = new Map(
      (clientConfig.customAvatars || []).map((a) => [a.id, a]),
    );
    const next: AvatarMeta[] = [];
    let changed = false;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const framesPath = path.join(root, e.name, "frames.json");
      if (!fs.existsSync(framesPath)) continue;
      const id = "custom-" + e.name;
      const meta = readAvatarMeta(framesPath, e.name);
      const fresh: AvatarMeta = {
        id,
        name: meta.name,
        author: meta.author,
        version: meta.version,
        type: meta.type,
        src: `avatar://${encodeURIComponent(e.name)}/frames.json`,
        builtin: false,
      };
      const old = existingById.get(id);
      if (
        !old ||
        old.name !== fresh.name ||
        old.author !== fresh.author ||
        old.version !== fresh.version ||
        old.type !== fresh.type ||
        old.src !== fresh.src
      ) {
        changed = true;
      }
      next.push(fresh);
      existingById.delete(id);
    }
    // 剩余 existingById 中的条目对应磁盘上已不存在的形象，视为已删除。
    if (existingById.size > 0) changed = true;
    if (changed) {
      clientConfig.customAvatars = next;
      saveClientConfig();
    }
  } catch (e) {
    console.error("[avatar] 启动扫描失败:", e);
  }
}

// 打开形象目录（便于用户找到"指定文件夹"，把自定义形象文件夹丢进去后即可在设置里刷新出现）。
ipcMain.handle("avatar:open-folder", async () => {
  const root = getAvatarsRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    /* 忽略 */
  }
  shell.openPath(root);
});

// 用系统默认浏览器打开外部链接（而非 Electron 内置窗口）。
// 仅放行 http/https，避免任意协议（如 file://、cmd 等）被打开造成安全风险。
ipcMain.handle("app:open-external", (_event, url: unknown) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    console.warn("[open-external] 已拒绝非 http(s) 链接:", url);
    return;
  }
  shell.openExternal(url);
});

// 开机自启动：读取 / 设置登录项（HKCU\...\Run）。与安装向导 --set-auto-launch 走同一机制，
// 保证安装期勾选与设置界面勾选写入的是同一条登录项，状态完全一致。
ipcMain.handle("app:get-auto-launch", (): boolean => {
  return app.getLoginItemSettings().openAtLogin === true;
});
ipcMain.handle("app:set-auto-launch", (_event, enabled: unknown) => {
  const open = enabled === true;
  app.setLoginItemSettings({ openAtLogin: open });
  console.log(`[autostart] 开机自启动已${open ? "开启" : "关闭"}`);
});

// 重新扫描 userData/avatars：把新增的（含 frames.json 的）子目录注册为自定义形象并广播。
ipcMain.handle("avatar:rescan", () => {
  scanAvatarsIntoConfig();
  broadcastAvatar();
  return clientConfig.customAvatars || [];
});

// 上传形象压缩包：选择 ZIP → 解压到 userData/avatars/<包名>/ → 校验 frames.json 与精灵图 →
// 注册 avatar:// 协议并切换到该形象。压缩包内部结构与文件夹一致；
// 若根目录只有一个文件夹则自动剥掉这层，使 frames.json 直接落在形象目录下。
ipcMain.handle("avatar:import-zip", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择形象压缩包",
    properties: ["openFile"],
    filters: [{ name: "形象压缩包", extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePaths[0])
    return { ok: false, message: "已取消" };
  const zipPath = result.filePaths[0];
  const baseName = path.basename(zipPath, path.extname(zipPath)) || "avatar";
  const root = getAvatarsRoot();
  const destDir = path.join(root, baseName);
  try {
    fs.mkdirSync(root, { recursive: true });
    // 同名形象先清空，避免旧文件残留
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    await extract(zipPath, { dir: destDir });
    // 防 zip slip：校验所有解压文件都落在 destDir 内
    if (!allExtractedUnder(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return { ok: false, message: "压缩包包含非法路径，已拒绝" };
    }
    // 若解压后仅有一个子目录且内含 frames.json，则上移一层（去掉多余根目录）
    flattenSingleRoot(destDir);
    const framesPath = path.join(destDir, "frames.json");
    if (!fs.existsSync(framesPath)) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return { ok: false, message: "压缩包内缺少 frames.json" };
    }
    // 校验每个动画片段引用的图片都存在
    const manifest = JSON.parse(fs.readFileSync(framesPath, "utf8"));
    const missing = collectMissingSheets(manifest, destDir);
    if (missing.length) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return { ok: false, message: "以下精灵图缺失：" + missing.join(", ") };
    }
    const metaInfo = readAvatarMeta(framesPath, baseName);
    const meta: AvatarMeta = {
      id: "custom-" + baseName,
      name: metaInfo.name,
      author: metaInfo.author,
      version: metaInfo.version,
      type: metaInfo.type,
      src: `avatar://${encodeURIComponent(baseName)}/frames.json`,
      builtin: false,
    };
    clientConfig.customAvatars = clientConfig.customAvatars || [];
    const idx = clientConfig.customAvatars.findIndex((a) => a.id === meta.id);
    if (idx >= 0) clientConfig.customAvatars[idx] = meta;
    else clientConfig.customAvatars.push(meta);
    clientConfig.avatar = meta;
    saveClientConfig();
    broadcastAvatar();
    return { ok: true, meta };
  } catch (e) {
    return {
      ok: false,
      message: "解压失败：" + (e instanceof Error ? e.message : ""),
    };
  }
});

// 导入自定义精灵形象：弹出目录选择框，校验 frames.json 后复制到 userData/avatars，
// 注册 avatar:// 协议供渲染进程加载，并切换到该形象。
ipcMain.handle("avatar:import-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择精灵形象文件夹",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, message: "已取消" };
  const srcDir = result.filePaths[0];
  const framesPath = path.join(srcDir, "frames.json");
  if (!fs.existsSync(framesPath)) return { ok: false, message: "该文件夹缺少 frames.json" };
  let manifest: Record<string, unknown> & { type?: unknown } = {};
  try {
    manifest = JSON.parse(fs.readFileSync(framesPath, "utf8"));
  } catch {
    return { ok: false, message: "frames.json 解析失败" };
  }
  if (!manifest || typeof manifest !== "object") return { ok: false, message: "frames.json 内容无效" };
  const name = path.basename(srcDir);
  const destDir = path.join(app.getPath("userData"), "avatars", name);
  try {
    fs.cpSync(srcDir, destDir, { recursive: true });
  } catch (e) {
    return { ok: false, message: "复制失败：" + (e instanceof Error ? e.message : "") };
  }
  const metaInfo = readAvatarMeta(framesPath, name);
  const meta: AvatarMeta = {
    id: "custom-" + name,
    name: metaInfo.name,
    author: metaInfo.author,
    version: metaInfo.version,
    type: metaInfo.type,
    src: `avatar://${encodeURIComponent(name)}/frames.json`,
    builtin: false,
  };
  clientConfig.customAvatars = clientConfig.customAvatars || [];
  const idx = clientConfig.customAvatars.findIndex((a) => a.id === meta.id);
  if (idx >= 0) clientConfig.customAvatars[idx] = meta;
  else clientConfig.customAvatars.push(meta);
  clientConfig.avatar = meta;
  saveClientConfig();
  broadcastAvatar();
  return { ok: true, meta };
});
ipcMain.handle("deploy:set-session", (_event, token: string | null) => {
  settingsSessionToken = token || null;
  clientConfig.sessionToken = token ?? undefined;
  saveClientConfig();
  if (!token) {
    // 登出：清空远程 uid，并按本地身份（uid=1）重建聊天服务。
    loggedInUid = null;
    if (chatSessionService) {
      chatSessionService.dispose();
      chatSessionService = null;
      chatServiceUserid = null;
    }
  } else if (!chatSessionService) {
    // 防御性分支：若登录链路未兜底重建（例如未来某路径只调用 set-session），
    // 在此补一次重连。已重建则跳过，避免重复 dispose/recreate。
    reconnectChatSession();
  }
});
ipcMain.handle("token:login", async (_event, credentials: { username: string; password: string }) => {
  try {
    const response = await fetch(`${backendHttpUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    const data = await readApiResponse(response);
    if (!response.ok) return { ok: false, message: String(data.message || "登录失败") };
    settingsSessionToken = String(data.sessionToken);
    loggedInUid = Number(data.uid);
    // 登录后按新身份（含新会话令牌）重建聊天服务并自动重连：
    // 旧连接已被放弃，若不在登录成功后立即重建+init，聊天窗口会停留在断开态，
    // 直到用户手动发一条消息才惰性触发连接——这正是“登录后不自动连接”的根因。
    reconnectChatSession();
    // 持久化登录凭证，重启桌宠后自动恢复登录态。
    clientConfig.sessionToken = settingsSessionToken;
    saveClientConfig();
    return { ok: true, uid: data.uid };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "无法连接服务端" };
  }
});
ipcMain.handle("token:register", async (_event, credentials: { username: string; password: string }) => {
  try {
    const response = await fetch(`${backendHttpUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    const data = await readApiResponse(response);
    if (!response.ok) return { ok: false, message: String(data.message || "注册失败") };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "无法连接服务端" };
  }
});
ipcMain.handle("token:request", (_event, request: SettingsApiRequest) => requestSettingsApi(request));

// ---- 模型配置（config.json）：本地模式的「用户级可编辑配置文件」 ----
// 本地模式设置界面直接读写 config.json；远程模式仍走后端 /api/profile。
ipcMain.handle("config:get", () => readModelConfigFile());
ipcMain.handle("config:set", (_event, patch: Record<string, unknown>) => {
  const next = writeModelConfigFile({
    endpoint: typeof patch.endpoint === "string" ? patch.endpoint : undefined,
    model: typeof patch.model === "string" ? patch.model : undefined,
    key: typeof patch.key === "string" ? patch.key : undefined,
    searchKey: typeof patch.searchKey === "string" ? patch.searchKey : undefined,
    searchEndpoint: typeof patch.searchEndpoint === "string" ? patch.searchEndpoint : undefined,
    searchProvider: typeof patch.searchProvider === "string" ? patch.searchProvider : undefined,
    basePersona: typeof patch.basePersona === "string" ? patch.basePersona : undefined,
  });
  // 写文件会触发 fs.watch → 同步后端 + 广播；这里再显式执行一次，确保本进程内保存也能即时生效。
  handleModelConfigChanged(next);
  return next;
});

// config.json 被外部编辑器修改（或本进程写入）后：同步到后端 DB 并广播给所有窗口。
function handleModelConfigChanged(cfg: ReturnType<typeof readModelConfigFile>) {
  void applyConfigToBackend();
  // 基础人格随配置变更即时生效：更新持有人并通过 WS 重新注册给后端（无需重启）。
  frontendTools.setBasePersona(cfg.basePersona || "");
  reRegisterFrontendTools();
  for (const win of [petWindow, chatWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send("config:changed", cfg);
  }
}

// 监听 config.json 外部编辑：用户用文本编辑器改文件后实时同步到后端与前端。
onModelConfigChanged(handleModelConfigChanged);

function getDefaultWindowPosition(win: PetWindow) {
  const display = screen.getPrimaryDisplay();
  const bounds = win.getBounds();
  const { x, y, width, height } = display.workArea;

  return {
    x: x + width - bounds.width - 32,
    y: y + height - bounds.height - 32,
  };
}

function resetWindowPosition(win: PetWindow) {
  const nextPosition = getDefaultWindowPosition(win);
  win.setPosition(nextPosition.x, nextPosition.y, false);
  win.moveTop();
}

// 桌宠窗口位置持久化：把当前窗口左上角坐标写入客户端配置（pet-client.config.json），
// 下次启动优先恢复，避免每次都回到默认右下角。
function persistWindowPosition(win: PetWindow) {
  try {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    clientConfig.window = { x, y };
    saveClientConfig();
  } catch (e) {
    console.error("[window] 保存桌宠位置失败:", e);
  }
}

// 校验坐标是否落在任一显示器的可见区域内（左上角在某块屏幕 bounds 内即可），
// 防止多显示器/分辨率变化后持久化坐标跑到屏幕外导致桌宠"消失"。
function isPositionOnScreen(x: number, y: number, w: number, h: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const b = d.bounds;
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  });
}

function resolveTrayIconPath() {
  // 使用软件图标 app-icon.ico（与 exe / 任务栏 / 安装包一致），而非旧的 tray.png
  if (process.env.VITE_DEV_SERVER_URL) {
    return path.resolve(__dirname, "../public/app-icon.ico");
  }

  return path.resolve(__dirname, "../dist/app-icon.ico");
}

function getTrayIcon() {
  const icon = nativeImage.createFromPath(resolveTrayIconPath());
  return icon.resize({ width: 16, height: 16 });
}

function getAllLiveWindows() {
  return [petWindow, chatWindow].filter((win): win is PetWindow => !!win && !win.isDestroyed());
}

function broadcastChatState(state: ChatStateSnapshot) {
  getAllLiveWindows().forEach((win) => {
    win.webContents.send("chat:state", state);
  });
}

function broadcastAdapterStatus() {
  const status: AdapterStatus[] = adapterManager ? adapterManager.list() : [];
  getAllLiveWindows().forEach((win) => {
    win.webContents.send("adapter:status", status);
  });
}

function ensureChatSessionService() {
  const uid = resolveChatUserid();
  if (!chatSessionService || chatServiceUserid !== uid) {
    if (chatSessionService) chatSessionService.dispose();
    chatServiceUserid = uid;
    // 会话令牌：本地模式带内置账户令牌，远程模式带登录后的会话令牌；由后端在 WS 握手阶段校验。
    const token =
      clientConfig.mode === "local"
        ? clientConfig.builtinToken || DEFAULT_BUILTIN_TOKEN
        : (settingsSessionToken ?? "");
    chatSessionService = new ChatSessionService({
      backendUrl,
      userid: uid,
      token,
      requireToken: true,
      emitState: broadcastChatState,
    });
    // 暴露给 MCP / skill 保存后「重新注册工具」时调用。
    (globalThis as any).__chatSessionService = chatSessionService;
  }

  return chatSessionService;
}

// 按当前部署模式 / 登录态重建聊天服务并立即连接。
// token:login 登录成功后必须调用：旧连接已被放弃，若不重建则聊天窗口停留在断开态，
// 直到用户手动发消息才惰性触发连接（即“登录后不自动连接”的旧问题）。
function reconnectChatSession(): void {
  if (chatSessionService) {
    chatSessionService.dispose();
    chatSessionService = null;
    chatServiceUserid = null;
  }
  // 身份（模式/服务端/uid）可能已变化，重算隔离路径，避免加载到别的身份的聊天记录。
  chatSessionStoragePath = resolveChatStoragePath();
  void ensureChatSessionService().init(chatSessionStoragePath);
}

function ensurePetWindow() {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = createWindow();
  }

  return petWindow;
}

function ensureChatWindow() {
  if (!chatWindow || chatWindow.isDestroyed()) {
    chatWindow = createChatWindow();
  }

  return chatWindow;
}

function showChatWindow() {
  const win = ensureChatWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // 聊天窗口已打开：通知桌宠窗口清零未读（打开即视为已读）。
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send("chat:open-changed", true);
  }
  updateTrayMenu();
}

function showPetWindow() {
  const win = ensurePetWindow();
  win.showInactive();
  win.setSkipTaskbar(true);
  win.setAlwaysOnTop(true);
  win.moveTop();
  updateTrayMenu();
}

function hidePetWindow() {
  if (!petWindow) return;

  petWindow.hide();
  updateTrayMenu();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function updateTrayMenu() {
  if (!tray) return;

  const isWindowVisible = petWindow?.isVisible() ?? false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示桌宠",
        enabled: !isWindowVisible,
        click: showPetWindow,
      },
      {
        label: "隐藏桌宠",
        enabled: isWindowVisible,
        click: hidePetWindow,
      },
      { type: "separator" },
      {
        label: "打开聊天",
        click: showChatWindow,
      },
      { type: "separator" },
      {
        label: "打开设置",
        click: createSettingsWindow,
      },
      {
        label: "打开调试日志",
        click: () => {
          const p = getLogPath();
          if (p) shell.openPath(path.dirname(p));
          else dialog.showErrorBox("无法打开日志", "未找到日志文件路径，可能在 sandbox 环境下 userData 不可写。");
        },
      },
      { type: "separator" },
      {
        label: "重置位置",
        click: () => {
          const win = ensurePetWindow();
          resetWindowPosition(win);
          showPetWindow();
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: quitApp,
      },
    ]),
  );
}

function createTray() {
  if (tray) return;

  tray = new Tray(getTrayIcon());
  tray.setToolTip("Kirari绮莉");
  tray.on("click", () => {
    if (petWindow?.isVisible()) {
      hidePetWindow();
      return;
    }

    showPetWindow();
  });
  updateTrayMenu();
}

function createWindow() {
  const win = new BrowserWindow({
    title: "Kirari绮莉",
    frame: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    // 透明窗口在 Windows 上默认是直角矩形，圆角需显式开启，否则四角会透出半透明直角轮廓。
    roundedCorners: true,
    width: petWindowSize.width,
    height: petWindowSize.height,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  petWindow = win;
  // 优先恢复持久化位置；坐标无效（如屏幕外）则回退默认右下角。
  const saved = clientConfig.window;
  if (saved && isPositionOnScreen(saved.x, saved.y, petWindowSize.width, petWindowSize.height)) {
    win.setPosition(saved.x, saved.y, false);
  } else {
    resetWindowPosition(win);
  }
  win.setAlwaysOnTop(true);
  win.setSkipTaskbar(true);

  win.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    hidePetWindow();
  });

  win.on("show", updateTrayMenu);
  win.on("hide", updateTrayMenu);
  win.on("closed", () => {
    if (petWindow === win) petWindow = null;
    updateTrayMenu();
  });

  win.once("ready-to-show", () => {
    showPetWindow();
    if (isDebugMode()) win.webContents.openDevTools({ mode: "detach" });
    const snapshot = ensureChatSessionService().getSnapshot();
    win.webContents.send("chat:state", snapshot);
  });

  const petTheme = clientConfig.theme || DEFAULT_THEME;
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(new URL(`?theme=${petTheme}`, process.env.VITE_DEV_SERVER_URL).toString());
  } else {
    win.loadFile(path.resolve(__dirname, "../dist/index.html"), { query: { theme: petTheme } });
  }

  return win;
}

function createChatWindow() {
  // 透明无边框窗口在 Windows 上若不给 x/y 会让系统默认坐标算错（常被甩到屏幕外被截断）。
  // 这里按主显示器工作区（排除任务栏）显式居中，保证窗口完整可见。
  const { workAreaSize } = screen.getPrimaryDisplay();
  const x = Math.max(0, Math.round((workAreaSize.width - chatWindowSize.width) / 2));
  const y = Math.max(0, Math.round((workAreaSize.height - chatWindowSize.height) / 2));

  const win = new BrowserWindow({
    title: `和 ${clientConfig.petName || "Kirari"} 聊天`,
    width: chatWindowSize.width,
    height: chatWindowSize.height,
    x,
    y,
    minWidth: 720,
    minHeight: 520,
    show: false,
    frame: false,
    transparent: true,
    // 透明窗口在 Windows 上默认是直角矩形，圆角需显式开启，否则四角会透出半透明直角轮廓。
    roundedCorners: true,
    // 关掉 OS DWM 窗口级阴影，否则圆角内容外层会被画矩形阴影包住，形成"假圆角"。
    hasShadow: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  chatWindow = win;

  // 聊天窗口关闭时通知桌宠窗口（已读状态复位），由 Pinia store 在关闭后
  // 对期间来的新消息重新计入未读。打开即视为已读的逻辑见 showChatWindow。
  win.on("closed", () => {
    if (chatWindow === win) chatWindow = null;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.webContents.send("chat:open-changed", false);
    }
    updateTrayMenu();
  });

  win.once("ready-to-show", () => {
    if (isDebugMode()) win.webContents.openDevTools({ mode: "detach" });
    const snapshot = ensureChatSessionService().getSnapshot();
    win.webContents.send("chat:state", snapshot);
  });

  const chatTheme = clientConfig.theme || DEFAULT_THEME;
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(new URL(`?window=chat&theme=${chatTheme}`, process.env.VITE_DEV_SERVER_URL).toString());
  } else {
    win.loadFile(path.resolve(__dirname, "../dist/index.html"), {
      query: { window: "chat", theme: chatTheme },
    });
  }

  return win;
}

ipcMain.handle("chat:get-state", () => {
  return ensureChatSessionService().getSnapshot();
});

// ---- 机器人适配器管理（OneBot / QQ 官方机器人）----
ipcMain.handle("adapter:list", () => (adapterManager ? adapterManager.list() : []));
ipcMain.handle("adapter:add", (_event, cfg) => {
  if (!adapterManager) throw new Error("适配器管理器未初始化");
  return adapterManager.add(cfg);
});
ipcMain.handle("adapter:update", (_event, id: string, patch) => {
  if (!adapterManager) throw new Error("适配器管理器未初始化");
  return adapterManager.update(id, patch);
});
ipcMain.handle("adapter:remove", (_event, id: string) => {
  if (!adapterManager) throw new Error("适配器管理器未初始化");
  return adapterManager.remove(id);
});
ipcMain.handle("adapter:connect", (_event, id: string) => {
  if (!adapterManager) throw new Error("适配器管理器未初始化");
  return adapterManager.connect(id);
});
ipcMain.handle("adapter:disconnect", (_event, id: string) => {
  if (!adapterManager) throw new Error("适配器管理器未初始化");
  return adapterManager.disconnect(id);
});
ipcMain.handle("adapter:set-owner", (_event, adapterId: string, accountKey: string) => {
  if (!adapterManager) throw new Error("适配器管理器未初始化");
  return adapterManager.setOwner(adapterId, accountKey);
});

ipcMain.on("chat:send-message", (_event, payload: { text: string; images?: string[] }) => {
  void ensureChatSessionService().sendMessage(payload);
});

ipcMain.on("desktop-pet:drag-start", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const [x, y] = win.getPosition();
  const pointerStart = screen.getCursorScreenPoint();
  dragState = {
    windowId: win.id,
    windowStart: { x, y },
    pointerStart,
  };
  win.moveTop();
});

ipcMain.on("desktop-pet:drag-move", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !dragState || dragState.windowId !== win.id) return;

  const pointer = screen.getCursorScreenPoint();
  const nextX = Math.round(dragState.windowStart.x + pointer.x - dragState.pointerStart.x);
  const nextY = Math.round(dragState.windowStart.y + pointer.y - dragState.pointerStart.y);

  win.setPosition(nextX, nextY, false);
});

ipcMain.on("desktop-pet:drag-end", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  dragState = null;
  // 拖动结束：把最终位置持久化，下次启动恢复。
  if (win) persistWindowPosition(win);
});

// 逐像素点穿：渲染进程按光标处像素 alpha 判定后，通知主进程切换窗口的鼠标穿透。
// ignore=true 时桌宠窗口忽略鼠标、事件透传给下方窗口，实现"只有角色实心区才拦截、
// 透明背景可点穿"。光标位置由主进程轮询（见下方 setInterval）后广播给渲染进程，
// 不依赖窗口是否接收鼠标事件，从根上规避死锁。
ipcMain.on("desktop-pet:set-ignore-mouse", (event, ignore: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(ignore);
});

// 光标轮询：主进程 screen 模块可用（渲染进程在 Electron 42 下已不可用），
// 每 20ms 取一次全局光标，换算成相对桌宠窗口的视口坐标，广播给渲染进程做逐像素判定。
// 关键：轮询在主进程，与桌宠窗口是否处于"点穿"(setIgnoreMouseEvents=true) 无关，
// 因此光标移回角色实心区时仍能正常广播、关闭点穿，不会陷入"点穿后收不到事件"的死锁。
let lastCursorSent = { x: Number.NaN, y: Number.NaN };
setInterval(() => {
  if (!petWindow || petWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const b = petWindow.getBounds();
  // 关键修复：screen.getCursorScreenPoint() 返回物理像素，getBounds() 返回逻辑像素。
  // 必须按光标所在显示器的 scaleFactor 把光标换算成逻辑像素，再与 getBounds 相减，
  // 否则高 DPI 下坐标被放大，命中测试整片错位/越界 → 永久点穿。
  const disp = screen.getDisplayNearestPoint(cursor);
  const scale = disp?.scaleFactor || 1;
  const lx = cursor.x / scale - b.x;
  const ly = cursor.y / scale - b.y;
  // 坐标无变化则跳过，避免无谓 IPC 抖动
  if (lx === lastCursorSent.x && ly === lastCursorSent.y) return;
  lastCursorSent = { x: lx, y: ly };
  petWindow.webContents.send("desktop-pet:cursor", { x: lx, y: ly });
}, 20);

ipcMain.on("desktop-pet:reset-position", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  resetWindowPosition(win);
  // 重置后也持久化为默认位置，使下次启动保持右下角。
  persistWindowPosition(win);
});

ipcMain.on("desktop-pet:open-chat", () => {
  showChatWindow();
});

// 悬浮菜单入口：从桌宠窗口打开设置界面 / 隐藏桌宠。
ipcMain.on("desktop-pet:open-settings", () => {
  createSettingsWindow();
});

ipcMain.on("desktop-pet:hide", () => {
  hidePetWindow();
});

ipcMain.on("desktop-pet:show-context-menu", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  Menu.buildFromTemplate([
    {
      label: "打开聊天",
      click: showChatWindow,
    },
    {
      label: "重置位置",
      click: () => {
        const petWin = ensurePetWindow();
        resetWindowPosition(petWin);
        showPetWindow();
      },
    },
    { type: "separator" },
    {
      label: "隐藏桌宠",
      click: hidePetWindow,
    },
  ]).popup({ window: win ?? undefined });
});

async function checkBackendHealth() {
  try {
    const res = await fetch(backendHealthUrl);
    if (!res.ok) throw new Error("后端服务未正常启动");
  } catch (e) {
    console.log("联调提示", `请先启动后端服务（${backendHealthUrl}）`);
  }
}

app.whenReady().then(async () => {
  // 安装向导「开机自动启动」勾选：以一次性标志拉起本进程，仅写入登录项后退出，
  // 不创建任何窗口（避免闪窗）。保证与设置界面勾选走同一套 Electron 登录项机制。
  if (process.argv.includes("--set-auto-launch")) {
    app.setLoginItemSettings({ openAtLogin: true });
    console.log("[autostart] 安装向导请求设置开机启动，已写入登录项并退出");
    app.quit();
    return;
  }

  // 卸载清理：由 NSIS customUnInstall 阶段以一次性标志拉起本进程，
  // 仅移除登录项（HKCU\...\Run 的开机启动注册表项）后退出，不创建任何窗口。
  // 与设置界面「开机自启动」、安装向导勾选共用同一套 Electron 登录项机制，
  // 保证写入与清除的是同一条登录项。
  if (process.argv.includes("--clear-auto-launch")) {
    app.setLoginItemSettings({ openAtLogin: false });
    console.log("[autostart] 卸载清理请求，已移除开机启动登录项并退出");
    app.quit();
    return;
  }

  // 初始化日志（劫持 console，主进程输出同时落盘到 userData/logs/）。
  // 必须在任何 console.* 输出之前调用，确保调试信息不丢失。
  const logPath = initAppLogger();
  const debug = isDebugMode();
  console.log("========================================");
  console.log(`Kirari绮莉 启动`);
  console.log(`调试模式: ${debug ? "开 (--debug)" : "关"}`);
  console.log(`日志文件: ${logPath ?? "(无法写入，请检查 userData 权限)"}`);
  console.log(`工作模式: ${clientConfig.mode}`);
  console.log("========================================");

  // 注册 pet:// 协议：打包后 loadFile 无 HTTP 服务器，
  // fetch('/pet/frames.json') 无法解析。通过自定义协议映射到精灵帧资源目录。
  // 注意：Electron 42.x 的 registerFileProtocol 回调要求 filePath 属性（非 path）。
  protocol.registerFileProtocol("pet", (request, callback) => {
    try {
      const rel = decodeURIComponent(request.url.replace("pet://", ""));
      const assetDir = getOfficialAvatarsSource();
      callback({ filePath: path.join(assetDir, rel) });
    } catch {
      callback({ error: -100 });
    }
  });

  // 注册 avatar:// 协议，使导入到 userData/avatars 的自定义形象可被渲染进程加载
  protocol.registerFileProtocol("avatar", (request, callback) => {
    try {
      const rel = decodeURIComponent(request.url.replace("avatar://", ""));
      callback({ filePath: path.join(app.getPath("userData"), "avatars", rel) });
    } catch {
      callback({ error: -100 });
    }
  });

  // ---- IPC：精灵帧资源加载兜底 ----
  // 当渲染进程的 fetch('pet://...') 因安全策略或兼容性问题失败时，
  // 可通过此通道由主进程直接读取 asar 内文件并返回内容。
  ipcMain.handle("pet:read-asset", async (_event, relativePath: string) => {
    try {
      const assetDir = getOfficialAvatarsSource();
      const avatarsDir = getAvatarsRoot();
      // 优先取官方皮肤资源目录，否则回退到用户自定义形象目录（userData/avatars）
      const fullPath = fs.existsSync(path.join(assetDir, relativePath))
        ? path.join(assetDir, relativePath)
        : path.join(avatarsDir, relativePath);
      const buf = fs.readFileSync(fullPath);
      // 根据扩展名判断返回格式：JSON 返回解析后对象，图片返回 base64 data URL
      const ext = path.extname(relativePath).toLowerCase();
      if (ext === ".json") return { ok: true, data: JSON.parse(buf.toString("utf-8")) };
      const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
      return { ok: true, data: `data:${mime};base64,${buf.toString("base64")}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // 加载前端托管的 MCP server 与 skill 配置，供 WS 连接后注册给后端调用。
  initFrontendTools();

  // 本地模式（打包版）：以子进程方式自启动后端 API，关闭前端时一并关闭。
  // dev 与 remote 模式不启动本地后端。
  // 关键：把 clientConfig.builtinToken 透传给启动器，确保后端 BUILTIN_ACCOUNT_TOKEN
  // 与前端的 WS 握手令牌一致，否则会一直被后端拒绝（4401）。
  if (clientConfig.mode === "local") {
    await startBackendIfLocal({ isLocal: true, builtinToken: clientConfig.builtinToken || DEFAULT_BUILTIN_TOKEN });
  }

  // 本地模式（打包版）：主进程已为本次启动动态挑选空闲端口并作为启动参数注入后端子进程，
  // 这里同步刷新主进程/前端的连接地址，覆盖配置里写死的 9089。
  // 远程模式不注入动态端口，沿用配置中的远端地址；dev 模式也不覆盖（使用外部独立后端）。
  if (clientConfig.mode === "local" && app.isPackaged) {
    const p = getBackendPort();
    backendUrl = `ws://127.0.0.1:${p}/ws`;
    backendHttpUrl = `http://127.0.0.1:${p}`;
    backendHealthUrl = `http://127.0.0.1:${p}/health`;
    console.log(`[backend] 本地模式使用动态端口 ${p} 连接后端`);
  }

  // 分离（远程）模式：程序启动即做一次凭证有效性检测。
  // 若本地残留的 sessionToken 已失效（服务端重置 DB / token 过期），不要带着错误凭证
  // 去反复重连 WS，而是立即清除并通知前端回到「未登录」状态，由用户在设置页重新登录。
  if (clientConfig.mode === "remote" && settingsSessionToken) {
    try {
      const verifyRes = await fetch(`${backendHttpUrl}/api/profile`, {
        method: "GET",
        headers: { Authorization: `Bearer ${settingsSessionToken}` },
      });
      if (verifyRes.status === 401) {
        console.warn("[auth] 启动检测：本地 sessionToken 已失效，清除并回到未登录状态");
        settingsSessionToken = undefined;
        clientConfig.sessionToken = undefined;
        saveClientConfig();
      } else if (verifyRes.ok) {
        console.log("[auth] 启动检测：本地 sessionToken 仍有效");
      }
    } catch (e) {
      console.warn("[auth] 启动检测 sessionToken 失败（后端不可达）:", e instanceof Error ? e.message : String(e));
    }
  }

  // 启动 config.json 监听：用户在外部编辑器修改模型配置后，实时同步到后端并广播前端。
  startModelConfigWatch();

  // 官方皮肤兜底：生产/开发通用。若 userData/avatars 为空（如 NSIS 安装脚本释放失败、
  // 或卸载重装后目录被清空），首次启动从打包进来的官方皮肤源复制一次；已有皮肤则跳过，
  // 绝不覆盖用户自定义。随后扫描注册所有形象。
  ensureDefaultAvatars();
  scanAvatarsIntoConfig();

  // 启动形象目录监听：用户直接向形象文件夹增删皮肤时自动刷新设置页与桌宠窗口。
  startAvatarFolderWatch();

  // 兼容旧版持久化 + 兜底校验：默认形象若指向旧 pet:// 协议、旧 id，或当前形象
  // 已不在扫描后的形象列表中，则回退到默认形象，避免下拉框选不中。
  const registeredIds = new Set((clientConfig.customAvatars || []).map((a) => a.id));
  const current = clientConfig.avatar || DEFAULT_AVATAR;
  if (
    current.id === "kirari-sprite" ||
    current.src === "pet://frames.json" ||
    (current.src?.startsWith("avatar://kirari/") && current.id !== "custom-kirari") ||
    !registeredIds.has(current.id)
  ) {
    clientConfig.avatar = { ...DEFAULT_AVATAR };
    saveClientConfig();
  }

  let res = await checkBackendHealth();
  chatSessionStoragePath = resolveChatStoragePath();
  // 兼容迁移：旧版把全部历史存在固定的 chat-session.json。本地模式改用独立文件，
  // 首次启动时把旧文件内容搬到本地槽位，避免既有本地聊天记录凭空消失（远程历史不迁移，避免错归身份）。
  const legacyChatPath = path.join(app.getPath("userData"), "chat-session.json");
  if (clientConfig.mode === "local" && chatSessionStoragePath !== legacyChatPath) {
    try {
      if (!fs.existsSync(chatSessionStoragePath) && fs.existsSync(legacyChatPath)) {
        fs.copyFileSync(legacyChatPath, chatSessionStoragePath);
        console.log("[chat] 已迁移旧版本地聊天记录到 chat-session.local.json");
      }
    } catch (e) {
      console.warn("[chat] 迁移旧聊天记录失败（不影响启动）:", e instanceof Error ? e.message : String(e));
    }
  }
  await ensureChatSessionService().init(chatSessionStoragePath);
  // 初始化机器人适配器管理器：连接已启用的适配器与后端 WS，使 QQ 等跨端消息可在启动时同步进桌宠。
  // 之前仅在 deploy:set-server（远程改服务端地址）里调用，启动时漏掉会导致 adapter:* 处理器
  // 全部抛「适配器管理器未初始化」。此时 backendUrl 与聊天服务均已就绪，调用安全。
  initAdapterManager();
  createTray();
  ensurePetWindow();

  app.on("activate", () => {
    showPetWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBackend();
  chatSessionService?.dispose();
  if (avatarFolderWatcher) {
    try {
      avatarFolderWatcher.close();
    } catch {
      /* 忽略 */
    }
    avatarFolderWatcher = null;
  }
});

app.on("window-all-closed", () => {
  updateTrayMenu();
});
