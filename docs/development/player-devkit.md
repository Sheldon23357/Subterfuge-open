# 独立玩家开发包：构建、分发与验证

`--without-sdk` 只省略独立供开发者调用的 `sdk/` 产物；官方参考运行器 bundle 仍包含自身所需的 SDK 实现，不宣称整个包完全没有 SDK 代码。Python/Go 客户端及 mock/基本 smoke 则不依赖 SDK。

## 目的

将公开协议、官方参考运行器/控制台、独立客户端、可选 SDK 和离线教学工具交付为可解压运行的目录/ZIP。玩家运行该包不需要源码仓库、node_modules、游戏服务器源码、真实存档或真实凭据。Node 22.13+ 仍需外部预装。

这是一份开发工具包，不是游戏服务端发行版，也不是远程托管任意代码或模型的服务。mock 只实现明确子集；官方运行器仍有自己的完整能力要求。独立协议与策略替换的边界以 `protocol/player/v2/README.md` 为准。

## 源码构建入口

以下命令在源码仓库根执行，需要已有 Node、项目开发依赖和相应构建工具；不自动安装依赖，不读取用户真实运行目录：

```sh
node scripts/build-player-devkit.mjs
node scripts/build-player-devkit.mjs --out /path/to/new-player-devkit
node scripts/build-player-devkit.mjs --out /path/to/new-player-devkit-minimal --without-sdk
node scripts/build-player-devkit.mjs --out /path/to/new-player-devkit-directory --no-archive
```

- 默认输出为新的操作系统临时目录，并产生同级 ZIP；以命令实际输出路径为准。
- `--out` 指定目录；非空已有目录与已存在的目标 ZIP 会被拒绝，不覆盖、不清空用户文件。
- `--without-sdk` 不复制 SDK。mock、custom planner 与基本 smoke 不依赖 SDK。
- `--no-archive` 仅产出目录，不生成 ZIP。
- 本构建不发布到 registry、不部署、不打开真实对局或调用模型，也不清理用户开发存档。

发布者必须检查构建退出状态与实际归档内容，不把“目录存在”当作完整构建成功。失败时保留足够诊断，选择新输出目录重建；不要为方便而删除玩家目录。

## 分发结构

```text
player-devkit/
  README.md
  DEVELOPING.md
  FEATURE-MATRIX.md
  RELEASE-NOTES.md
  BUILD-MANIFEST.json
  SHA256SUMS
  licenses/
  custom-planner.mjs
  offline-mock.mjs
  smoke.mjs
  launch-console.mjs
  start-console.cmd / start-console.sh
  start-mock.cmd / start-mock.sh
  run-smoke.cmd / run-smoke.sh
  .env.example
  config/
    game.example.json
    ai.example.json
    development.json
    offline-console.json
  runtime/
    agent-cli.mjs
    sdk-*.js / compiler/
    protocol.mjs
  web/
    index.html
    agent-console.js
    agent-console.css
  protocol/player/v2/
  examples/bot-plugins/hybrid-copy/
  examples/player-clients/
    python/
    go/
    interop/number-vectors.json
  docs/open-client/
  docs/development/player-devkit.md
  sdk/                         # 可省略
```

复制 Python/Go 时保持目录层级：两者测试相对查找根部 `protocol/player/v2/fixtures` 和 `examples/player-clients/interop/number-vectors.json`。不要只复制测试文件到根目录后修改公共 fixtures 绕过失败。

不打包完整仓库 interop runner：它依赖真实 listener、源码编译与测试工具。包内语言单元测试仍可运行，真实跨语言 HTTP 验证留在源码测试环境。

## Bundle 的不同依赖边界

- **官方运行器**：esbuild 自包含 Node bundle，仅保留宿主及通用 prediction/engine helper 的编译代码，官方策略以完整源码插件单独提供。它不携带游戏 server 输入、engine 源码、游戏监听入口、真实 DB 或真实 credentials。不要笼统把它宣传成“完全没有引擎代码”。
- **公开 protocol helper**：仅公共 contracts 的校验/JCS，供 mock 使用；不是 SDK 或游戏规则库。
- **可选 SDK**：独立公开 transport、身份、snapshot/events、lease、outbox/receipt 等实现。它不导入官方策略、模型、记忆、engine/server。
- **mock/smoke**：不得导入 server/engine；基础运行不要求 SDK。所有数据来自公开合成 fixture，自建随机 loopback listener，不使用现有真实服务。
- **web**：真实官方静态资源，不以测试占位页替代。不要把 HTTP 200 与浏览器交互正确混为一谈。

公开协议目录应原样复制，校验值可复查。不要打包 Node、node_modules、Python/Go 编译器、游戏/AI SQLite、真实用户配置、环境文件、模型 key 或执行 token。`.env.example` 仅允许无价值占位说明。

## 启动与配置契约

解压后包根目录执行：

```sh
node launch-console.mjs
node launch-console.mjs --port 4400
node offline-mock.mjs --port 0
node smoke.mjs
node custom-planner.mjs
```

默认 console 读取 `config/offline-console.json`，使用空 `seats`、offline provider，并始终显式 `configured`。不启用 project-local 自动发现，不读取本地游戏凭据/绑定文件。控制台地址以输出为准；不自动打开浏览器。mock 独立默认 127.0.0.1:4399，`--port 0` 为随机端口，不能抢占已存在服务。

