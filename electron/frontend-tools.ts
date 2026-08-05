/**
 * frontend-tools.ts
 *
 * 前端（Electron 主进程）托管的「工具注册表」。
 *
 * 设计背景：模型调用与 tool-call loop 发生在后端。为了让后端能调用「运行在前端侧的
 * 能力」（例如 MCP server 提供的工具、以及用户启用的 skill），前端在 WS 连接建立后
 * 把工具 schema 通过 `register_tools` 声明给后端；当模型命中某个前端工具时，后端通过
 * `tool_invoke` 消息回调解前端，本模块负责实际执行并把结果经 `tool_result` 回传。
 *
 * 工具来源：
 *  1) MCP server：通过 MCP 协议（streamable HTTP / stdio）列出并执行 tools。
 *  2) skill：用户启用的「可调用工具」（HTTP 接口 / 本地脚本描述），以及行为模板。
 *
 * 命名约定：所有前端工具名统一加 `frontend__` 前缀，便于后端区分「自己能执行」还是
 * 「需回调解前端」。
 */

export type McpTransport = "http" | "stdio";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  // http（streamable，2024-11-05 spec）型：端点 URL
  url?: string;
  // stdio 型：命令与参数
  command?: string;
  args?: string[];
  enabled: boolean;
}

export interface SkillToolDef {
  // 工具在模型侧的展示名（不含 frontend__ 前缀，本模块自动加）
  name: string;
  description: string;
  parameters: unknown; // JSON Schema
  // 执行方式
  exec:
    | { kind: "http"; url: string; method?: "GET" | "POST"; headers?: Record<string, string> }
    | { kind: "echo" }; // 演示用透传
}

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  // 行为模板：注入模型 system 指令（提示词形态能力）
  prompt?: string;
  // 可调用工具形态能力（绑定到工具调用）
  tools?: SkillToolDef[];
}

interface ResolvedTool {
  schema: { function: { name: string; description: string; parameters: unknown } };
  source: "mcp" | "skill";
  mcpServerId?: string;
  mcpToolName?: string;
  skillTool?: SkillToolDef;
}

// ── 运行时状态 ──
const mcpServers = new Map<string, McpServerConfig>();
const mcpTools = new Map<string, ResolvedTool>(); // key: frontend__name
const mcpSessions = new Map<string, { endpoint: string; sessionId?: string }>();

const skills = new Map<string, SkillConfig>();
const skillTools = new Map<string, ResolvedTool>();

// 用户自定义基础人格（自由文字段落）；空串表示使用后端预设人格。
// 由主进程从 config.json 载入，并在设置页保存时更新，经 WS 推送给后端。
let basePersona = "";

const FRONTEND_PREFIX = "frontend__";

function toFrontendName(raw: string): string {
  // 保证工具名符合 OpenAI function 命名（字母数字下划线）
  const safe = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  return FRONTEND_PREFIX + safe;
}

// ───────────────────────── MCP ─────────────────────────

export function setMcpServers(list: McpServerConfig[]): void {
  mcpServers.clear();
  mcpTools.clear();
  for (const cfg of list) {
    mcpServers.set(cfg.id, cfg);
    if (cfg.enabled) {
      void refreshMcpServer(cfg); // 异步拉取工具，不阻塞
    }
  }
}

export function getMcpServers(): McpServerConfig[] {
  return Array.from(mcpServers.values());
}

async function refreshMcpServer(cfg: McpServerConfig): Promise<void> {
  try {
    if (cfg.transport === "http" && cfg.url) {
      const session = await ensureMcpSession(cfg.url);
      const listed = await mcpJsonRpc(cfg.url, session.sessionId, "tools/list", {});
      const tools = (listed?.result?.tools ?? []) as Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
      for (const t of tools) {
        const fnName = toFrontendName(`mcp_${cfg.name}_${t.name}`);
        const resolved: ResolvedTool = {
          source: "mcp",
          mcpServerId: cfg.id,
          mcpToolName: t.name,
          schema: {
            function: {
              name: fnName,
              description: t.description || `MCP 工具（${cfg.name} / ${t.name}）`,
              parameters: t.inputSchema || { type: "object", properties: {} },
            },
          },
        };
        mcpTools.set(fnName, resolved);
      }
      console.log(`[frontend-tools] MCP server "${cfg.name}" 载入 ${tools.length} 个工具`);
    } else if (cfg.transport === "stdio" && cfg.command) {
      // stdio 型：spawn 子进程并通过 stdio 做 JSON-RPC（简化：仅支持一次性 tools/list）。
      const listed = await callStdioMcp(cfg);
      for (const t of listed) {
        const fnName = toFrontendName(`mcp_${cfg.name}_${t.name}`);
        mcpTools.set(fnName, {
          source: "mcp",
          mcpServerId: cfg.id,
          mcpToolName: t.name,
          schema: {
            function: {
              name: fnName,
              description: t.description || `MCP 工具（${cfg.name} / ${t.name}）`,
              parameters: t.inputSchema || { type: "object", properties: {} },
            },
          },
        });
      }
      console.log(`[frontend-tools] MCP server(stdio) "${cfg.name}" 载入 ${listed.length} 个工具`);
    }
  } catch (e) {
    console.error(`[frontend-tools] 刷新 MCP server "${cfg.name}" 失败:`, e instanceof Error ? e.message : String(e));
  }
}

async function ensureMcpSession(url: string): Promise<{ endpoint: string; sessionId?: string }> {
  const existing = mcpSessions.get(url);
  if (existing) return existing;
  // initialize 握手，拿到 session id
  const res = await mcpRawPost(url, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "kirari-desktop", version: "0.3.2" },
    },
  });
  const sessionId = res.headers["mcp-session-id"];
  const session = { endpoint: url, sessionId };
  mcpSessions.set(url, session);
  // 发送 initialized 通知
  await mcpRawPost(url, sessionId, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  return session;
}

