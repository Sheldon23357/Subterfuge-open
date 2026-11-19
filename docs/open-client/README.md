# 独立客户端

- [接入步骤](getting-started.md)：身份、快照、事件与一次显式操作。
- [能力与兼容边界](compatibility.md)：实现范围、数值和 unknown 处理。
- [公开 wire 契约](../../protocol/player/v2/README.md)。
- TypeScript SDK 为可选传输实现：源码在 packages/player-sdk，分发包在 sdk/（若提供）。
- [开发包](../development/player-devkit.md)。

客户端可以使用自有策略、模型、调度或纯程序状态机。官方笔记、工具与数据库结构不是第三方接入要求；服务端只接受有范围的身份、租约、版本和合法命令。
