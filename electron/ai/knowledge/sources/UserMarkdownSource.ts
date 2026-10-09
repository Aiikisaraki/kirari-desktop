// electron/ai/knowledge/sources/UserMarkdownSource.ts
// 兼容别名：用户私有知识库（Layer 1）统一由 DBKnowledgeSource 读取。
// 保留此文件仅为向后兼容——旧清单若引用 type=user_markdown 不致崩，直接委托过去。
//
// 由 kirari-core/src/knowledge/sources/UserMarkdownSource.js 迁入。

import { DBKnowledgeSource } from "./DBKnowledgeSource";

export const UserMarkdownSource = DBKnowledgeSource;
export default UserMarkdownSource;
