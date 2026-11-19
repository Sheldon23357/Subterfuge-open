# 可选协调存档协议

游戏服务可以单独运行。默认 `save(id, 'game-only')` 只保存游戏 authority，不等待玩家、官方 SDK、AI 进程或任意远程数据库。完整入口、离线工具与恢复步骤见 [独立游戏服务](game-only-server.md)。

`GameCheckpointCoordinator` 是同一 SQLite authority 上的可选协调层。它不读取、上传、复制、验证或恢复远端 AI 私库、模型配置、模型密钥或记忆内容。参与者最多提交一个本地回执标识和一个 SHA-256 摘要。摘要是参与者的声明，不是服务器对远端文件存在性或完整性的保证。

## 启用与责任边界

- 服务端显式提供 `host.checkpoints` 才协商 `checkpoints.coordinated/1`。客户端在 hello 中声明此可选能力；未声明的客户端不被视为支持。
- 存档开始只由本地、已授权的宿主调用 `service.checkpoints.save(checkpointId, 'coordinated')`，没有授予 executor 全局存档创建权的公共 HTTP 路由。
- 每席选择当前 boot 内仍有效、协商此能力的最新 session。参与者不需要 gameplay lease，但每次 ACK 都重新验证 grant、session、epoch、authorizationVersion 及当次选定身份。
- `checkpoint.*` 事件是 `required:false` 的可选事件。只支持 core 的客户端可以安全忽略它们；冻结期间服务端写屏障仍然生效，不依赖客户端自行守规。
- 不要求使用官方 SDK。支持者须自行实现本地准备、冻结及恢复；仅发送 hello 能力字段不代表实现了本地存档逻辑。

## 有限阶段

默认 prepare、drain、freeze、publish 各 5000 毫秒，resume 2000 毫秒。每阶段可显式配置 1–120000 毫秒，使用持久截止时间和进程单调计时，不能无限期阻塞游戏。新 checkpoint 创建前，在同一串行队列先同步宿主时钟；实时局暂停区间通过锚点平移排除。显式启用的 `remoteDeadlineMs` 仍按服务器单调截止计时，不被存档延长；暂停只阻止执行，恢复后已到期的回合可正常推进。

1. `preparing`：暂停时钟并挡住新游戏动作/接管，通知协商过的参与者准备。已有 accepted 操作可以完成；现有 lease 可续约/释放，状态、就绪和 worker 讨论仍可更新。未到场记录 `prepare_timeout`，未支持记录 `unsupported`。
2. `draining`：等待所有 accepted 操作，不仅游戏命令。协调模式排空超时则中止；仅游戏模式允许在清单中明确保存未决数量，并保留权威账本，恢复的新 epoch 按既有规则终结这些未决操作。
3. `freezing`：所有业务写入被阻挡。准备好的参与者将自己的本地状态持久化并提交不透明回执及摘要。未及时提交者记录 `freeze_timeout`，不会被虚报成功。
4. `publishing`：在同一 authority 连接备份完整数据库。宿主发布器必须在原子发布前检查 AbortSignal 和 `beforePublish` 守卫；超时、关闭、旧 attempt 或旧 authority 都不允许迟到发布。
5. `resuming`：游戏存档已发布，通知已冻结参与者恢复。等待上限后仍未回复者在持久协调状态标记 `resume_timeout`，然后解除服务端屏障。不可变存档清单描述冻结时的状态，不会事后重写为恢复清单。
6. `completed` 或 `aborted`：释放暂停并持久保留结果。重启在 listener 启动前解冻中断阶段并标记 `server_restart`；已发布且持久记录了结果的存档保留 completed，仍可按原 ID 重放；克隆恢复标记 `restored_clone`。不会假定远端进程也已恢复。

缺席不会被隐藏。因此带缺席的 coordinated 清单是“游戏快照 + 已收到的本地状态声明”，不是完整分布式原子快照。支持者必须为自己本地的等待设置有限期限，并能在断链后自行恢复。

## HTTP 与幂等

使用已授权 executor bearer token：

- `GET /player/v2/checkpoints/current` 返回当前活动协调状态，空闲时 `checkpoint:null`。
- `GET /player/v2/checkpoints/current?checkpointId=ID` 或 `GET /player/v2/checkpoints/ID` 查询历史状态。后续存档不会覆盖旧回执。
- `POST /player/v2/checkpoints/ack` 提交严格字段集：`checkpointId`、`roomEpoch`、`sessionId`、`authorizationVersion`、`phase`。
- phase 为 `prepared`、`frozen` 或 `resumed`。仅 frozen 必须额外带 `receiptId` 和小写 64 位十六进制 `sha256`。其他 phase 不得携带它们，不接收路径、任意文件或附加私有 payload。

状态响应只含全局阶段、截止时间、未决数量、缺席汇总和调用者自己的 participant 状态（含选中 `sessionId:string|null`），不含其他席位的回执或摘要。客户端仅当选中 sessionId 与自己当前 hello 的 sessionId 相同，才可首次 ACK，不能把新会话查询到的旧 prepared 状态认作自己已准备。自身已提交的 ACK 即使响应断链也可随后查询，或使用相同 checkpoint/session/phase 重放。相同 frozen 回执返回原结果，不同 receiptId/sha256 返回幂等冲突。没有已提交记录的过期 ACK 被拒绝，不能写进下一次 checkpoint。

同 ID、同模式的存档调用重放原结果；不同模式冲突。中止 ID 不可重新代表新尝试，先查询旧状态，再选择新 ID。当前实现每 epoch 保留至多 512 条记录，达到上限拒绝新增，不静默删除用于未知结果恢复的旧记录。

## 故障与持久化

协调状态、阶段和 ACK 存在游戏 authority 的 SQL domain 文档中；业务事务和事件共用连接。内存只追踪运行中的 Promise/AbortController，不是存档权威。读和更新总是重读 SQL，因此外层回滚和其他 authority fencing 不会被内存缓存覆盖。
