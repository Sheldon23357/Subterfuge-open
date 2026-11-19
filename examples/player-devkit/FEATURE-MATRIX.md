# 功能、规则与验证范围

`--without-sdk` 只省略独立供开发者调用的 `sdk/` 产物；官方参考运行器 bundle 仍包含自身所需的 SDK 实现，不宣称整个包完全没有 SDK 代码。Python/Go 客户端及 mock/基本 smoke 则不依赖 SDK。

本表描述交付边界，不是“全部测试通过”清单。测试结论必须另附实际命令、平台、日期和结果；公开 `conformance.json` 包含跨整个项目的证据索引，不能据其存在就宣称本包 smoke 覆盖全部断言。

## 组件能力矩阵

| 项目 | 独立包提供什么 | 不代表什么 |
| --- | --- | --- |
| 公开协议 | v2.0 README、schema、OpenAPI、golden fixtures 和 conformance 要求索引 | 未知 major/minor 或缺少必需能力时停止，不自动回退。 |
| 官方参考 AI | 自包含 Node 运行器 bundle、官方控制台 HTML/JS/CSS | 不包含游戏 server 运行器或游戏数据库；不是任意策略的动态插件宿主。 |
| 官方预测辅助逻辑 | 官方 bundle 保留运行器已有的编译后 prediction/engine helpers | 不分发 engine 源码，不要求第三方依赖官方预测器，不将其等同无引擎 mock。 |
| 安全默认控制台 | 空席位、configured、offline provider，需显式绑定/启动 | 不发现本地游戏，不生成真实 grant，不自动跑模型；客户端 paused 不等于全局游戏暂停。 |
| 可选 SDK | 自包含公开 transport/存储 SDK、声明及说明，可整个省略 | SDK 不是接入许可；mock 与基本烟测不得依赖它。没有发布到公共 registry 的隐含承诺。 |
| Python / Go | 各自独立标准库客户端、CLI 源码、单元测试、共享公开数值向量 | 不附编译器；既有持久化实现 Unix-only，不承诺 Windows/NFS 或常驻后台调度。 |
| 自定义策略 | 读取受限 snapshotDocument，返回一个己方可见工厂 set-shields 意图或 null | 不直接发命令、不保证真实动作合法、不证明策略质量，不是稳定 ABI/沙箱。 |
| 配置 | 分开游戏、AI 组件说明、开发说明，以及空席位默认控制台 | 不自动读取 `.env.example`，不自动合并三份配置，不含真实 secrets。 |
| 离线 mock | 下表列明的合成 HTTP 状态机与故障注入 | 不是真正游戏规则、持久数据库或完整玩家 listener 替代品。 |
| smoke | 独立随机端口 mock、公开协议交互及实际打包控制台资源检查 | 不等于真实 UI 交互/截图、完整 listener 验收、真实游戏/模型或跨平台验收；语言检查仅在显式选项且工具可用时运行。 |

## mock 精确支持范围

发现响应只宣告 `core/2`、`actions.order/1`。所有路径相对 `/player/v2`：

| 路径/行为 | mock 范围 |
| --- | --- |
| `GET /protocol` | 明示合成规则集 `offline-synthetic-demo/1`、版本、限额和唯一 set-shields 动作。 |
| `POST /sessions/hello` | 版本/能力协商、合成身份与当前 session；拒绝无法满足的 required capabilities。 |
| `GET /snapshot`、`POST /snapshot/{id}/complete` | 固定合成受限文档的单页 bootstrap、digest 和完成记录；不是多页压力验收。 |
| `GET /events` | exclusive-after pull events 与合成 cursor 覆盖；没有 SSE。 |
| `GET /control`、`POST /control/{acquire,renew,release}` | 合成控制租约、session/fence 与幂等操作边界。 |
| `POST /commands` | 唯一游戏示例是 `order` → 自己、`visibility === 2`、未毁据点的 `set-shields`；不开放其他命令。 |
| `POST /commands/lookup` | 进程内命令回执、逻辑 key 去重与查账，区分已提交效果和未知传输结果。 |
| `faultOnce(...)` | 一次性的写前丢响应、写后丢响应、服务错误；仅测试进程内调用。 |
| `expireLease()`、`restart()` | 租约失效与 session/fence 失效演练。restart 保留此 mock 对象内账本，不是进程崩溃后的磁盘持久化。 |

