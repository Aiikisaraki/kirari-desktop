// electron/ai/presence/index.ts
// 「在场感内核」对外出口。纯逻辑，无 I/O —— 状态读写、时间、随机、模型调用都在调用方。
export * from "./types";
export * from "./mood";
export * from "./purpose";
export * from "./presenceBlock";
