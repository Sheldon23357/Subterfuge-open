# 独立游戏服务与仅游戏存档

`packages/server/src/game-server.ts` 是可导入、可单独启动的无 AI 组合入口。它不导入 AI 运行器、模型供应商、AI 配置、控制器绑定、玩家 SDK 或网页客户端。玩家 HTTP 流量统一使用 `/player/v2/*` 协议；此进程不提供网页、实验室管理、全局局面导出或模型接口。资助、撤销资助与主动投降入口保持隐藏；专家系统不在当前规则中。

## 创建服务

```ts
import { createGameOnlyServer } from "./packages/server/src/game-server.js";

const service = await createGameOnlyServer({
  store: "/explicit/game/authority.sqlite",
  access: "/explicit/owner-access.json",
  checkpointDirectory: "/explicit/checkpoints",
});
const address = await service.listen(4300, "127.0.0.1");
// 完成后调用 await service.close()，不要仅关闭 HTTP listener。
```

- `store` 接受 `RoomStore` 或数据库路径。传入对象由调用方关闭；路径创建的连接由 `service.close()` 关闭。恢复 clone 若传入 `RoomStore` 对象，首次启动还须显式提供 `restoreMarker` 路径；数据库路径模式会检查同目录标记。
- `access` 必须是明确的现有文件路径或完整 `PlayerAccessFile`；不会自动生成、轮换、写入或补齐凭证。房间 ID、席位数及凭证格式必须匹配。
- 空数据库必须由调用方明确提供 `initialRoom`，没有隐式示例局。CLI 只接受现有数据库。
- `legacyChat`、`commander` 可分别传入旧文件路径或相应 store。领域绑定使用同一个 SQLite 连接；绑定后 SQLite 是唯一权威，外部源不能覆盖权威文档。
- 启动先校验存档和凭证、建立协议 authority、处理恢复标记、绑定聊天/指挥官领域、恢复中断存档协调、同步时钟，全部完成后才返回尚未监听的 server。
- Owner 与 executor 控制、游戏命令、回执、领域内容和事件使用同一个 SQLite 权威，并在同一连接事务中提交。
- `clock` 可为 `saved`（默认）、`manual` 或 `realtime`。默认保留保存的时钟，不暗中启用自动推进。可显式设置 `remoteDeadlineMs`（1–86400000）使用有截止时间的手动回合。
- 只有显式配置 `checkpointDirectory` 时才在协议中声明 `checkpoints.coordinated/1`；未配置时仍可读取已持久的协调历史，但不宣称能发起新的协调存档。
- `now`、`elapsedNow`、`pulseMs` 与 `checkpointTimeouts` 支持隔离测试及部署配置。存档 prepare/drain/freeze/publish/resume 各阶段均有界；不依赖真实 AI 或模型调用。暂停前在同一序列队列内同步实时边界，保存不会落后一帧后在 clone 启动时意外补算。

## CLI

构建后直接运行入口，不需要启动网页或独立 AI：

```sh
node dist/packages/server/src/game-server.js serve --database /explicit/game/authority.sqlite --access /explicit/owner-access.json --port 4300 --host 127.0.0.1 --checkpoint-directory /explicit/checkpoints
node dist/packages/server/src/game-server.js export --database /explicit/stopped-game/authority.sqlite --directory /explicit/checkpoints --checkpoint-id stage-001
node dist/packages/server/src/game-server.js verify --source /explicit/checkpoints/stage-001
node dist/packages/server/src/game-server.js restore --source /explicit/checkpoints/stage-001 --destination /explicit/new-clone
```

`serve` 默认仅监听本机。监听其他网卡须显式指定 `--host` 并自行提供适当的 TLS/网络保护。HTTP 返回的启动信息不含凭证。CLI 不读取 AI 环境配置，也不启动模型工作。

CLI `export` 是停止源服务后的离线快照工具，不会为了备份领取 authority、使运行中服务失去 authority 或协调远程执行器。运行中服务应使用 `await service.checkpoints.save('stage-001', 'game-only')`；需要参与者协商时显式指定 `'coordinated'`。不要从运行中的另一进程进行离线导出。

## 存档边界

`game-only-checkpoint/1` 目录固定且仅包含：

- `authority.sqlite`：`RoomStore.backup` 在原连接执行 `VACUUM INTO` 得到的一致 SQLite 镜像，包含世界、计划、命令/事件账本、协议权威及已迁移聊天/指挥官领域。
- `manifest.json`：版本、checkpoint ID、房间/epoch、真实 tick/revision、暂停时刻、未完成命令数量，以及唯一 SQLite 文件的大小和 SHA-256。

可选协调参与者信息仅含不透明 player ID、是否支持/准备、冻结回执 ID、摘要及缺席原因。没有远程数据库路径、文件内容、配置、模型状态或 owner token。`coordinated` 不意味着全体必然到场：不支持、准备超时和冻结超时都必须保留为明确缺席，不能宣传为完整的游戏+AI 一致存档。

数据库中原有 executor grant 的哈希和历史账本仍属于游戏 authority，但明文 owner access 文件不在存档内。AI 数据库、AI 私有记忆、控制器配置/绑定、其他任意相邻文件永不复制。

导出会核对镜像的真实 room/epoch/tick/revision/未完成数量，与清单不符则拒绝。文件写入并校验完成后，以同目录原子重命名发布；已有 ID 仅可重读相同意图，不能覆盖不同存档。取消、阶段超时或旧 authority 的迟到发布会在最终发布前被拒绝。校验拒绝额外文件、符号链接、路径替换和内容损坏。SHA-256 检查完整性，不是来源签名；只恢复可信来源的存档。

## 恢复与重新连接

恢复仅写入不存在的新目录，不覆盖、删除或回滚源局，不打开 listener。目标不可放在源存档内。

1. 校验固定文件清单、摘要和 SQLite/领域完整性。
2. 复制唯一 authority 文件，在离线 clone 内 `startAuthority(..., {fork:true})`，生成并持久化新 room epoch。
3. 保留权威聊天、指挥官领域和玩家稳定身份；撤销源 epoch 的 executor grants，旧 session/fence/cursor 不可继续使用。
4. 清理复制进来的未完成存档 freeze，记录中断恢复；不假装远程参与者已恢复。
5. 平移实时锚点以保持保存的游戏时间相位，写入 `game-only-restored.json` 和同库的一次性 activation 记录，再发布整个 clone。

首次启动自动核对显式恢复标记与数据库 epoch，并将恢复完成到首次启动间的时间再平移一次。同库事务标记已激活，重启不会再次 fork 或重复平移；普通后续停机时间仍遵守保存的实时局规则。不要直接复制数据库绕过 restore，也不要直接把不可变存档当作运行数据库。

恢复目录故意没有凭证。启动 clone 时，调用方必须显式提供与房间和席位匹配的 owner access 文件，再通过已有 owner 授权流程发放新 executor grants。源 executor token 在 clone 上返回未授权，不会自动恢复控制权。源局与其原有 grants 保持不变。
