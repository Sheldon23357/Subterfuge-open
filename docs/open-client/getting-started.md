# 自己编写玩家客户端

这是一套公开协议的两份独立可运行参考实现，不是“只能替换官方 AI 的模型提供商”。可以用 Python 状态机、Go 程序、自己的模型/提示词/记忆/调度器，或者完全不用模型。服务器只裁判身份、视野、控制权和合法操作。官方 notebook、finish、campaign、SQLite 布局及模型 JSON 都不是公开接入要求。

## 当前可以运行的范围

- 协议：[`protocol/player/v2/README.md`](../../protocol/player/v2/README.md)、[`schema.json`](../../protocol/player/v2/schema.json)、[`openapi.json`](../../protocol/player/v2/openapi.json)。这些是唯一 wire 规范。
- Python：[`examples/player-clients/python`](../../examples/player-clients/python)，只需 Python 3.11+ 标准库。
- Go：[`examples/player-clients/go`](../../examples/player-clients/go)，只需 Go 1.22+ 标准库。没有任何 Go 外部模块依赖。
- 两份实现都是 Linux/macOS 本地单进程参考客户端，默认只读/paused，处理一次调用后退出。不是后台持续执行器，也不偷偷启动模型。
- 产品开放范围由服务器实际 actionAvailability 和项目功能约定决定。

## 1. 明确身份，不猜座位编号

由可信房间绑定流程给出独立核实的 serverId、roomId、playerId 和完整 game/lobby/chat 映射。`playerId` 是跨 epoch 稳定的不透明主体 ID（例如 player-UUID），不能通过解析它推断游戏席位。房间压缩/重编号后，可信绑定可更新 game/lobby/chat 映射但必须保留同一主体；无法验证旧席位对应关系时历史不可用，绝不能把当前数字席位当成历史本人。保存不含凭据的 identity.json，例如：

```json
{
  "serverId": "SERVER-ID-FROM-YOUR-VERIFIED-BINDING",
  "roomId": "YOUR-ROOM-ID",
  "playerId": "YOUR-PLAYER-ID",
  "gamePlayer": 0,
  "lobbySeat": 1,
  "chatPlayer": 1,
  "chatCount": 2,
  "roster": [
    {"gamePlayer": 0, "chatPlayer": 1},
    {"gamePlayer": 1, "chatPlayer": 0}
  ]
}
```

上面是结构示例，不是可用于实际对局的身份或凭据。不要把刚收到的未校验 hello 原样复制成“可信绑定”。允许额外固定 roomEpoch；如果固定，则恢复到新世代必须由使用者明确更新绑定。默认不固定 epoch 时，客户端仍会保留旧账本并阻止旧意图在新 epoch 重放。

现有 executor grant 由你自己的安全启动环境提供给 `PLAYER_EXECUTOR_TOKEN`。凭据不进入 URL、命令行参数、日志、模型输入、本地持久账本或测试快照。仅 HTTPS 或本机 loopback HTTP 可用；不跟随重定向，也不采用环境代理。不要将 owner/admin 凭据替代 executor grant。

## 2. 先只读运行

可以把 Python 的 client.py，或完整 Go 目录复制到干净目录。运行时不需要仓库、npm 或官方 AI。

```sh
python3 client.py --origin https://YOUR-GAME-SERVER \
  --identity identity.json --state private-state.sqlite
```

```sh
go build -o player-client ./cmd/player-client
./player-client --origin https://YOUR-GAME-SERVER \
  --identity identity.json --state private-state.json
```

两者会发现版本/规则/动作能力、hello 并核对身份，保守恢复旧命令，按已持久应用的 cursor 拉事件，再在需要时完整安装快照。观察不会自动领取控制权。终端结果的 mode=paused 不代表游戏全局暂停，只表示这个客户端没有主动运行策略。

本地状态只包含本席受限快照、最多200条诊断事件和完整本地命令账本，不含 token。它仍可能包含私人游戏信息，应保存在权限受限的本地目录。Python 用 SQLite WAL + synchronous=FULL；Go 用 fsync 临时文件、rename、fsync 目录。两者拒绝对同一路径的同时写入。不要将状态目录放在不保证锁/原子替换/同步落盘语义的网络盘。

