# 开发指南

## 环境与构建

需要 Node.js 22.13+、npm 和项目依赖。`node:sqlite` 由 Node 提供。Python 3.11+ 用于研究提取和独立客户端；Go 示例需要 Go 1.22+。运行游戏不要求私有研究样本。

```powershell
npm ci
npm run build
npm run web:build
```

`build` 包含模块边界与 TypeScript 检查；`web:build` 另外打包游戏、大厅和控制台资源。SDK 与开发包分别使用 `npm run sdk:build`、`npm run devkit:build`。测试入口见[检查指南](regression-suites.md)，不要把编译或 HTTP 200 当作功能验收。

## 开发服务

- `npm run web:dev` 监听网页内容变化并重建前端；游戏后端源码变化需要重启服务。
- `npm run ai:dev -- --console 4400 ...` 默认只监听控制台前端，后端源码变化不会自动重启控制器。隔离开发时可显式加 `--backend-reload` 启用后端热重启；普通冷启动仍默认暂停。
- 活跃对局上的游戏与控制器后端更新采用[联动存档及重启](linked-checkpoints.md)，避免无协调地单边重启。
- Windows 测试局用 `node scripts/quick-restart.mjs` 自动协调两边，保留对局和运行意图；`--dry-run` 只读检查，显式 `--new-game --bots 6 --provider minimax` 才新建六人测试。构建复用、更新开关及验收边界见[协调重启](linked-checkpoints.md#协调重启)。
- 本机回环请求绕过代理，保留外部模型所需代理；不要全局清空网络环境。

## 目录清理

在项目根目录运行 `cleanup-runtime.bat`，按中文提示选择保留对局，再逐组决定是否删除运行历史、报告与预览、构建产物、研究派生产物和可重建依赖。每组显示完整候选列表、大小和后果；回车跳过，`s` 逐项选择，`q` 退出。工具不会强制结束游戏或 AI 进程，清理前应按[联动重启流程](linked-checkpoints.md#协调重启)收尾并关闭服务。

```powershell
# 只读预览，自动选中列表中的最新对局，不写报告或删除文件
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-runtime.ps1 -DryRun
# 指定保留目录后，仍逐组交互确认
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup-runtime.ps1 -KeepGameDirectory runtime/<对局目录>
npm run test:cleanup
```

对局清单只读查询 SQLite 活动房间，以权威时间锚点、同房间运行记录和新局记录排序，不按目录名称或文件修改时间判断。遇到无法读取的候选存档会停止清理。默认保留列表第一项，可改选其他对局；选中目录内的数据库、WAL、凭证、绑定、AI 私库及阶段存档完整保留。分开的 `game/` 与 `agent/` 目录同时保留，旁边的旧备份仍可清理。对局直接位于共享运行根目录时，单独保护状态文件、`independent-agent/` 与 `checkpoints/`，其余旧对局目录仍列入候选。无法确认关联的外置控制器目录应先归入完整对局目录后再清理。

只删除限定目录中未被 Git 跟踪的内容。每次删除前重新检查项目边界、保留范围和 Git 状态；目录链接仅移除链接本身，不递归访问目标。清理结果记录在 `runtime/.cleanup/`。原始研究包 `research/packages/`、来源文件、正式美术音频、源码、测试及 `.git` 不列入候选。删除研究派生产物后，原版对照需要重新按[提取流程](../reverse-engineering.md#重建)准备；删除依赖后需要重新安装。

`outputs/` 和 `artifacts/` 是本地输出目录，整体由 Git 忽略；实验数据通过研究脚本重新生成。可复用工具放在 `scripts/`，不要把一次性对局修复、进程编号、旧源码副本和执行记录提交到版本库。旧入口 `scripts/Clear-DevelopmentArtifacts.ps1` 转交同一交互工具，`-WhatIf` 等同只读预览。

两项只读分析工具接收明确的 AI 私库目录和输出目录，不再依赖固定历史对局：

```powershell
node scripts/analyze-bot-runtime.mjs runtime/<对局目录>/independent-agent outputs/runtime-analysis
node scripts/analyze-bot-search.mjs runtime/<对局目录>/independent-agent outputs/search-analysis
```

运行效率分析可追加控制台地址采样在线状态；不提供时仅分析数据库。搜索分析需要先构建，`--frozen` 复用输出目录现有 `analysis.json` 的每席日志截止号。搜索选择、命令接受和实际结算分别统计，不将回执关联推断成实际战果。

## 修改规范

先查[功能范围](feature-availability.md)。保持身份、可见性、资源、版本、幂等和事务检查；未知写入先查原回执，不改键重发。bot 的公共能力放进 controller，策略分别放进 modes。增加工具需同步参数验证、元数据、执行分类、说明及回执语义，不能仅增加提示词名称。

配置示例只放占位符，不带真实令牌或模型密钥。使用独立目录、临时端口和合成身份进行隔离工作；不改正常存档来满足检查。

## 文档规范

1. **写当前状态。** 标题按主题命名；直接解释现有行为、操作方法、输入输出、约束和能力限制。
2. **每个主题一份主文档。** 索引只负责导航；其他文档引用主说明，不复制整份字段表或配置规范。
3. **按事实来源撰写。** 功能开放依据用户决定，行为依据源码，公开结构依据 schema/OpenAPI/wire 类型，默认值依据实际定义。猜测和未实现设计不得写成现有能力。
4. **删除流水账。** 不追加“某日修复”“第几轮”“旧版如何”“本次通过多少项”、部署房间、历史性能数字或提交演化过程。修改正文对应章节，删除被替代结论。
5. **区分必要版本标识与版本历史。** 当前协议、规则 profile、数据格式和能力名称需要准确保留；不保留旧接口教程或迁移路线作为现行用法。源码确实接受的输入边界可以说明，不扩写为演化叙事。
6. **操作可执行。** 命令从明确目录执行，路径和端口与当前入口一致；示例不含秘密，注明必要前置条件及效果。
7. **结论有边界。** 条件预测不称真实事实；有限搜索不称最优；构建不称测试通过；单局结果不称整体强度结论。缺少证据就明确未知。
8. **运行记录单独存放。** 具体测试、基准、部署和对局诊断记录放本地 `runtime/` 或 `outputs/`，不混入长期功能文档。研究来源保留在研究说明及机器可读来源中。
9. **联动更新。** 改接口、目录、配置或功能范围时同步主说明、索引、示例和文档生成器；移除文档时修复引用，不保留空壳跳转。
10. **提交前静态核对。** 核对本地链接、源码路径、命令与接口表。检查记录应说明实际范围，不预填“全部通过”。使用 `npm run check:docs` 检查文档标题、本地链接/锚点与协议要求索引；该命令不访问网络或运行游戏、构建和测试。

[文档导航](../README.md)是全项目入口；[规则库](../rules/README.md)区分本地玩法与固定参考数据；[公开协议](../../protocol/player/v2/README.md)是第三方 wire 契约的唯一规范入口。
