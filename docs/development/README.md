# 开发文档

从[项目架构](architecture.md)、[功能范围](feature-availability.md)和[开发指南](development-guide.md)开始。完整主题索引在[文档导航](../README.md)。

## 修改前查阅

| 工作 | 必读 |
| --- | --- |
| 产品入口与操作范围 | [功能范围](feature-availability.md) |
| 控制器或新增 bot 模式 | [模式接口](controller-bot-modes.md)、[上下文规范](ai-context-refactor.md)、[执行守卫](ai-execution-guards.md) |
| Gemini 模型 Schema 与兼容性 | [结构化输出规范](gemini-schema.md) |
| 玩家 HTTP、SDK 或第三方客户端 | [接口索引](player-api.md)、[公开协议](../../protocol/player/v2/README.md)、[控制权](player-control.md) |
| 预测、比较、路线或候选筛选 | [授权预测](prediction.md) |
| 存储、重启或恢复 | [持久化](persistence.md)、[联动存档](linked-checkpoints.md) |
| 规则或时间 | [规则库](../rules/README.md)、[时间契约](world-day-time.md) |
| 服务器外交协议 | [服务器外交协议](diplomacy-agreements.md) |
| 席位信任与玩法设计 | [席位信任与玩法设计](seat-trust.md) |
| 构建、分发与检查 | [检查指南](regression-suites.md)、[开发包](player-devkit.md) |

## 文档维护

每个主题维护一份现行说明，直接修改相应章节。规则约定、实现状态和能力限制分别表达；请求字段以 schema 为唯一结构来源。不得把日期追加记录、旧验收数字、具体运行房间或演化方案混入使用说明。细则见[文档规范](development-guide.md#文档规范)。