mock 默认 `127.0.0.1:4399`，`--port 0` 可选随机端口；只接受自身公开的 synthetic token。合成 token 不是 secret，不能用于真实服务。没有 HTTP 管理入口，不读取真实凭据环境变量。

以下 **不支持、不宣告**：战斗、航行、生产、真实 tick 推进、schedule/cancel-schedule、聊天、通知、commander、readiness/barrier、status、查询 worker、SSE、协调 checkpoint、游戏存档恢复、生产级持久性或完整规则仿真。不要靠增加虚假的 capability 字符串让客户端“握手通过”。

官方 AI 需要额外能力，默认控制台刻意不绑定 mock。当前 Python/Go 源码只要求 `core/2`，将 `actions.order/1`、`actions.schedule/1` 作为可选能力，因此可以用本 mock 演练只读和 order，不应尝试未协商的 schedule。`node smoke.mjs --python python3 --go /path/to/go` 会明确启动已安装的外部工具，检查两种独立进程的只读、一次合成写入与重连。默认 smoke 不自动探测或启动这些编译器。

已有 `docs/open-client/compatibility.md` 关于“固定要求 schedule”的叙述属于较早范围，当前能力以客户端源码及实际 hello 为准。完整真实跨语言 HTTP 验证仍需源码项目的隔离真实 listener，不能被此合成子集替代。

## 故障含义

| 检查 | 可证明的性质 | 不能推导的结论 |
| --- | --- | --- |
| 正常 shield 命令与查账 | 合成效果可从终态回执核对 | 真正战斗或完整游戏动作已正确实现。 |
| 同 key 再次提交 | 在 mock 保留范围内不新增第二个效果 | 网络具备“exactly once delivery”。 |
| drop-after-commit | 响应丢失时先保持 unknown，再由原 key 找到效果 | 每次超时都已执行，或客户端可以换 key。 |
| drop-before-commit / server-error | 不能凭没有成功响应宣称效果，需按原 key 查账 | 一次 absence 就允许抛弃原 intent 并建立替代 key。 |
| lease 过期/重启 | 旧 session/fence 不再有效，需要重新握手和显式控制权流程 | 当前游戏真重启、跨机器持久恢复或真实 checkpoint 已验证。 |
| 错误 token / 不支持动作 | 此合成服务按当前实现拒绝 | 所有跨席位、跨 epoch、隐藏实体和错误泄漏路径均已覆盖。 |
| 静态资源能加载 | 打包真实官方资源且可由控制台服务提供 | 浏览器交互、视觉布局、可访问性或所有操作系统都已验收。 |

## 游戏规则与产品开放范围

规则、协议和 UI 开放不是同一件事：

- 真实服务器 `/protocol` 的 `rulesetId/rulesetVersion/actionAvailability` 是当前房间的声明；能力协商不授予 scope，玩家必须仍持有对应授权。
- 当前产品不开放网页中的资助、撤销资助和主动投降入口；专家系统已移除。
- 公开 v2 协议保留 `toggle-funding`、`resign` 底层动作；它们是否可执行由真实房间的动作公告与服务端验证决定。此包 mock 不支持这些动作。协议不提供专家动作。
- 官方 notebook、finish、campaign、提醒、模型队列、战略预算及自然语言指示理解属于官方策略，不是第三方加入游戏的前提。服务端的 scope、fence、revision、instructionsVersion 和 owner 确认边界不能被策略替换取消。

## 三类结论要分别写

1. **Wire 兼容**：写出实际测试过的版本、能力、错误和恢复场景。
2. **游戏规则合规**：真实服务器在真实请求时裁判；mock 不取代裁判。
3. **本地软件安全**：说明代码来源、依赖、权限和审查范围。可运行用户代码不是安全沙箱，兼容徽章不是安全审计，更不保证高胜率。

包内 `docs/open-client/` 描述当前接入方法。实际归档与目标平台检查单独记录，不能由说明文档代替。