## 3. 显式提交一个自己决定的操作

自行生成只含 kind/payload 的 operation.json。`order` 的 payload 是 `{action: ...}`，`schedule` 增加 issueTick，`cancel-schedule` 使用 `{id: ...}`。动作字段及边界以 schema 为准；目标 ID 不必是 ASCII，长度按 UTF-16 单元限制。

```sh
python3 client.py --origin https://YOUR-GAME-SERVER \
  --identity identity.json --state private-state.sqlite \
  --allow-write --command operation.json
```

Go 的参数相同。只传 --allow-write 不会下令。不能将 --command 与 --resume-only 一起使用。客户端不会自动 takeover；控制忙时停止。

库模式的顺序：

1. hello 并严格验证身份/规则/能力。
2. 恢复每个旧 pending/unknown/scheduled key，完整安装 snapshot，消费持久 cursor。
3. 用户显式启动后 acquire，按服务器 remainingTtlMs 减去完整往返耗时计算保守 deadline。
4. 用任意自己的代码产生 kind/payload。prepare 先持久保存完整原始 session/fence/revision/instructions/authorization、scope、key 和 digest。
5. submit 发送一次，不换 key。只有有效终态回执才证明效果或确定拒绝。accepted 不等于已执行；scheduled 登记成功不等于将来触发成功。
6. 网络/HTTP异常先查账。CLI 会停用本地 lease；即使重启取得新 session，也不会自动重发旧操作。历史不可用仍是 unknown，不靠兵力差值猜测。即使 lookup 返回权威 absence，本地 paused、失租、过期或 token 被拒绝也不能把旧 unknown 改成 rejected/已退休；必须保留原 key，不建立替代意图。
7. 在原 session/fence 仍有效、权威 retained coverage 明确证明 absence 的场景，库提供可选 same-key retry。它只重用原 request，不能替换观察版本、授权版本或 key。默认不自动重试。
8. 退出尽力 release，并无条件本地 pause。不依赖 release 成功保证停写。

未知/accepted 结果阻止建立依赖它的新意图。跨 epoch 的旧账本保留但 blocked；不会从旧私有记忆生成“补发同一次行动”的新 key。策略层应让使用者核对无法证明的历史，再明确开始新的规划，而不是让协议层伪造已失败。

## 4. 替换策略而不是绕过权限

可以把观察交给自己的 planner/model/memory/scheduler，但 planner 最好只返回意图，不直接获得 transport token。可选本地模拟器只能使用本席已授权的输入；不要将全知游戏数据库作为方便的依赖。服务端预览或本地预测不是对未来的承诺。

纯本地例子：读取 view 中本席已知工厂状态，按自己的条件决定是否提交一个合法 set-shields 意图。也可以完全由人给 operation.json。参考客户端不内置官方作战策略、prompt、记忆数据库格式、预算审查或 finish 协议。

同进程插件与客户端拥有同等本机权限。这种结构减少意外泄露，不是恶意插件安全沙箱。服务器不接收玩家上传的可执行代码、私有模型 key 或私有记忆。远程代管模型与任意代码执行不属于当前服务能力。

## 5. 独立运行验证

先准备已有 Node/TypeScript 开发依赖、Python 及真正的 Go 编译器，然后从仓库根执行：

```sh
GO_BIN=/path/to/go PYTHON=python3 \
  node examples/player-clients/interop/run.mjs
```

脚本不安装依赖，不写 main/dist。它创建自己的临时 TypeScript 输出目录、Go可执行文件、数据库及绑定文件；用真实随机 loopback listener 和合成 fixture grants 验证两个独立进程，结束只删除自己的临时目录。不会打开实际对局、调用模型、读取用户电脑、配置真实凭据、部署或推送。

[`acceptance-evidence.md`](compatibility.md) 标明每条可实际证明的验收及未覆盖边界；[`compatibility.md`](compatibility.md) 说明版本、扩展与开放能力。
