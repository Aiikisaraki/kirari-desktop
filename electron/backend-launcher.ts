// electron/backend-launcher.ts
// 本地模式（单机打包版）后端 API 子进程管理器。
// 职责：把 pet-api（Node 服务）作为子进程拉起；关闭前端时同步终止。
// dev 模式（VITE_DEV_SERVER_URL）与 remote 模式不启动本地后端，沿用既有行为。
import { spawn, execSync, type ChildProcess } from "child_process";
import { app } from "electron";
import fs from "fs";
import net from "net";
import path from "path";
import { fetchWithTimeout } from "./http";

// 本地模式默认端口（仅当无法动态分配空闲端口时的兜底）。
const DEFAULT_BACKEND_PORT = 9089;
// 运行时实际端口：本地模式由 startBackendIfLocal 每次启动动态挑选空闲端口后写入。
let activeLocalPort = DEFAULT_BACKEND_PORT;
// 供主进程（main.ts）获取本次实际端口，用于拼接前端连接地址。
export function getBackendPort(): number {
  return activeLocalPort;
}

// 本地内置账户令牌默认值。
// 注意：一键部署（local）模式下，后端必须用与前端完全相同的 builtinToken 启动，
// 否则前端 WS 握手携带的令牌与后端 BUILTIN_ACCOUNT_TOKEN 不一致，会一直被拒（4401）。
// 真正的令牌值来自 clientConfig.builtinToken（由 startBackendIfLocal 传入），此处仅作兜底。
const DEFAULT_BUILTIN_TOKEN = "kirari-local-builtin";

let child: ChildProcess | null = null;

function isDev(): boolean {
  return !!process.env.VITE_DEV_SERVER_URL;
}

// 打包版后端位于 resources/pet-api；dev 不调用本函数（startBackendIfLocal 已早退）。
function resolveBackendDir(): string {
  const resourcesPath = (process as unknown as { resourcesPath: string }).resourcesPath;
  return path.join(resourcesPath, "pet-api");
}

// 判断当前安装包是否打包了本地后端。纯前端版（frontend edition）不把 pet-api 打进
// extraResources，故 resources/pet-api/server.js 不存在 → 返回 false。
// 主进程据此在启动时将 mode="local" 强制退化为 "remote"，避免连不上本机后端而空转。
export function isBackendBundled(): boolean {
  if (isDev()) return false;
  const backendDir = resolveBackendDir();
  return fs.existsSync(path.join(backendDir, "server.js"));
}

// Node 运行时选择：优先使用打包进 pet-api/runtime 的 node（自包含，无需用户装机有 Node），
// 缺失时回退系统 PATH 的 node（要求目标机已安装匹配 ABI 的 Node）。
function resolveNodeBin(backendDir: string): string | null {
  const runtimeName = process.platform === "win32" ? "node.exe" : "node";
  const bundled = path.join(backendDir, "runtime", runtimeName);
  if (!isDev() && fs.existsSync(bundled)) return bundled;
  // 回退：检查系统 PATH 中是否有 node
  try {
    const systemNode = execSync(`${runtimeName} --version`, { encoding: "utf-8", windowsHide: true }).trim();
    if (systemNode) return runtimeName;
  } catch {
    // 系统没有 node
  }
  return null;
}

// 注入运行所需环境变量，等价于后端 .env，避免安装包依赖外部 .env 文件存在性。
// 若外层已设置（如打包机 CI 注入）则尊重外部值。
function backendEnv(builtinToken: string): NodeJS.ProcessEnv {
  // 数据库目录外置到用户目录：每台机器独立、可写、且不进安装包（避免泄露开发者自己的 token/库）。
  const dataDir = path.join(app.getPath("userData"), "pet-api-data");
  return {
    ...process.env,
    // 本地模式监听地址：回环 127.0.0.1。仅本机通信，避免 Windows 上绑 0.0.0.0 的 EACCES，
    // 也不把本地 API 暴露到局域网。分离式部署请直接运行后端（不要走本启动器），由运维自定 HOST。
    HOST: "127.0.0.1",
    // 本次启动动态挑选的空闲端口（见 startBackendIfLocal）。
    PORT: String(getBackendPort()),
    STORAGE_TYPE: process.env.STORAGE_TYPE || "db",
    MODEL_API_ENDPOINT: process.env.MODEL_API_ENDPOINT || "https://api.chatanywhere.tech/v1",
    // 关键：本地模式的 BUILTIN_ACCOUNT_TOKEN 必须等于前端 clientConfig.builtinToken，
    // 否则 WS 握手令牌与后端不一致，前端会一直被拒绝。
    BUILTIN_ACCOUNT_TOKEN: process.env.BUILTIN_ACCOUNT_TOKEN || builtinToken,
    SESSION_SECRET: process.env.SESSION_SECRET || "kirari-dev-session-secret",
    PET_API_DATA_DIR: dataDir,
    NODE_ENV: "production",
  };
}

