# 改 AI，不改协议：独立开发教程

本指南可直接交给任意 coding 工具。它不绑定某个 IDE、模型供应商或命令行助手。先完成离线循环，真实接入和付费模型始终另行显式配置。

## 给开发工具的任务边界

- 只修改你自己的 planner、memory、model adapter、scheduler、测试和私有配置；公开 wire fixtures 是测试基准，不能通过改 fixture 迎合错误实现。
- 不读取、不上传、不记录真实 token、模型 key、私有数据库或真实存档。只把脱敏受限观察/合成 fixture 提供给工具。
- 只从完整、已校验的本席 snapshot 和已持久应用事件生成计划；保留 unknown/null/缺失的区别，不能用零填补不可见信息。
- 写入结果 unknown 时先查原逻辑 key 的回执，不换 key 重发，不凭游戏画面或兵力变化猜测成功/失败。
- 不重写游戏规则，不把本地预测视为事实，不添加绕过 v2 所有者身份校验的 header，不恢复当前隐藏的资助、撤销资助、主动投降网页入口；不重新加入已移除的专家系统。
- 不把本地函数接口声称为稳定插件 ABI 或安全沙箱；兼容、规则授权与本机代码安全分别验证。
- 只报告实际执行的命令、结果、平台和范围。离线 mock 通过不等于真实服务、所有扩展、Windows 或生产部署通过。

## 0. 先跑无凭据的基线

在解压后的包根目录执行：

```sh
node smoke.mjs
node custom-planner.mjs
node launch-console.mjs
```

控制台默认空席位、offline provider、configured 模式，无本地游戏发现；停止用 Ctrl+C。mock 的状态是合成 fixture，烟测不需要真实 token 或模型。先保留 smoke 原始输出与 Node/操作系统版本，再改自己的文件。

源码开发者的打包流程见 `docs/development/player-devkit.md`。本包的 Python/Go 目录保留原结构，所以单元测试仍能找到公共 fixtures 和 `interop/number-vectors.json`：

```sh
# 在解压后的包根目录运行；需要预先安装相应语言环境。
python3 -m unittest discover -s examples/player-clients/python -v
cd examples/player-clients/go
go test -count=1 ./...
go vet ./...
```

也可从包根目录用 `node smoke.mjs --python python3 --go /path/to/go` 明确运行两个独立客户端的合成 HTTP 只读/单次操作/重连检查；指定工具必须已经安装。当前代码将 order/schedule 作为可选能力，mock 只提供 order。

这些单元测试与合成 mock 测试不是完整仓库 interop runner。后者需要源码、服务端构建和测试工具，不包含在独立包中。Python/Go 现有锁与同步落盘实现只适用于 Linux/macOS；不要删掉锁检查来假装已支持 Windows。

## 1. 空策略：只观察，不领取控制权

自己的客户端可以先完成 discovery → hello → 身份核对 → 恢复旧账 → 完整 snapshot → exclusive events。不要为了观察而 acquire，也不要为了“跑通”伪造 readiness。

一个最小的本地空策略是 `export function plan() { return null; }`。调度器收到 `null` 就不产生新的 gameplay command。官方控制台的空席位演示则连 observation 都不读取；两者不要混淆。

身份来自独立核实的可信绑定，而不是座位编号推断。先验证 `serverId/roomId/playerId` 和 game/lobby/chat 映射，再接受 observation。`playerId` 是不透明主体，不是数字 seat。支持的 wire/ruleset/必需 capability 不相交时停止，不静默降级。

## 2. 只产生一个受限意图

打开 `custom-planner.mjs`。它导出的 `plan(snapshotDocument)`：

- 只接受完整的 `player-observation/2` 受限文档；没有 transport、token、模型客户端或数据库参数。
- 仅选择 `owner === view.player`、`visibility === 2`、未毁坏、状态已知且护盾开启的工厂。
- 返回一个 `order` 的 `kind/payload`，或者 `null`，不修改输入、不写文件、不发请求。
- 关闭护盾只是合成 fixture 练习，不是通用推荐策略。真实规则、当前 revision 和动作可用性仍由服务器判断。

