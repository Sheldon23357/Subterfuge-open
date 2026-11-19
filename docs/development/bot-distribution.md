# bot 宿主与插件分发

## 组成与边界

独立 bot 分发包由打包宿主、公开 SDK 和可编辑策略组成。宿主负责玩家连接、模型准入、执行校验、回执、持久化及暂停恢复；官方 hybrid 的完整战略、外交、提示词及前台协同实现位于 `plugins/hybrid/src/`，不编入宿主文件。候选计算、预测与通用规划属于 SDK 提供的宿主计算服务，插件可调用或替换自己的策略实现。

打包宿主采用压缩 JavaScript，不附项目实现源码或 source map。宿主文件默认只读，启动校验文件摘要，检测误改；这些措施不能阻止本机所有者修改程序，也不是代码安全沙箱。游戏服务器继续校验身份、权限和规则。插件校验及加载会运行可信本机代码。

独立分发包不包含游戏服务器、真实配置、登录状态、模型密钥、对局数据库或用户笔记。`data/` 在用户运行时创建。开发者自己修改过的插件、临时测试文件与额外资源不会因目录整体复制而进入发布包；官方插件源码按构建器的清单复制。

## 构建

在仓库根目录安装依赖后执行：

```sh
npm run bot:release -- --out /absolute/path/SubterfugeBot
```

同时生成该目录及相邻 ZIP，已有目录或 ZIP 一律拒绝覆盖。`--no-archive` 只生成目录。构建包含 TypeScript 和模块边界检查；打包器另检查宿主的构建输入不包含 `plugins/`、游戏 server 或仓库参考组装入口。

分发包包含构建平台的原生 esbuild 编译器，`BUILD-INFO.json` 记录操作系统和 CPU。macOS、Linux、Windows 分别在对应目标环境构建；不把一个平台的编译器复制给其他平台。接收者仍需安装 Node.js 22.13+，选择 Codex 模型另需安装并登录 Codex CLI；无需 npm install 插件编译依赖。

```text
SubterfugeBot/
  start.sh / start.cmd
  launch.mjs
  runtime/                 打包宿主、计算服务及编译器
  web/                     控制台资源
  plugin-sdk/              公共声明与接口清单
  plugins/hybrid/src/      完整、可编辑的官方策略
  tools/check-plugin.mjs
  licenses/
  HOST-MANIFEST.json
  BUILD-INFO.json
  SHA256SUMS
```

第三方许可和通知随实际使用的依赖复制并记录摘要。`HOST-MANIFEST.json` 覆盖固定运行文件，排除插件与用户数据；`SHA256SUMS` 描述初始分发内容，编辑插件后该初始清单不再代表插件当前版本。公开发布和授权条款由发布者另行确定，本地打包不自动完成代码托管、签名或软件发布。

## 接收者运行与修改

分发包附带[自定义 bot 开发指南](../../examples/bot-release/DEVELOPING.md)和 `examples/minimal-bot/`，覆盖插件接口、轮次服务、行动与回执、类型检查及加载更新流程；指南从打包模板复制，不要求接收者访问仓库。最小程序插件只读取授权局面并结束轮次，用于验证接口接线，不代表对战强度。

运行 `start.sh` 或 `start.cmd`，打开打印的本机控制台地址。默认优先使用 4400，占用时选择可用回环端口；显式 `node launch.mjs --console 4401` 使用指定端口，冲突时报告错误。Windows 启动失败保留窗口显示错误；`--store-directory` 可指定私有数据目录。首次启动由同一个目录加载器安装官方 hybrid，八个槽位均未绑定、保持暂停。绑定游戏后，由用户显式启动。

修改 `plugins/hybrid/src/` 后先执行：

```sh
node tools/check-plugin.mjs plugins/hybrid
```

该工具使用随包提供的编译器，先执行严格类型检查，再编译并检查配置、实例与基本接口，不连接游戏或调用模型。需要自定义配置的插件仍需在控制台填写参数并校验。编译转译与类型检查是不同步骤，目录扫描仅读取清单，不执行代码。

插件安装为不可变快照；修改源文件不立即改变运行中席位。先暂停并将使用该 ID 的所有槽位切换到其他插件，再从控制台显式重新加载。已加载快照损坏或缺失时拒绝启动，保留诊断，不用内置策略替代。更新 SDK 或宿主后，插件作者应重新运行校验与行为回归；API 版本检查不证明策略语义兼容。

## SDK

`@subterfuge/bot-sdk` 根入口提供模式与轮次契约；计算、上下文、规则和预测通过清单中的子入口提供。准确入口以 [exports.json](../../packages/bot-sdk/exports.json) 为准，安装清单和加载校验以 [plugin-catalog.ts](../../packages/ai/src/application/plugin-catalog.ts) 为准。策略开发与生命周期约束见[插件扩展](ai-extensions.md)。

SDK 发布内容为完整声明依赖闭包、Node 类型依赖及接口清单，不复制宿主实现源码。`npm run bot:sdk -- --out /absolute/path/plugin-sdk` 可单独生成 SDK。分发包中的 `plugins/hybrid/tsconfig.json` 已指向该 SDK，编辑器可直接检查类型；新增插件文件夹可沿用对应设置。

`@subterfuge/hybrid` 指向随包提供的开源策略 API，定制者可复用 `defineHybridMode` 或替换其中组件；它不指向宿主内的另一份策略。SDK 运行服务由宿主加载器绑定，不能把声明包当作独立运行器直接调用。
