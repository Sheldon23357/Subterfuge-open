# 自定义 bot 开发指南

本文面向拿到 ZIP 的开发者。宿主负责连接、授权、模型传输、行动执行、真实回执和存储；你负责策略。无需下载游戏服务器源码，也无需安装 npm 编译依赖。需要 Node.js 22.13+，并使用与系统、CPU 匹配的分发包。

## 1. 从哪里开始

| 目标 | 起点 |
| --- | --- |
| 修改完整官方策略、提示词或外交判断 | 复制 `plugins/hybrid/`，编辑复制后的源码 |
| 从零写程序策略 | 复制 `examples/minimal-bot/` 到 `plugins/minimal-bot/` |
| 查公共接口 | `plugin-sdk/API.json` 与 `plugin-sdk/types/` 中的声明文件 |
| 查看最小插件的完整可运行代码 | `examples/minimal-bot/index.ts` |
| 离线检查插件 | `node tools/check-plugin.mjs plugins/minimal-bot` |

最小示例会读取授权局面、记录一次检查并结束轮次；不会下达行动或调用模型。它用于验证接线，不代表有对战能力。复制后无需修改 tsconfig：示例目录和 plugins 下的目录均与分发包根目录相隔两级。

不要修改 `runtime/`、`web/` 或宿主清单。宿主启动会校验固定文件摘要；插件目录可以编辑。插件是可信本地代码，与宿主同进程运行，不是隔离沙箱，不要加载不可信插件。

## 2. 插件目录和清单

```text
plugins/my-bot/
  bot-plugin.json
  index.ts
  tsconfig.json
```

```json
{"apiVersion":1,"id":"my-bot","name":"我的 bot","version":"1.0.0","entry":"index.ts"}
```

`apiVersion` 当前为 1。ID 应匹配 `^[a-z][a-z0-9-]{0,39}$`，与入口导出的 ID 一致，并在本机唯一。版本用三段数字；entry 是插件目录内的相对 TS/JS 路径。复制最小示例时，同时修改清单 ID、定义 ID、实例 ID，以及 `recordPrefix: 'mode-my-bot'`。

复制完整官方 hybrid 时，将清单 ID 改为自己的 ID；将复制后的 `src/plugin.ts` 改为：

```ts
import {defineHybridMode} from './index.js';
export default defineHybridMode({id:'my-bot'}, '我的 bot');
```

这样使用的是你复制后可编辑的完整实现。`src/prompts.ts` 管理固定提示词，`brief.ts` 组织模型材料，`intent-protocol.ts` 处理输出契约，`foreground.ts` 组织前台执行，`execution-guard.ts` 维护执行前守卫。完整实现分散在该目录的多个模块中，修改后应运行离线校验。

## 3. 类型与公共入口

准确结构以随包 `.d.ts` 为准；本文解释使用方式，不替代类型定义。接口与宿主版本配套，不保证不同分发版本间的二进制兼容。导入时使用公开包名，不导入 `runtime/`、仓库内部路径或开发机绝对路径。

| 导入路径 | 主要内容 |
| --- | --- |
| `@subterfuge/bot-sdk/contracts/bot-mode` | `BotModeDefinition`、`BotMode`、输入、服务与后台接口 |
| `@subterfuge/bot-sdk/contracts/types` | `AiState`、`AiSnapshot`、`AgentRequest`、`AgentResult` |
| `@subterfuge/bot-sdk/contracts` | 玩家观察、规则动作及公共配置类型 |
| `@subterfuge/bot-sdk/contracts/local-mode-context` | `buildLocalModeContext`，构建程序策略的轮次上下文 |
| `@subterfuge/bot-sdk/prediction` | 授权局面下的路线、条件预测与比较 |
| `@subterfuge/bot-sdk/analysis/tactical-worker` | `computeBot`，受控的本地战术计算 |
| `@subterfuge/bot-sdk/analysis/tactical-planner` | 规划选项、候选和决策类型 |
| `@subterfuge/bot-sdk/execution/receipt-observation` | 执行与结算证据辅助接口 |
| `@subterfuge/bot-sdk/rules` | 公共规则常量 |

完整子入口清单位于 `plugin-sdk/API.json` 的 exports。类型声明例如 `plugin-sdk/types/packages/ai/src/controller/contracts/bot-mode.d.ts`；直接打开它可查看可选钩子的完整签名。包内 TypeScript 校验器使用随示例提供的 tsconfig 解析这些声明。

## 4. 定义与实例生命周期

入口默认导出 `BotModeDefinition`。其 `id`、`label`、`capabilities` 描述插件；`validateConfig(config)` 严格校验自己的参数；`create(config)` 返回一个新的席位独占实例。

