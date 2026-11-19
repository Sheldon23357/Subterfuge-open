# 独立玩家开发包说明

## 内容

公开协议为 Player Protocol 2.0。具体构建信息以 BUILD-MANIFEST.json 和 SHA256SUMS 为准，本页不记录历次发布日志。

包包含官方运行器 bundle、官方控制台资源、公开协议及 fixtures、独立 Python/Go 客户端、离线 mock/smoke、配置模板、启动脚本与依赖许可证。可选 sdk/ 是供开发者单独导入的 SDK 产物；省略它不表示官方运行器内部没有 SDK 实现。

## 运行边界

需要自行安装 Node.js 22.13+。Python/Go 示例分别需 3.11+/1.22+，其持久化为 Unix 本地文件系统实现；启动脚本存在不等于 Windows 全流程已验证。

默认控制台为 configured、空席位、offline，不发现本机游戏，不读取实际凭据，不自动调用模型。真实连接和 provider 由使用者明确配置。

mock 仅实现 core/2 与 actions.order/1 的受限合成流程，不能运行完整官方 AI 或取代游戏规则。custom-planner 是教学代码，不是官方 CLI 动态加载插件接口或安全沙箱。

## 更换分发包

使用新目录，保留自己的策略、私有配置与 outbox。核对 manifest、摘要、wire、ruleset、能力及 SDK；按自身需要合并本地修改。不能通过删库、换 key、改 fence 或搬 epoch 解决 unknown。

每次分发另行记录实际构建、解压 smoke、控制台、语言和目标系统检查范围；本说明不预填通过数量或平台保证。包内说明描述当前方法，不附旧版本验收账本。
