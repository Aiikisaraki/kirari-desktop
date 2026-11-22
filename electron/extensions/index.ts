// electron/extensions/index.ts
//
// 扩展能力包：对外只导出这一层，主程序不要深入内部文件。

export {
    EXTENSION_API_VERSION,
    EXTENSION_METHODS,
    type Contribution,
    type ExtensionEngineSpec,
    type ExtensionEvent,
    type ExtensionManifest,
    type ExtensionPermission,
    type HostHello,
} from "./types";

export {
    ExtensionManifestError,
    discoverExtensions,
    parseManifest,
    type DiscoveredExtension,
} from "./manifest";

export { JsonRpcClient, JsonRpcError } from "./jsonrpc";

export {
    ExtensionRuntime,
    type RemoteCapability,
    type RuntimeEvent,
    type RuntimeOptions,
} from "./runtime";

export { ServiceRegistry, type ServiceDescriptor } from "./services";

export {
    ExtensionHost,
    getExtensionHost,
    getService,
    setExtensionHost,
    type CapabilityRegistrar,
    type ExtensionHostOptions,
    type ExtensionStatus,
} from "./host";

export {
    TTS_SERVICE_ID,
    getTtsService,
    type AudioFormat,
    type TtsRequest,
    type TtsService,
    type VoiceAudio,
    type VoiceInfo,
} from "./contracts/tts";

export {
    DEFAULT_VOICE_POLICY,
    buildVoiceOutgoing,
    type BotOutgoingAudio,
    type VoiceOutgoingContext,
    type VoiceOutgoingPolicy,
} from "./voiceOutgoing";