| 要求 | 说明 |
| --- | --- |
| 新实例 | 每次 create 返回新对象，不跨席位共享可变对象 |
| 能力一致 | 定义的 model/commander 能力必须分别匹配实例的 usesModelProvider/supportsCommander |
| 日志命名空间 | 实例的 recordPrefix 必须是 `mode-` 加插件 ID |
| 配置 | `settings.strategyConfig` 通过 validateConfig 后，以副本交给 create |
| 重建 | 同席位、同插件、同配置复用实例；切换插件或改变配置会建立新实例 |

实例需要提供 `id`、`recordPrefix`、能力标志、`automaticEventCoalesceMs`、`retainSignals`、`needsAnalysis` 和 `prepare`。完整最小实例已随包提供；请先跑通它再增加功能。

配置参数应检查对象类型、允许字段、范围和未知字段。不要在配置里保存模型密钥或玩家令牌；这些由宿主管理。内存变量不保证跨进程重启保留，跨轮记录使用宿主的记录接口。

## 5. 一轮决策的输入

`prepare(input)` 返回 `{context, run}`。prepare 用于构建上下文；实际异步工作放在 run 中。

| input 成员 | 怎么用 |
| --- | --- |
| state | 只读的席位状态、设置、轮次 sequence、笔记及已确认指挥官约束 |
| snapshot.observation | 当前玩家有权看到的局面；含 revision、view、据点名称映射等 |
| snapshot.task | 本轮合并的唤醒原因；可能含多个触发器，不应预拆成互不相关的小任务 |
| feedback | 本轮执行反馈；检查其实际回执状态，不能只看建议内容 |
| routes | 可选路线分析；缺失时不能当成已确认可达 |
| history | 程序侧审计材料；不能直接作为模型历史 recall 使用 |

不要修改 input 的共享对象。未知兵力保持未知，不填成零；预测和建议与已发生事实分开处理。舰队从列表消失不等于已到达或已被摧毁。使用明确的活动、回执与结算证据。

世界时间对玩家是 1 tick = 1 世界日；内部规则秒的换算应使用 SDK 常量。实时每 tick 的现实秒数由房间决定，不能把一次模型耗时或机器时钟当作世界时间。

## 6. run(request, services) 的服务

| 接口 | 用途及约束 |
| --- | --- |
| `services.local(request, compute)` | 程序计算的宿主准入；遵守暂停、取消和检查点屏障 |
| `services.model.step(request)` | 受控模型调用；共用队列、超时、用量和审计，不暴露供应商密钥 |
| `latest<T>(kind)` / `record(kind, data)` | 插件自己的持久记录；宿主添加策略前缀并按服务器、房间及席位隔离 |
| `markAssessed()` | 标记已完成本轮实际评估，不应在计算尚未完成时调用 |
| `refreshSnapshot?()` | 显式获取更新后的授权快照；可选接口，使用前判断是否存在 |
| `receipt?()` / `attemptReceipt?()` | 程序侧查账；按原请求身份确认，不生成新的请求冒充重试 |
| `readActivity?()` | 程序侧读取授权活动事实；不是给模型的无限历史工具 |

request 带有 AbortSignal。长计算和异步等待要检查 `signal.aborted` 或调用 `signal.throwIfAborted()`；不要吞掉取消继续发行动。程序计算返回 tokens: 0，不能虚构模型用量。

模型策略还需要将定义的 model 能力和实例的 usesModelProvider 均设为 true。调用必须明确提供 `responseSchema`，并校验模型 JSON 后再转换为行动建议。下面是在 run 中的调用片段：

```ts
const model = await services.model.step({
  ...request,
  prompt: '根据本轮提供的授权事实返回战略计划。',
  responseSchema: {
    type: 'object',
    properties: {plan: {type: 'string'}},
    required: ['plan'],
    additionalProperties: false,
  },
});
if (typeof model.reply.plan !== 'string') throw Error('Invalid model plan');
return {
  ...model,
  reply: {
    tool: 'finish',
    arguments: {memory: {strategy: model.reply.plan}},
    summary: '战略记录已更新，未下达行动。',
  },
};
```

该片段演示调用与校验，不包含实际局势材料。正式使用时必须自行整理本轮授权事实与结构化 context；不要只发送这条示例提示词。`ModelResult.reply` 是未经业务解释的 JSON，不能直接当作执行许可。保留模型返回的真实用量与完成信息。

## 7. 返回行动建议

run 返回 `AgentResult`，其 reply 包含 tool、arguments 和 summary。宿主负责最终校验、提交与持久化。常用形式：

```ts
// 不下达行动，完成本轮。
return {tokens: 0, reply: {tool: 'finish', arguments: {}, summary: '保持现状。'}};
```

```ts
// 仅演示格式，必须先确认来源、兵力、目标及协议限制。
return {
  tokens: 0,
  executionObservation: input.snapshot.observation,
  reply: {
    tool: 'order',
    arguments: {action: {kind: 'launch', source: sourceName, destination: targetName, drillers: 10}},
    summary: '向目标立即出兵。',
  },
};
```

