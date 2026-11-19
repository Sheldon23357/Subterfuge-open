# 独立玩家 AI 开发包

`--without-sdk` 只省略独立供开发者调用的 `sdk/` 产物；官方参考运行器 bundle 仍包含自身所需的 SDK 实现，不宣称整个包完全没有 SDK 代码。Python/Go 客户端及 mock/基本 smoke 则不依赖 SDK。

这个目录的发布产物是一份可解压后独立运行的开发包。它让玩家在不取用游戏服务器源码、真实对局数据库、模型密钥或真实执行凭据的前提下，先验证客户端接入，再修改自己的策略。

公开接入契约是 `/player/v2`，不是官方 AI 的 prompt、`finish`、notebook 或数据库格式。SDK 可选；你可以使用独立 Python、Go 客户端或完全自写客户端。

## 先分清三个入口

1. **查看官方控制台**：`node launch-console.mjs`。启动真正的官方控制台及静态资源，但默认空席位、`configured` 模式、`offline` provider；不会自动寻找本地游戏、领取控制权或调用模型。
2. **跑离线开发检查**：`node smoke.mjs`。在随机 loopback 端口运行合成 mock，检查公开协议关键路径与打包控制台资源。没有真实对局或模型调用。默认不要求 SDK、Python 或 Go；完整包存在 SDK 时会追加其恢复检查。
3. **改自己的策略**：`node custom-planner.mjs`。读取公开合成 fixture，打印一个己方据点的意图，不执行它。再看 [DEVELOPING.md](DEVELOPING.md) 的逐步教程。

默认控制台不自动连到 mock。这是刻意区分“官方控制台已打包”和“mock 的核心 wire 子集”：mock 不是完整游戏服务器，也不保证满足官方 AI 的全部扩展能力。

## 环境与最短启动

- 预先安装 Node.js **22.13 或更新版本**，并确保 `node` 在 PATH。包内不带 Node、npm 依赖目录或编译器。
- 解压整个包到可写的独立目录，然后在该目录运行命令。仅启动 JavaScript 入口不需要 `npm install` 或源码构建。
- Python 参考实现需要 Python **3.11+**；Go 参考实现需要 Go **1.22+**。两者只使用标准库，但其现有持久化/锁实现仅针对 **Linux/macOS**。提供 Windows 启动脚本不表示 Python/Go 客户端或整个发布包已在 Windows 实测。

```sh
node --version
node smoke.mjs
node custom-planner.mjs
node launch-console.mjs
```

`launch-console.mjs` 输出实际控制台地址，打开该地址；不承诺固定控制台端口。它不会自动打开浏览器。停止前台服务使用 Ctrl+C。需要指定端口可用：

```sh
node launch-console.mjs --port 4400
```

快捷脚本：Windows 使用 `start-console.cmd`、`start-mock.cmd`、`run-smoke.cmd`；Linux/macOS 可用 `sh start-console.sh`、`sh start-mock.sh`、`sh run-smoke.sh`。Node 必须已经可用。脚本只启动包内入口，不安装软件、不接入真实游戏。

## 包内内容

| 路径 | 用途与边界 |
| --- | --- |
| `runtime/agent-cli.mjs` | 官方运行器的自包含 Node bundle。保留官方策略、私有状态逻辑及其已有预测/引擎辅助代码；不是服务器进程，也不是可替换策略插件宿主。 |
| `runtime/protocol.mjs` | 仅公开 contracts 的 wire 校验/JCS bundle，供 mock 使用。它不是 SDK、游戏引擎或规则裁判。 |
| `web/` | 真实官方 `index.html`、`agent-console.js`、`agent-console.css` 静态资源，不是占位页面。 |
| `protocol/player/v2/` | 原样公开规范、OpenAPI、schema、golden fixtures 与兼容断言索引。 |
| `sdk/` | 可选独立 Node SDK；用 `--without-sdk` 构建时没有此目录。查看其中的 README 和 package.json。 |
| `examples/player-clients/python/` | 无 SDK 的 Python 标准库客户端及单元测试。 |
| `examples/player-clients/go/` | 无 SDK 的 Go 标准库客户端、CLI 源码及单元测试。 |
| `examples/player-clients/interop/number-vectors.json` | 两种独立实现使用的确定性数值测试向量，保留原相对路径。不是完整仓库 HTTP 验收 runner。 |
| `offline-mock.mjs`、`smoke.mjs` | 合成状态机与离线故障检查；不导入 server/engine，也不依赖 SDK。 |
| `custom-planner.mjs` | 纯函数规划示例，只输出意图。没有模型、transport 或 token 参数。 |
| `config/`、`.env.example` | 分开的游戏/AI/开发配置与环境变量占位说明；无真实密钥。 |
| `docs/open-client/` | 独立客户端使用说明、能力和兼容边界；目标平台检查另行记录。 |
| `docs/development/player-devkit.md` | 打包、分发、隔离验证与升级边界。 |
| `BUILD-MANIFEST.json`、`SHA256SUMS`、`licenses/` | Bundle 输入/依赖边界、逐文件校验值及已打包依赖的许可证。 |

