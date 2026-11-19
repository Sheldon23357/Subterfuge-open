# 独立客户端能力与兼容

## 实现范围

| 实现 | 依赖 | 范围 |
| --- | --- | --- |
| Python 示例 | Python 3.11+ 标准库，Linux/macOS | 串行 API、持久 outbox/cursor、快照、事件、控制和显式命令 |
| Go 示例 | Go 1.22+ 标准库，Linux/macOS | 同类核心流程，独立实现序列化与持久化 |
| TypeScript SDK | 公开 SDK 与调用方存储适配器 | 传输、scope、协商、租约、快照、事件与账本 |
| 官方 bot 控制器 | SDK、controller 基础及具体模式 | 策略、模型、私有笔记、运行调度与讨论 |

Python/Go 默认只读，完成一次连接/核对后退出，不是长驻策略 daemon。持久化使用 Unix 文件锁及本地文件系统，不承诺 Windows 或 NFS 语义。SDK 不依赖官方策略、模型、engine 或 server。

只要求核心能力；写入、预约及其他扩展须按实际协商检查。示例没有因为规范描述 Commander、readiness 或 checkpoint 就自动实现这些扩展。

## 版本与身份

wire 结构、ruleset、动作可用范围、策略和 SDK 版本分别判断，不能仅凭 wire 相同继续过时计划。当前公开 wire 为 2.0，不提供旧 HTTP 回退。准确结构和已实现能力以 [公开协议](../../protocol/player/v2/README.md)为准。

serverId、roomId、roomEpoch、playerId 与 game/lobby/chat 映射都需核实。稳定 playerId 不等于数字座位；压缩映射必须来自权威身份流，不能根据名字猜。

## 严格数值与解析

协议 counter 使用至多 78 位规范十进制字符串，不能转为 binary64。cursor、revision、session 和 decisionInputVersion 是不透明值。

JCS 按 UTF-16 代码单元排序，使用 ECMAScript binary64 最短往返格式，负零转零，Unicode 不正规化。两份示例独立实现，不调用 Node 或官方 SDK。严格解析拒绝重复键、非法 UTF-8、孤立代理项、非有限数及深度/字节超限。缺失、null、0、空数组和 unknown 保持不同。

## 恢复

| 情况 | 行为 |
| --- | --- |
| 超时、断流、损坏写响应或 5xx | 持久保留 unknown，停止新增写入，查原 key |
| found accepted | 等待最终回执，不说效果已提交 |
| retained terminal receipt | 记录相应已提交/拒绝事实，不扩写成战略成功 |
| 有覆盖的 absence | 不自动换 key；还需满足原 fence 退休与后续权威核对规则 |
| history_unavailable | 仍为未知 |
| 失租、撤权、旧 fence | 停写，握手不等于自动接管 |
| revision/instructions 冲突 | 保存拒绝并刷新，由策略新规划，不篡改旧 intent |
| cursor 失效 | 重新安装快照，保留命令账本 |
| epoch 变化 | 保留旧账本，阻止跨 epoch 重放 |
| 同版本回执冲突或效果倒退 | 明确停止，不覆盖已确认事实 |

## 贡献与检查

从 schema、OpenAPI 和 fixtures 开始，默认只读，先实现持久账本与 unknown 恢复再接策略。用合成身份和独立端口验证分页、覆盖、丢响应、失租、重启、跨 epoch、超大 counter 与 JCS 字节。

真实执行记录放单独运行报告；本页不预填测试数量、冻结提交或通过状态。mock、真实 HTTP、目标平台和长期运行是不同检查范围。可替换本地策略不是代码沙箱，也不证明高胜率或安全性。