```js
import {plan} from './custom-planner.mjs';
const intent = plan(alreadyVerifiedRestrictedSnapshotDocument);
// 只审查/显示 intent。这里没有 submit，也没有自动控制权领取。
```

CLI 默认从包内 `wire-examples.json` 提取 synthetic snapshotDocument：

```sh
node custom-planner.mjs
node custom-planner.mjs --snapshot /path/to/restricted-snapshot.json
```

自备输入必须是原始 `snapshotDocument` 对象，而非整个 fixture 文件、分页 envelope 或全知 world。该示例的本地 JSON 文件读取器不是严格 wire decoder；网络解析、重复键、UTF-8、深度、页完整性和 SHA-256 等检查由真正 transport 按公共协议完成。

不要把 `null` 作为 command 文件发送，也不要把合成数据中的 outpost ID 当作真实局的目标。若要在自己的真实客户端执行，请独立核对观察和用户启动意图，再由 transport 封装、持久化和发送。此文件不会被 `launch-console.mjs` 自动加载；替换官方运行器源码需要在源码项目中单独开发/构建。

## 3. 分别替换 memory、model、scheduler 和 simulator

这些都是你自己程序里的组织选择，不是服务器接入条件。`config/ai.example.json` 用于说明你可以如何命名本地组件路径，官方 CLI 不读取它来加载任意模块。

### Memory

可以不用记忆，也可以选择本地 JSON、SQLite 或其他实现。把“策略记忆”与 transport 的 immutable outbox/receipt/cursor 分开：删掉笔记不等于命令没有执行，换记忆实现不能清掉 unknown。

私有记忆只保存本席获准看到的内容；按服务器/房间/epoch/主体隔离。新 snapshot 遮蔽或省略了字段时，不能借缓存旧数据冒充当前可见事实。决定如何归档历史可以自由实现，但不能混入另一玩家的观察。

### Model

默认没有 LLM。可以先写确定性函数，再按你自己的选择接入模型。模型只接收必要的受限观察和私有策略上下文，不接收 executor token、transport 对象或 owner 凭据。

输出先解析为你自己的计划，再做结构/权限/预算复核，最后才交给 transport。模型说“成功”不是回执。真实模型使用会向选定 provider 发送输入并可能计费，必须由你显式配置；没有自动下载、安装或调用第三方模型。

### Scheduler

自己决定何时观察、重规划和停止，但 lease 是服务器控制边界。默认 paused；明确启动后才 acquire。计算本地可用时间时从 `remainingTtlMs` 扣除整个往返耗时，过期或不确定就停写；不会因收到了延迟 renew 响应而恢复一个已暂停的执行器。

不要把每次轮询都变成一次模型请求。观察变更、待决命令、用户暂停和 server deadline 需要独立处理；如果实现 readiness，必须协商对应能力并上报已完成的 `tick`；同 tick 后续事件留给下一轮，控制失效或跨 tick 后须重新完成，不能拿 `finish` 或 status 代替。

### Simulator

你可以完全不使用预测器，也可以使用自己的受限本地预测或已协商的服务器只读查询。输入只能来自已授权观察；未知隐藏数据仍是未知。预测必须标明起点/版本、范围和假设，不能把预期占领、模拟战果或终点在途写成已执行事实。

本包的 mock **不是** simulator。官方 bundle 内的既有编译后预测辅助代码也不构成第三方必须依赖的规则库。

## 4. 执行层不可省略的状态机

自己的策略有自由，自己的 transport 仍需完整处理这些边界：