不包含 Node 本体、`node_modules`、Python/Go 编译器、游戏服务端或 engine 源码、真实游戏/AI 数据库、真实配置目录、真实执行凭据、模型 API key。官方 bundle 中已有的编译后预测代码，不改变这些边界；它与无引擎 mock 的性质不同。

## 单独启动 mock

```sh
node offline-mock.mjs
# 默认仅监听 127.0.0.1:4399；端口已占用时会报错，不替换已有服务。
node offline-mock.mjs --port 0
# 让操作系统选择可用端口，以实际输出为准。
```

mock 使用 `fixture-room` 和公开、无价值的合成测试身份。它只使用自身的合成 token 常量，不读取真实 `PLAYER_EXECUTOR_TOKEN` 或模型 key。不要将 mock 暴露到公网、接入真实凭据或把它的“效果”当作真实规则仿真。

故障注入只提供进程内测试 API，没有公开 HTTP 管理路由。`smoke.mjs` 自行创建、关闭随机端口 mock；无需另开 `start-mock`，也不会借用默认 4399 上的已有服务。覆盖范围和不能证明的事情见 [FEATURE-MATRIX.md](FEATURE-MATRIX.md)。

预先安装 Python/Go 后，还可以明确让 smoke 启动两种独立客户端，测试只读、一次显式合成操作和重新连接：

```sh
node smoke.mjs --python python3
node smoke.mjs --go /path/to/go
node smoke.mjs --python python3 --go /path/to/go
```

这些选项不安装工具、不联网拉取 Go 模块；Go 会用指定编译器把包内源码编译到临时目录。Python/Go 当前只要求 core/2，将 order/schedule 作为可选能力；mock 只提供 order，不能在这里测试 schedule。已有 `docs/open-client/compatibility.md` 中固定要求 schedule 的历史叙述不适用于当前客户端源码。

## 修改策略，不修改协议

```sh
node custom-planner.mjs
node custom-planner.mjs --snapshot /path/to/restricted-snapshot.json
```

`--snapshot` 输入是已经完整组装、校验过的受限 `snapshotDocument`，不是 `snapshotPage`、世界导出、私有数据库或带 token 的配置。示例选取本席、未毁坏且护盾当前开启的工厂，返回关闭护盾的 `order`；没有符合条件的已知状态就返回 `null`。这只是贯通数据结构，不是战略建议，也不证明该操作此刻会被真实服务器接受。

不要将 stdout 未经审查直接交给真实客户端。示例不执行意图；它也不是官方运行器的动态加载接口、稳定插件 ABI、安全沙箱或真正的规则模拟器。

## 真正连接游戏时再显式配置

默认示例不会连接真实游戏。要使用官方参考 AI：

1. 从可信绑定流程取得正确的服务器、房间、game/lobby/chat 映射及专用 executor grant。不要用 owner/admin token；不要把刚收到的未核对 hello 当作可信身份来源。
2. 将 `config/game.example.json` 复制为你自己的配置，替换所有占位值；运行器仅支持 v2，无需协议选择字段。私有状态目录独立存放，不复用其他房间的旧 outbox。
3. 通过你自己的受保护环境提供 `PLAYER_EXECUTOR_TOKEN`。`.env.example` 只是说明，不会被启动器自动加载。不要把 token 写进配置正文、URL、命令行参数或提交到版本库。
4. 先用离线 provider 启动并检查配置。要启用真实模型，再明确选择 `--provider env`、配置所选 provider 的环境变量并检查费用与数据发送范围。
5. 确认房间的 actionAvailability、观察与绑定后，才显式启动该席位。`paused` 是本客户端没有主动策略运行，不是全局游戏暂停。

```sh
node launch-console.mjs --config /path/to/my-game.json
# 上一步仍使用 offline provider；以下命令才明确选择环境中的真实 provider。
node launch-console.mjs --config /path/to/my-game.json --provider env
```

模型/记忆/调度可完全替换，但不得绕过服务器的 scope、lease、fence、revision、授权及指挥官确认检查。`config/ai.example.json` 是玩家组件组织示例，**不是**官方 CLI 自动读取的插件清单。

Python/Go 的真实连接方式另见 [开放客户端指南](docs/open-client/getting-started.md)。两者默认只读，必须同时明确 `--allow-write --command ...` 才请求新操作；参考 fixture 意图不是你对真实对局的授权。

## 升级与安全

将新版本解压到新目录，对比 [RELEASE-NOTES.md](RELEASE-NOTES.md)、`BUILD-MANIFEST.json`、`SHA256SUMS`、协议/规则/能力版本及你的私有修改，再自行迁移。不要覆盖 `private`/`.private`、自定义策略或未决命令账本；其他 epoch 的意图不能通过换 key 搬到新局重放。

任何同进程第三方代码都可能拥有本机进程权限，接口隔离不等于安全沙箱。不要把本地私有记忆、执行凭据或模型 key 发给游戏服务器、论坛、代码助手或未经核实的插件。兼容测试只说明被测协议行为，不是安全审计、策略质量或无作弊认证。
