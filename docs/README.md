# 文档导航

项目文档描述当前源码、产品约定和使用方法。功能是否开放以[功能范围](development/feature-availability.md)为准；公开请求结构以协议 schema、OpenAPI 和 wire 类型为准。

## 使用与开发

- [开发指南与文档规范](development/development-guide.md)
- [项目架构](development/architecture.md)
- [浏览器操作](development/browser-interface.md)
- [大厅与房间生命周期](development/lobby-lifecycle.md)
- [bot 控制台与运行](development/ai-runtime.md)
- [本地战术规划](development/tactical-planning.md)
- [分层协同 bot](development/hybrid-bot-guide.md)
- [指挥官讨论与确认指令](development/commander-discussion.md)
- [构建与检查](development/regression-suites.md)

## 协议与计算

- [服务器外交协议](development/diplomacy-agreements.md)
- [席位信任与玩法设计](development/seat-trust.md)
- [玩家接口索引](development/player-api.md)
- [Player Protocol 2.0](../protocol/player/v2/README.md)
- [身份、租约与人工命令](development/player-control.md)
- [独立客户端入门](open-client/getting-started.md)
- [客户端能力与兼容边界](open-client/compatibility.md)
- [公开 TypeScript SDK](../packages/player-sdk/README.md)
- [玩家开发包](development/player-devkit.md)
- [授权预测与进攻分析](development/prediction.md)
- [世界时间契约](development/world-day-time.md)

## 控制器

- [共用基础与 bot 模式接口](development/controller-bot-modes.md)
- [AI 本地插件与源码扩展](development/ai-extensions.md)
- [bot 宿主与插件分发](development/bot-distribution.md)
- [模型上下文规范](development/ai-context-refactor.md)
- [Gemini 结构化输出规范](development/gemini-schema.md)
- [执行、回执与恢复](development/ai-execution-guards.md)
- [笔记、战略与提醒](development/ai-memory-semantics.md)

## 存储与运维

- [云服务器部署与运维](development/server-operations.md)

- [持久化](development/persistence.md)
- [本机联动存档与重启](development/linked-checkpoints.md)
- [独立游戏服务](development/game-only-server.md)
- [可选远程协调存档](development/coordinated-game-checkpoints.md)
- [实时时钟与自动推进](development/realtime-clock.md)

## 规则与资源

- [规则库](rules/README.md)
- [地图生成](development/map-generation.md)
- [美术资源](development/original-art.md)
- [音频](development/audio-system.md)
- [研究来源与提取](reverse-engineering.md)
- [研究说明](research/README.md)

具体对局、测试执行和部署诊断属于本地运行报告，不作为上述文档中的现行功能或永久验收结论。
