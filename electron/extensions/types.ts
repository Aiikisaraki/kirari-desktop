// electron/extensions/types.ts
//
// 外部扩展包（extension pack）的**通用宿主契约**。
//
// 设计目标：这是一层"外接能力"的插槽，不是"语音功能"。语音只是第一个使用者。
// 以后要加本地 ASR、翻译、画图引擎、新的协议通道，都走同一套契约，宿主不再改。
//
// 四条前提，决定了下面每个类型为什么长这样：
//
//   1. **不装包 = 行为完全不变**。宿主永远先问"有没有这个服务/能力"，没有就走
//      原来的路径。所以所有消费点都必须能接受 null（见 services.ts 的空对象）。
//
//   2. **扩展包是独立进程**（sidecar），不是被 import 的模块。语音栈的现实依赖是
//      onnxruntime / torch / ffmpeg，和 Electron 的 ABI、asar 只读特性天然冲突
//      （better-sqlite3 已经踩过这个坑，才有了 asarUnpack）。独立进程还换来崩溃隔离
//      和独立升级 —— 语音包崩溃不该把桌宠一起带走。
//
//   3. **宿主只认两个通用动词**：service.call 与 capability.call。
//      不为"语音"写专用 RPC。业务语义由 contribution id 表达（如 speech.tts），
//      由宿主里对应的消费方去解释。
//
//   4. **manifest 是不可信输入**。command 只允许包目录内相对路径，权限要显式声明
//      并在安装时展示给用户。
//
// 版本策略：宿主只加载 apiVersion <= EXTENSION_API_VERSION 的包。破坏性改动必须
// 升版本号，老包会被明确拒绝（而不是半死不活地加载进来）。

/** 宿主支持的扩展包 API 版本。破坏性变更时 +1。 */
export const EXTENSION_API_VERSION = 1;

/**
 * 权限声明。装包时必须原样展示给用户 —— 一个"语音包"要不要联网、要不要读麦克风，
 * 用户有权在装之前就知道。
 */
export type ExtensionPermission =
    | "network"
    | "filesystem:models"
    | "filesystem:data"
    | "microphone"
    | "camera";

/** 引擎启动方式。第一版只有 stdio 上的 JSON-RPC。 */
export interface ExtensionEngineSpec {
    runtime: "sidecar";
    /** 通信协议标识，宿主按这个派发 client 实现 */
    protocol: "jsonrpc-stdio@1";
    /** 相对扩展包根目录的可执行文件/脚本；禁止绝对路径与 .. 逃逸 */
    command: string;
    args?: string[];
    /**
     * 附加环境变量。宿主会过滤掉 PATH / NODE_OPTIONS 这类会影响进程自身的键，
     * 只允许扩展包注入自己的配置。
     */
    env?: Record<string, string>;
    /** 普通请求的默认超时（毫秒） */
    requestTimeoutMs?: number;
    /** 空闲超时（毫秒）：这么久没请求就回收进程，下次用到再拉起 */
    idleTimeoutMs?: number;
}

/**
 * 扩展包向宿主申报的一项贡献。
 * 宿主不会因为不认识某个 type 就拒绝加载整包 —— 未知贡献忽略即可，
 * 这样新包可以用上老宿主还不支持的贡献，而不至于完全不可用。
 */
export type Contribution =
    /** 服务：宿主里某个消费方按 id 去取。例：speech.tts / speech.stt / translate */
    | { type: "service"; id: string; title: string; description?: string }
    /** 能力：直接变成模型可调用的工具（注册进 capabilities/registry） */
    | {
          type: "capability";
          id: string;
          title: string;
          description?: string;
          /** JSON Schema，决定模型怎么填参数 */
          parameters?: Record<string, unknown>;
      }
    /** 设置：扩展包自己的配置项，由设置界面统一渲染 */
    | { type: "settings"; id: string; title: string; schema?: Record<string, unknown> }
    /** 通道：新的对端接入方式（协议端/传输），由 adapter 层消费 */
    | { type: "channel"; id: string; title: string; description?: string };

/** 扩展包清单（manifest.json）。 */
export interface ExtensionManifest {
    /** 反向域名风格，如 com.example.local-tts */
    id: string;
    name: string;
    version: string;
    /** 目标宿主 API 版本 */
    apiVersion: number;
    description?: string;
    engine: ExtensionEngineSpec;
    contributions: Contribution[];
    permissions?: ExtensionPermission[];
    resources?: {
        minRamMb?: number;
        gpuRecommended?: boolean;
    };
}

/** 宿主在握手里回给扩展包的上下文。 */
export interface HostHello {
    apiVersion: number;
    hostName: "kirari-desktop";
    hostVersion: string;
    /** 数据目录（可写），扩展包放模型缓存用它；程序目录是只读的 */
    userDataDir?: string;
    /** 宿主语言，扩展包可据此挑默认音色/默认语言 */
    locale?: string;
}

/**
 * JSON-RPC 方法名（写死，便于文档、测试与向后兼容判断）。
 *
 * 注意这里**没有**任何业务方法：宿主只调下面这些通用动词，
 * 具体能力通过 serviceId / capabilityName 参数表达。
 */
export const EXTENSION_METHODS = {
    /** host → sidecar：握手 */
    hello: "host.hello",
    /** host → sidecar：存活探测 */
    ping: "host.ping",
    /** host → sidecar：优雅退出 */
    dispose: "host.dispose",
    /** host → sidecar：调用某个服务的方法 { serviceId, method, params } */
    serviceCall: "service.call",
    /** host → sidecar：调用某个能力 { name, args } */
    capabilityCall: "capability.call",
    /** host → sidecar：拉取能力清单（含参数 schema） */
    capabilityList: "capability.list",
    /** sidecar → host：事件通知 { type, payload } */
    event: "host.event",
} as const;

/** sidecar 主动抛给宿主的事件。 */
export interface ExtensionEvent {
    /** 命名空间化的事件名，如 speech.tts.progress */
    type: string;
    payload?: unknown;
}