据点参数使用授权完整名称，可通过 `observation.outpostNames[id]` 将稳定 ID 转换为名称；映射缺失时不要编造名称。舰队参数使用其准确 ID。`executionObservation` 必须是实际用于检查该方案的观察，不能用更新后的版本号冒充原依据。

| tool | 作用 |
| --- | --- |
| order | 一条游戏行动；具体 action 以 SDK 公共合同为准 |
| batch | 1–8 条 order，格式为 `{actions:[{tool:'order',arguments:{action:...}}]}` |
| say | 发送游戏聊天；仍受玩家聊天权限约束 |
| notebook | 更新笔记 |
| reminders | 创建、完成或取消世界时间提醒 |
| finish | 结束本轮，可附带受支持的记忆及笔记更新 |

完整可接受字段以随包契约和官方插件用法为准。网页隐藏的功能不能因底层保留某类动作就自行恢复。游戏行动成功后由服务器记录签到，不需要额外签到请求。

批次可能出现部分已执行、后续被拒绝或未知。不能把“提交成功”写成“已抵达”或“协议已履约”。结果未知时，宿主按原幂等身份查账；不要换 ID 重发，也不要把运输正常结束判为执行失败。

## 8. 可选钩子与后台

| 钩子 | 应做的事 |
| --- | --- |
| afterAction | 一条行动或批次后的确定性记账与结束轮次，不再次搜索追加行动 |
| beforeExecute | 执行前校验当前约束；拒绝矛盾方案，不偷偷修改为另一套指令 |
| onReceipt | 已持久回执的本地投影；只能查账、记录和唤醒，不调用模型或远程写入 |
| createBackground | 创建观察、暂停、排空接口齐全的后台对象，不直接下游戏指令 |
| communicate | 使用受控的聊天服务；accepted/rejected/unknown 分开处理 |
| commanderPrompt | 声明支持指挥官时提供对应提示词逻辑 |
| diagnostics | 返回只读诊断数据，控制台展示在 strategyDetails 中 |

需要后台时实现 observe、settling、pause、drain，并正确维护正在处理的工作；不要让 pause 后的旧任务继续发布。后台给前台提供意图或建议，最终写入仍通过宿主执行链。

若只是改官方行为，优先编辑复制后的 hybrid；其工厂还能替换 briefPrompt、commanderPrompt、buildBrief、planner、localPlanner 等组件。修改战略与外交不必重写授权、查账及执行系统。

## 9. 校验、加载、更新与验收

1. 解压后先双击 start.cmd，或运行 `node launch.mjs --console 4401`。默认优先 4400，已占用时选择可用端口；看终端打印的实际地址。
2. 复制示例到 plugins，修改清单及实例身份，运行 `node tools/check-plugin.mjs plugins/my-bot`。它先严格类型检查，再编译并检查实例接口；不连接游戏或调用模型。
3. 在控制台扫描插件目录。扫描只读清单，加载才执行可信代码。未绑定席位可先校验插件，游戏连接项显示待检查。
4. 在暂停席位中选择插件；需要时填写 strategyConfig，再绑定自己的游戏席位并显式启动。首次启动默认八席未绑定、暂停。
5. 先在测试局观察：模型是否真正完成、建议是否通过、回执是否接受、游戏是否实际结算。这几个阶段分别验收，不用一次 HTTP 200 代替。
6. 更新同 ID 插件前，暂停并把所有使用它的席位切换到其他插件，再重新加载更新。编辑源文件不会自动替换已安装快照；加载失败保留可诊断状态，不静默切换策略。

## 10. 常见错误

| 现象 | 排查 |
| --- | --- |
| 双击窗口退出 | start.cmd 现在会在错误时保留提示；确认 Node 安装、系统架构及完整解压 |
| 指定端口被占用 | 换一个 `--console` 端口；不结束其他应用来抢端口 |
| Host file changed | 固定宿主文件与清单不一致，恢复完整分发包；自定义代码放插件目录 |
| Unknown bot mode / Plugin unavailable | 检查清单 ID、是否已加载、编译与接口错误；不要改成别的 ID 掩盖未决操作 |
| 模块无法解析 | 使用 API.json 中的 SDK 子入口或插件内相对路径；不要依赖开发机 node_modules |
| Invalid or shared bot mode instance | 检查 create 返回新实例、recordPrefix、能力标志及 ID 是否一致 |
| 修改源码没有生效 | 查看安装快照与摘要，按同 ID 更新流程重新加载 |
| 下令被拒绝或结果未知 | 查实际回执与当前权限、归属、兵力、协议；未知操作先按原身份查账 |

分享自己的插件时，仅分享插件目录与开发说明。不要携带 data、玩家凭据、模型密钥、私有聊天或对局笔记。发布前使用无真实凭据的独立目录运行离线检查，再在测试局验证。