1. 严格解析与版本协商。规范 decimal counter 保持字符串/任意精度整数；cursor、epoch、revision、decisionInputVersion 都不猜含义。JSON/JCS 以公开规范和向量为准。
2. 完整 snapshot。核对每页 scope/元数据/H/digest 一致，按顺序拼接 `json-text/1`，验证 digest 后整体解码；半页不是可用观察。完成 bootstrap 后再接 exclusive cursor。
3. 持久写前记录。先保存原 scope、session、fence、revision、authorization/instructions、kind/payload、logical key 与 digest，再发送。diagnostic request ID 不是幂等 key。
4. 收到 `accepted` 仅证明入账，不证明游戏效果；收到 `scheduled` 仅证明预约登记，不证明未来触发成功。以合法终态及 `effectCommitted` 为准。
5. timeout、断流、5xx 或损坏响应保留 unknown。查原 key；`history_unavailable` 不等于没执行，权威 absence 也不能让旧在途请求自动变成“可换 key 重发”。
6. 重试只允许原 immutable request 在协议允许的原 session/fence/retained coverage 下按同一 key 处理。不得替换 fence/revision 或伪造终态；新规划与旧未知操作不能混为一件事。
7. lease 失效、人工接管、凭据撤销、scope/epoch 变化、未知 required event 时停写。重新握手是恢复观察，不是自动接管，也不是旧意图重放许可。
8. 退出本地 pause 无条件生效，再尽力 release。不能依赖 release 网络请求成功才停止发送。

使用 SDK 时同样读它的 README，理解存储/锁/恢复要求。`MemoryProtocolClientStore` 只是测试工具，不适合真实未决操作。使用独立 Python/Go 时遵守其单写者、顺序 API 与本地文件系统要求。

## 5. 离线故障检查与越权边界

先运行现成 `node smoke.mjs`，再给自己的策略/transport 添加测试。`offline-mock.mjs` 的故障入口只在进程内使用：

- `createOfflineMock()` 创建独立 mock。
- `faultOnce('drop-before-commit')`、`faultOnce('drop-after-commit')`、`faultOnce('server-error')` 注入一次性传输/服务故障。
- `expireLease()` 模拟租约失效；`restart()` 模拟服务进程重启边界。

具体启动/关闭调用方式以 `smoke.mjs` 的实际代码为例，不将该 API 当作稳定公共插件接口。没有 HTTP 管理后门；不能拿此测试接口去控制真实游戏服务。

至少检查：默认不 acquire、不下令；仅己方目标；旧 fence 停写；同 key 重复不会产生第二个 mock 效果；写后丢响应只能查账；写前丢响应不能被伪称已执行；服务错误不清 unknown；重启不沿用旧 lease；错误 token、跨 scope/epoch 和不支持字段明确拒绝。mock 只证明它实现并被测试的子集，完整服务端规则、不可见目标、真实恢复、readiness 和扩展验收仍需隔离真实 listener 测试。

## 6. 三份配置与凭据边界

- `config/game.example.json`：可复制的官方运行器完整配置。只存服务器 origin、房间、映射、`tokenEnv` 引用及必要的官方 settings；占位配置不能直接用于真实局。
- `config/ai.example.json`：玩家可替换组件的文档化示例。不是 official CLI config，也不会自动调用模型或加载代码。
- `config/development.json`：本地 mock/日志/故障说明。合成环境不需要真实 key。实际 mock CLI 的端口由 `--port` 指定，不依赖任意游戏配置。
- `config/offline-console.json`：安全的空席位默认控制台配置。`launch-console.mjs` 总是显式 configured 模式。
- `.env.example`：环境变量名称与占位说明，不自动 source、不携带真实 secret。

私有配置和状态放在自己独立目录；不要写回分发包的公共 fixtures。环境变量不是沙箱：同进程不可信代码仍可能读到它们，评估插件时要按普通本机程序对待。

## 7. 验收与升级

记录使用的包版本/`BUILD-MANIFEST.json`、`SHA256SUMS`、操作系统和 Node/Python/Go 版本、实际命令与输出，以及跳过/未覆盖事项。SDK、wire、ruleset、策略四种版本各自比较，不用单一“兼容”标签掩盖范围。

新版本解压到新目录，以 template/fork 或自己维护的策略目录合并；不覆盖用户修改、私有状态或旧命令账本。将第三方组件来源、版本、许可证和已执行测试写清楚，不自动安装/运行不明插件。兼容证明不替代本地软件安全审查，也不评价策略胜率。