// 让 OS 分配一个当前空闲的端口：绑定 127.0.0.1:0，读取内核分配的端口后立即关闭。
// 后端随后以严格模式绑定同一端口，TOCTOU 窗口极小，本地场景足够稳健。
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// 轮询后端 /health，直到就绪或超时。不阻塞主流程太久。
async function waitForHealth(timeoutMs = 15000): Promise<{ ok: boolean; reason?: string }> {
  const url = `http://127.0.0.1:${getBackendPort()}/health`;
  const start = Date.now();
  let lastError: string | undefined;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetchWithTimeout(url, {}, 3000);
      if (res.ok) {
        console.log("[backend] 健康检查通过");
        return { ok: true };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[backend] 健康检查超时 (${timeoutMs}ms)，最后错误: ${lastError}`);
  return { ok: false, reason: lastError };
}

// 把 userData/config.json（用户级可编辑配置文件）的模型配置同步到后端 DB。
// config.json 是「权威配置」：仅以其中「非空」的字段覆盖后端，空字段不触碰后端现有值。
// 既用于首次启动播种，也用于用户（设置界面或外部编辑器）修改 config.json 后的实时同步。
// builtinToken 用于向后端 /api/profile 鉴权（与启动后端时注入的 BUILTIN_ACCOUNT_TOKEN 一致）。
export async function applyConfigToBackend(builtinToken?: string): Promise<void> {
  const token = builtinToken || DEFAULT_BUILTIN_TOKEN;
  try {
    const cfgPath = path.join(app.getPath("userData"), "config.json");
    if (!fs.existsSync(cfgPath)) {
      console.log("[backend] 未找到模型配置（config.json），跳过同步");
      return;
    }
    let cfg: { endpoint?: string; model?: string; key?: string; searchKey?: string; searchEndpoint?: string; searchProvider?: string };
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    } catch {
      console.warn("[backend] config.json 解析失败，跳过同步");
      return;
    }
    const endpoint = typeof cfg.endpoint === "string" ? cfg.endpoint.trim() : "";
    const model = typeof cfg.model === "string" ? cfg.model.trim() : "";
    const key = typeof cfg.key === "string" ? cfg.key.trim() : "";
    const searchKey = typeof cfg.searchKey === "string" ? cfg.searchKey.trim() : "";
    const searchEndpoint = typeof cfg.searchEndpoint === "string" ? cfg.searchEndpoint.trim() : "";
    const searchProvider = typeof cfg.searchProvider === "string" ? cfg.searchProvider.trim() : "";
    if (!endpoint && !model && !key && !searchKey && !searchEndpoint && !searchProvider) {
      console.log("[backend] config.json 未填写模型配置，跳过同步");
      return;
    }

    const headers = {
      "x-builtin-token": token,
      "content-type": "application/json",
    };

    // 仅以 config.json 中的非空字段覆盖后端；空字段保持后端现状（config.json 为权威但不越界清零）。
    const patch: Record<string, string> = {};
    if (key) patch.token = key;
    if (model) patch.model = model;
    if (endpoint) patch.api_endpoint = endpoint;
    if (searchKey) patch.search_key = searchKey;
    if (searchEndpoint) patch.search_endpoint = searchEndpoint;
    if (searchProvider) patch.search_provider = searchProvider;

    const res = await fetchWithTimeout(`http://127.0.0.1:${getBackendPort()}/api/profile`, {
      method: "PUT",
      headers,
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      console.log(`[backend] 已将 config.json 同步到后端: ${Object.keys(patch).join(", ")}`);
    } else {
      console.warn(`[backend] config.json 同步到后端失败 HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(
      "[backend] 同步 config.json 到后端出错（可稍后在程序「设置」中手动配置）:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// 后端就绪后，把 config.json 的模型配置同步进后端 DB（config.json 为权威配置）。
async function seedBackendFromConfig(builtinToken: string): Promise<void> {
  await applyConfigToBackend(builtinToken);
}

// 本地模式且非 dev 时自启动后端 API。返回时后端应已在监听（或已超时告警）。
// builtinToken 必须与前端的 clientConfig.builtinToken 完全一致，否则 WS 握手令牌不匹配会被后端拒绝。
export async function startBackendIfLocal(opts: { isLocal: boolean; builtinToken?: string }): Promise<void> {
  if (!opts.isLocal) return; // 远程模式：连远程服务器，不启动本地后端
  if (isDev()) return; // dev：沿用独立运行的后端

  const builtinToken = opts.builtinToken || DEFAULT_BUILTIN_TOKEN;

  // 本地模式：每次启动动态挑选一个空闲端口，作为启动参数注入后端子进程，
  // 主进程也用同一端口连接。避免写死 9089 被占用 / 系统保留导致 EACCES。
  try {
    activeLocalPort = await pickFreePort();
  } catch {
    console.warn("[backend] 动态选端口失败，回退到默认端口 9089");
    activeLocalPort = DEFAULT_BACKEND_PORT;
  }

  const backendDir = resolveBackendDir();
  const entryFile = path.join(backendDir, "server.js");

  // ---- 启动前校验关键文件 ----
  const checks: [string, string][] = [
    ["后端入口", entryFile],
    ["后端依赖", path.join(backendDir, "node_modules")],
    ["路由模块", path.join(backendDir, "src", "api", "routes.js")],
    ["WebSocket 模块", path.join(backendDir, "src", "websocket", "socketServer.js")],
  ];
  for (const [label, p] of checks) {
    if (!fs.existsSync(p)) {
      console.error(`[backend] 缺少${label}: ${p}`);
      console.error("[backend] 后端文件不完整，跳过自启动。安装包可能损坏或 extraResources 未正确打包。");
      return;
    }
  }

  const nodeBin = resolveNodeBin(backendDir);
  if (!nodeBin) {
    console.error("[backend] 未找到 Node 运行时（打包的 runtime/ 下没有 node.exe，系统中也没有安装 Node）。");
    console.error("[backend] 无法启动后端 API。");
    return;
  }

  console.log(`[backend] 后端将监听端口 ${getBackendPort()} | HTTP http://127.0.0.1:${getBackendPort()} | WS ws://127.0.0.1:${getBackendPort()}/ws`);
  console.log(`[backend] 准备启动: ${nodeBin} server.js (cwd=${backendDir})`);
  console.log(`[backend] 注入环境变量: HOST=127.0.0.1 PORT=${getBackendPort()} BUILTIN_ACCOUNT_TOKEN=${builtinToken}`);

  // 用 pipe 捕获输出以便排查问题（之前 ignore 导致启动失败完全无日志）
  child = spawn(nodeBin, ["server.js"], {
    cwd: backendDir,
    env: backendEnv(builtinToken),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // 捕获子进程输出用于调试
  child.stdout?.on("data", (d: Buffer) => {
    const msg = d.toString("utf-8").trim();
    if (msg) console.log(`[backend:stdout] ${msg}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString("utf-8").trim();
    if (msg) console.error(`[backend:stderr] ${msg}`);
  });

  child.on("error", (e) => console.error("[backend] 子进程启动失败:", e.message));
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.warn(`[backend] 子进程退出 code=${code} signal=${signal}`);
  });
  if (child.pid) console.log(`[backend] 已启动后端子进程 pid=${child.pid}`);

  const health = await waitForHealth();
  if (!health.ok) {
    console.error(`[backend] 后端未能就绪: ${health.reason || "未知原因"}`);
    console.error("[backend] 可能的原因：端口被占用、原生模块 ABI 不匹配、缺少运行依赖。");
    return;
  }

  // 后端已就绪：用与前端一致的 builtinToken 校验「凭证有效性」——
  // 若此处用 builtinToken 访问 /api/profile 失败，说明内置令牌与后端不一致，
  // 必须立即报错（而非让前端一直用错误凭证重连）。
  try {
    const verifyRes = await fetchWithTimeout(`http://127.0.0.1:${getBackendPort()}/api/profile`, {
      method: "GET",
      headers: { "x-builtin-token": builtinToken },
    });
    if (verifyRes.ok) {
      console.log("[backend] 内置账户令牌校验通过：前端与后端凭证一致");
    } else {
      console.error(
        `[backend] ⚠️ 内置账户令牌校验失败 HTTP ${verifyRes.status}：前端 builtinToken 与后端 BUILTIN_ACCOUNT_TOKEN 不一致，` +
          `请检查 pet-client.config.json 的 builtinToken 与启动器注入的令牌是否相同。`,
      );
    }
  } catch (e) {
    console.warn("[backend] 凭证就绪校验请求出错（不影响后端运行）:", e instanceof Error ? e.message : String(e));
  }

  // 后端已就绪：把安装向导的配置播种进 DB（若用户尚未在设置里配置）
  await seedBackendFromConfig(builtinToken);
}

// 关闭前端时同步终止后端子进程及其进程树。
export function stopBackend(): void {
  if (!child) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      // /T 杀进程树，/F 强制。等同任务管理器结束进程及其子进程。
      execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
    } else if (pid) {
      // 类 Unix：detached 子进程自成进程组，负号向整组发信号。
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // 进程可能已退出，忽略
  }
  child = null;
}

// 导出当前子进程 PID（供外部查询调试）
export function getBackendPid(): number | undefined {
  return child?.pid;
}
