# 深潜 / Subterfuge

可自托管的多人潜艇策略游戏，包含规则引擎、浏览器客户端、游戏服务、独立 bot 控制器和公开玩家协议。支持 2–10 人的个人采矿或统治对局，以及迷雾视图、外交、预约、条件预测和本地存档。

## 启动

需要 Node.js 22.13+ 和 npm。在项目根目录执行以下命令启动本机实验室，无需模型密钥或研究样本。

```powershell
npm ci
npm run web:dev
```

| 入口 | 命令 | 默认地址 |
| --- | --- | --- |
| 本机实验室 | `npm run web:dev` / `Start-Game.cmd` | http://127.0.0.1:4310 |
| 独立玩家网页 | `Start-Players.cmd` | http://127.0.0.1:4311 |
| 多房间大厅 | `npm run lobby:start` / `Start-Lobby.cmd` | http://127.0.0.1:4312 |
| bot 控制台 | `npm run ai:dev -- --console 4400 --store-directory runtime/independent-agent --local-game-directory runtime --local-player-port 4311` | http://127.0.0.1:4400 |

玩家入口需要对应席位凭证；实验室属于本机管理员入口。控制器连接后默认暂停，启动席位与自动推进是显式操作。端口已占用时先检查现有服务，避免重复启动。

本机试玩时，打开 `http://127.0.0.1:4310`，创建一局至少有两个手动席位的对局。多人联机请使用大厅入口，创建房间后让其他玩家从大厅加入。自托管配置见[部署与运维](docs/development/server-operations.md)。

## 文档

- [文档导航](docs/README.md)：按使用、架构、协议、规则和运维分类。
- [功能范围](docs/development/feature-availability.md)：当前开放项与有意关闭项。
- [项目架构](docs/development/architecture.md)：包边界、数据流和 bot 模式。
- [开发指南](docs/development/development-guide.md)：构建、目录约定和文档规范。
- [公开玩家协议](protocol/player/v2/README.md)：跨语言接入契约。
- [规则库](docs/rules/README.md)：当前玩法、参考参数与来源边界。

## 代码目录

| 目录 | 用途 |
| --- | --- |
| `packages/rules`、`packages/engine` | 规则配置与权威结算 |
| `packages/contracts` | 跨包类型、验证及 wire 契约 |
| `packages/prediction` | 基于授权观察的客户端预测 |
| `packages/server` | 游戏、大厅、身份、租约、命令与持久化 |
| `packages/client` | 游戏网页、大厅及控制台 |
| `packages/ai` | 共用控制器基础与独立 bot 模式 |
| `packages/player-sdk` | 与策略和引擎分离的公开协议客户端 |
| `packages/tools`、`scripts` | 场景、构建、诊断、提取和分发工具 |
| `examples`、`tests` | 配置示例、独立客户端与测试源码 |

## 构建与检查

`npm run build` 执行模块边界检查和 TypeScript 编译；`npm run web:build` 另外打包网页。测试命令和样本前置条件见[检查指南](docs/development/regression-suites.md)。文档不预填任何一次构建或测试的通过结论。

运行数据库、凭据、模型密钥、临时报告和编译产物不进入版本库。仅运行游戏不需要私有 APK 样本；原版对照与重新提取需要合法持有的固定研究样本，见[规则来源](docs/rules/05-versions-and-sources.md)。

开发期存档及协作约定见 [AGENTS.md](AGENTS.md)。

## 许可证

项目代码和经授权随仓库分发的 Subterfuge 内容采用 [MIT 许可证](LICENSE)。原版素材及代码摘录的来源见[美术资源说明](docs/development/original-art.md)和[研究说明](docs/reverse-engineering.md)。依赖和字体遵循各自的许可声明。
