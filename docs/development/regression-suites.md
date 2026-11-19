# 构建与检查

## 入口

| 命令 | 范围 |
| --- | --- |
| npm run check:docs | 文档标题、链接/锚点和协议索引的静态核对 |
| npm run build | 模块边界与 TypeScript 编译 |
| npm run web:build | 构建并打包网页 |
| npm test | 全部默认测试，包含打包 |
| npm run test:quick | 默认测试中除打包组之外的部分 |
| npm run test:package | SDK、开发包、依赖分发检查 |
| npm run test:serial | 默认测试按文件串行 |
| npm run test:reference | 固定原版样本的独立对照 |

已完成当前构建可直接 `node scripts/run-tests.mjs`，支持 `--suite=full|quick|package`、`--concurrency=1..32`、`--list` 与编译后的文件/目录路径。无效选项或空集合报错，不以零项代表通过。

默认从当前 `tests/*.test.ts` 选择对应产物，不把移动后残留 dist 当现行测试。默认并发最多四路且不超过可用 CPU；指定低并发可减少与本机游戏争用。需要串行协调的收敛测试由运行器单独阶段处理，任一阶段失败传播总退出码。

Windows 下，较深的隔离构建目录可能使测试文件列表超过进程命令行长度限制；运行器按长度自动分批，保持项目工作目录、文件顺序和各阶段并发设置，任一批失败仍返回非零退出码。

## 分层与证据

GitHub Actions 在 Windows 和 Ubuntu 上用 Node.js 22、24 安装锁定依赖、核对文档、检查清理工具、打包网页并运行默认测试。

quick 与 package 互斥并组成默认集合。局部工作选择相关文件；改构建、SDK或分发需包含 package，完整验收使用完整集合。默认测试验证本项目契约，不等于原版正确性。

原版对照需合法恢复与 `docs/rules/data/build-manifest.json` 哈希相同的 `research/analysis/javascript/index-DgdyVR_2.js`。缺文件或哈希不符明确 NOT RUN/失败，不替换为其他样本，不伪称通过。

使用临时数据库、随机端口与合成身份，不触碰正常对局、实际凭据或付费模型。fake provider 只能证明相应运行逻辑，不是模型效果证据。构建、静态检查、HTTP 可用、浏览器交互、真实策略完成及长期性能分别报告。

上下文编码与压缩回放在构建后执行：

```powershell
node --test dist/tests/model-data.test.js dist/tests/hybrid-model-material.test.js dist/tests/hybrid-model-numbers.test.js dist/tests/prompt-context.test.js
node scripts/verify-model-context-compression.mjs outputs/<完整调用采样目录> outputs/<回放输出目录>
```

采样目录须包含 `capture.json`、保存的输入原文及 `details/<调用编号>.json` 中的完整请求、响应 Schema 和输出。回放逐份核对输入哈希、严格解码、候选和来源数值、任务及硬约束、合同与回执、身份还原和查询权限；对职责排除使用明确路径与条件白名单核验，不允许以排除记录任意跳过事实比较。数值展示调整另外核对字段范围、绝对误差不超过 0.0005、非零正负及审计与实际正文一致，再还原原值作事实比较。按职责分别统计三部分及完整提示词的实际字符，并记录每次调用的去重、职责排除与精度调整。字符节省与历史输出身份等价不能替代真实模型的策略能力对照，真实模型对照作为单独授权的运行实验记录，不混入默认测试。

上述冻结提示词回放只覆盖已保存材料的编码、精度与去重阶段；没有原始授权观察时，不能重建当前视野或当前职责的材料选择，也不能把重编码后的旧材料称为当前完整提示词。视野边界另由 `tests/hybrid-model-vision.test.ts` 验证：战略、外交、指挥官转译和讨论均排除视野外地图事实，补查及新目标枚举一致，最近来源等派生信息不重新带入视野外实体，原始文字、合同和实际记录继续保留。实机验收需比对同一当前观察的可见集合与新调用原文。

## 记录规范

长期文档只保留执行方法、测试组织和限制，不保留固定通过数量或某次全绿声明。具体执行记录放本地 outputs/runtime，列出命令、源码范围、环境、结果和未覆盖项。未执行就不写通过；单次基准和单局胜利不推广为普遍结论。

检查方式应与本次任务和用户要求一致。文档调整可使用链接、路径和接口表静态核对，不需要因此启动对局或真实模型。