完整真实连接配置由玩家复制 `config/game.example.json` 后独立编辑；`PLAYER_EXECUTOR_TOKEN` 只作为 `tokenEnv` 引用，由玩家的受保护环境提供。启动器不自动加载 `.env.example`：

```sh
node launch-console.mjs --config /path/to/my-game.json
# 真实模型 provider 只能在用户明确选择时启用：
node launch-console.mjs --config /path/to/my-game.json --provider env
```

控制台支持扫描 `examples/bot-plugins/` 或自定义本机目录，在每个暂停席位选择插件并进行基本校验。开发包自带本平台的 TypeScript、esbuild 和完整 SDK，可用 `node tools/check-plugin.mjs plugins/hybrid` 离线校验，无需安装编译依赖。具体接口及可信代码边界见[AI 本地插件与源码扩展](ai-extensions.md)。源码开发者也可注册完整 AI；当前开发包内的 `custom-planner.mjs` 仍为离线教学工具，不会自动注入打包运行器。`config/ai.example.json` 是自定义组件组织说明，不是官方运行器配置/插件 ABI；`config/development.json` 是开发说明，不会把真实游戏配置注入 mock。真实模型和真实游戏控制权必须分别明确配置/启动。

## mock 与 smoke 的诚实边界

mock 声明 `core/2`、`actions.order/1`；仅合成单页 snapshot、pull events、session、lease、set-shields order 和 receipt/lookup。它不模拟战斗、生产、时间推进或高级扩展，不满足官方 AI 全部能力。当前 Python/Go 只要求 `core/2`，order/schedule 为可选能力；可在 mock 演练 order，但不能宣称 schedule 已测试。

故障由进程内 `createOfflineMock()` 结果的 `faultOnce('drop-before-commit' | 'drop-after-commit' | 'server-error')`、`expireLease()`、`restart()` 注入；没有 HTTP 管理路由。此 restart 是同一测试对象中的 session/fence 失效演练，不是磁盘级进程崩溃恢复。

smoke 自建随机端口并在结束关闭，避免依赖或干扰 4399 上的其他服务。默认仅需要 Node，SDK 存在时追加其恢复检查；`--python EXECUTABLE`、`--go EXECUTABLE` 显式追加独立客户端的只读/单次合成写入/重连测试，不安装编译器或下载模块。写后丢响应必须查原 key 回执，不能换 key 猜测重放。具体已运行断言以 smoke 实际输出为准，不能由文档预填通过。

## 发布验收建议

在干净、无真实凭据的隔离目录执行并记录：

1. 构建成功；目录/ZIP 文件清单、大小和校验值；公共协议与源文件一致。
2. ZIP 解压到另一目录，断开对源码仓库/工作区的路径依赖，再运行 `node smoke.mjs` 与 `node custom-planner.mjs`。
3. 默认控制台使用真实打包 HTML/JS/CSS，空席位、offline、configured；确认没有读取本地游戏绑定或发出模型请求。HTTP 静态检查不替代浏览器交互验证。
4. `--without-sdk` 产物不含 SDK，仍能运行基本 smoke/planner/console；完整包里的 SDK 单独导入检查。
5. Python/Go 单元测试与数值向量相对路径完整，按实际可用的语言环境执行并记录；也可用 `node smoke.mjs --python python3 --go /path/to/go` 显式追加独立进程的合成 HTTP 检查。不用“工具不存在”伪称通过。
6. 故障检查记录写前/写后丢响应、unknown/lookup、重复 key、旧 fence、重启等实际覆盖；未实现的扩展留为未覆盖。
7. 已有非空输出目录/ZIP 拒绝覆盖；私有配置、状态、源码和其他目录未改动。
8. 检查归档无真实 secret、数据库、node_modules、编译器或源码工作区绝对依赖；仅已授权的合成 fixture token 例外。

目标系统没有被实际测试就明确写“未验证”。Windows `.cmd` 和 POSIX `.sh` 仅说明有启动入口，不证明跨平台文件锁、SQLite、信号处理或 UI 已验证。Python/Go 当前仅声明 Linux/macOS 支持。

## 开发教程与升级

解压包根部的 `DEVELOPING.md` 是 coding 工具通用教程：空策略 → 受限 planner → 可替换 memory/model/scheduler/simulator → 故障与越权测试。所有 unknown 写入先查账；预测只能用受限观察；公开 wire fixtures 不随策略改动。

新版本放到新目录，玩家自己的策略用 template/fork 或独立目录维护，自行 merge。锁定 SDK 版本，保留私有数据与未决账本；不能靠重新下载包清除 unknown。不存在自动覆盖、自安装插件或可执行代码上传到游戏服务器的流程。

当前隐藏的资助、撤销资助、主动投降 UI 不因打包恢复。底层公共动作存在与 UI 开放是不同决定，真实 `actionAvailability` 和服务端权限始终权威。

本包不把 wire 兼容、游戏规则合规和本地代码安全合并成一个“认证”。发布说明必须列真实证据与局限；同进程自定义代码不是安全沙箱，测试通过也不代表策略水平或插件可信。

## 外交能力

实际服务器的 `diplomacy/2` 在普通持久命令中提供正式提案、响应与反提；授权观察含双向关系、当前合同和近期回执，完整回执可分页。固定 100/200 tick、签署补贴与个人履约细则见[外交协议](diplomacy-agreements.md)。开发包 mock 只宣告自身实现的能力，不因真实服务支持而声称具备完整外交结算。