async function mcpJsonRpc(
  url: string,
  sessionId: string | undefined,
  method: string,
  params: unknown,
): Promise<any> {
  const res = await mcpRawPost(url, sessionId, { jsonrpc: "2.0", id: Date.now(), method, params });
  if (res.body?.error) {
    throw new Error(`MCP ${method} 错误: ${JSON.stringify(res.body.error)}`);
  }
  return res.body;
}

async function mcpRawPost(
  url: string,
  sessionId: string | undefined,
  payload: unknown,
): Promise<{ body: any; headers: Record<string, string> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  const hdr: Record<string, string> = {};
  resp.headers.forEach((v, k) => (hdr[k.toLowerCase()] = v));
  let body: any = {};
  if (text) {
    // 可能是 SSE（data: {...}）或纯 JSON
    if (text.includes("data:")) {
      const lines = text.split("\n").filter((l) => l.startsWith("data:"));
      const last = lines[lines.length - 1]?.replace(/^data:/, "").trim();
      if (last) body = JSON.parse(last);
    } else {
      body = JSON.parse(text);
    }
  }
  return { body, headers: hdr };
}

async function callStdioMcp(cfg: McpServerConfig): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  // 简化 stdio 实现：spawn 子进程，发送 initialize + tools/list，读取首次 JSON-RPC 响应。
  // 仅演示性支持，复杂 server 可能需要持续的消息循环。
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cfg.command!, cfg.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
      let step = 0;
      const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1 && msg.result) {
              send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
              send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
            } else if (msg.id === 2 && msg.result) {
              resolve(msg.result.tools ?? []);
              child.kill();
            }
          } catch {
            /* ignore */
          }
        }
      });
      child.on("error", (e) => reject(e));
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kirari-desktop", version: "0.3.2" } },
      });
      setTimeout(() => {
        child.kill();
        resolve(tools);
      }, 4000);
    } catch (e) {
      reject(e);
    }
  });
}

// ───────────────────────── skill ─────────────────────────

export function setSkills(list: SkillConfig[]): void {
  skills.clear();
  skillTools.clear();
  for (const s of list) {
    skills.set(s.id, s);
    if (s.enabled && Array.isArray(s.tools)) {
      for (const t of s.tools) {
        const fnName = toFrontendName(`skill_${s.name}_${t.name}`);
        skillTools.set(fnName, {
          source: "skill",
          skillTool: t,
          schema: {
            function: {
              name: fnName,
              description: t.description || `技能工具（${s.name} / ${t.name}）`,
              parameters: t.parameters || { type: "object", properties: {} },
            },
          },
        });
      }
    }
  }
}

export function getSkills(): SkillConfig[] {
  return Array.from(skills.values());
}

// 启用中的 skill 行为模板（提示词形态），供注入模型 system 指令。
export function collectSkillPrompts(): string[] {
  const prompts: string[] = [];
  for (const s of skills.values()) {
    if (s.enabled && s.prompt && s.prompt.trim()) {
      prompts.push(`【技能：${s.name}】\n${s.prompt.trim()}`);
    }
  }
  return prompts;
}

// 用户自定义基础人格：设置后写入、读取，供 chat-session 经 WS 推送给后端。
// 空串表示未设置，后端会回退到预设人格。
export function setBasePersona(value: string): void {
  basePersona = typeof value === "string" && value.trim() ? value.trim() : "";
}

export function collectBasePersona(): string {
  return basePersona;
}

// ───────────────────────── 对外聚合 ─────────────────────────

// 返回当前所有可用前端工具的 OpenAI function-calling schema（供 register_tools 发送）。
export function collectToolSchemas(): Array<{ function: { name: string; description: string; parameters: unknown } }> {
  const all = new Map<string, ResolvedTool>([...mcpTools, ...skillTools]);
  return Array.from(all.values()).map((t) => t.schema);
}

// 执行一个前端工具（被后端 tool_invoke 回调触发）。返回字符串结果。
export async function executeTool(frontendName: string, args: Record<string, unknown>): Promise<string> {
  const resolved = mcpTools.get(frontendName) || skillTools.get(frontendName);
  if (!resolved) {
    return `前端无此工具：${frontendName}`;
  }
  try {
    if (resolved.source === "mcp" && resolved.mcpServerId) {
      const cfg = mcpServers.get(resolved.mcpServerId);
      if (!cfg) return `MCP server 不存在：${resolved.mcpServerId}`;
      if (cfg.transport === "http" && cfg.url) {
        const session = await ensureMcpSession(cfg.url);
        const res = await mcpJsonRpc(cfg.url, session.sessionId, "tools/call", {
          name: resolved.mcpToolName,
          arguments: args || {},
        });
        return JSON.stringify(res?.result ?? res ?? {});
      }
      return `stdio 型 MCP 工具需在连接时预执行（当前回调解暂未实现单次 tools/call）`;
    }
    if (resolved.source === "skill" && resolved.skillTool) {
      const t = resolved.skillTool;
      if (t.exec.kind === "echo") {
        return JSON.stringify({ echoed: args });
      }
      if (t.exec.kind === "http") {
        const method = t.exec.method || "POST";
        const resp = await fetch(t.exec.url, {
          method,
          headers: { "Content-Type": "application/json", ...(t.exec.headers || {}) },
          body: method === "GET" ? undefined : JSON.stringify(args || {}),
        });
        const text = await resp.text();
        return text || `HTTP ${resp.status}`;
      }
    }
    return `无法执行工具：${frontendName}`;
  } catch (e) {
    return `前端工具执行错误：${e instanceof Error ? e.message : String(e)}`;
  }
}
