# 玩家接口索引

## 协议来源与角色

公开执行器基址为 `/player/v2`。准确请求体、错误和能力定义见[公开协议](../../protocol/player/v2/README.md)、[OpenAPI](../../protocol/player/v2/openapi.json)、[schema](../../protocol/player/v2/schema.json)及 `packages/contracts/src/player-protocol-wire.ts`。本页只按用途导航，不维护第二套字段 schema。

owner 凭证和 executor grant 是不同角色。服务器从凭证确定身份与 scope，不信任请求自行声明的玩家或控制器身份。game/lobby/chat 映射分别核对，playerId 为不透明授权主体，不是座位号。

## 执行器入口

下表路径相对于 `/player/v2`；可选能力必须完成协商。

| 方法与路径 | 用途 |
| --- | --- |
| GET /protocol | 版本、能力、规则和实际动作范围 |
| POST /sessions/hello | 版本/能力协商与新会话 |
| GET /snapshot | 固定观察切面分页 |
| POST /snapshot/{snapshotId}/complete | 完成快照安装 |
| GET /events | exclusive-after 事件分页轮询 |
| GET /control | 当前租约及指定会话状态 |
| POST /control/acquire、/control/renew、/control/release | 取得、续约、释放控制 |
| POST /commands | order、schedule、cancel-schedule、chat-send、chat-seen、readiness |
| POST /commands/lookup | 原幂等键批量查账 |
| GET /diplomacy/receipts | 本人参与的外交回执及合同摘要，分页与权限过滤 |
| GET /activity | 本人可见实际活动事实 |
| GET /tick-times | 服务器 tick 边界分页及当前已过时间；`tick-times.read/1`，需要 observe scope |
| GET /manual-commands | 已接受人工命令及保护事实 |
| GET /chat、/chat/search | 授权聊天分页与检索 |
| GET /notifications | 授权通知分页 |
| POST /commander/worker | 私有讨论、提案、回执；不能确认指令 |
| GET /checkpoints/current、/checkpoints/{checkpointId} | 可选协调存档状态/历史 |
| POST /checkpoints/ack | 本参与者阶段确认 |

Commander 正文由快照提供；就绪是 commands 的正常种类。预测、路线、部署、抵达和候选分析由[客户端计算](prediction.md)，不通过服务端查询工作池。

## owner 与网页入口

owner 路径同样相对于 `/player/v2`。

| 方法与路径 | 用途 |
| --- | --- |
| GET /owner/identity | 核对身份与映射 |
| GET、POST /owner/grants | 列出/登记调用方生成凭证的哈希 |
| POST /owner/grants/{grantId}/revoke | 撤销授权 |
| GET /owner/observation | 本席观察 |
| GET、POST /owner/control | 控制状态及明确 owner 控制操作 |
| POST /owner/commands | 人工命令、预约及取消 |
| GET /owner/diplomacy/receipts | 本人外交回执分页 |
| GET /owner/activity、/owner/manual-commands | 实际活动及人工记录 |
| POST /owner/queries/history | 授权历史时点 |
| GET /owner/chat、/owner/chat/search、/owner/chat/conversations | 聊天分页、检索、会话 |
| POST /owner/chat、/owner/chat/seen | owner 发言和已读 |
| GET /owner/notifications、/owner/announcements、/owner/standings | 通知、公告、排名 |
| GET /owner/commander | 本人讨论、提案与确认摘要 |
| POST /owner/commander/messages、/owner/commander/confirm | 发消息与玩家确认 |

owner 游戏命令与 owner 聊天写入使用各自严格参数和控制权校验，不能按读取路径推造其他写接口。公开 wire 与宿主网页扩展的范围以实际路由为准：`packages/server/src/player-protocol-api.ts`。

## 大厅、托管管理与实验室

大厅使用 `GET /lobby/v2`、`POST /lobby/v2/commands`、`GET /lobby/v2/events`，详见[生命周期](lobby-lifecycle.md)。多房间创建/按码领取使用宿主 `/api/rooms` 流程；托管 AI 的 `/ai/v2` 不属于独立执行器协议。

`/api/state`、新局、推进和导出等实验室管理能力只属于管理员入口，不得提供给 bot 或普通玩家。独立控制台 `/api/agent/*` 是本机操作员接口，不是游戏服插件 API。

## 启动与边界

直连玩家监听由 `PLAYER_PORT` 启用，默认本机；`PLAYER_HOST` 可指定网卡，反向代理使用精确 HTTPS `PLAYER_PUBLIC_ORIGIN`。凭据文件 `runtime/player-access.json` 不通过 HTTP 下载或日志输出。普通重启保留作用域；新局、导入和 clone 的身份处理遵守相应恢复流程。

单玩家响应由服务端过滤，不能全图下发后前端隐藏。浏览器与 bot 不得绕过[功能范围](feature-availability.md)。控制租约、人工配合、未知命令和暂停规则见[玩家控制权](player-control.md)。

当前观察的活动摘要最多十条，完整授权活动通过已有分页接口及固定上界游标读取；控制器按持久事实基线补齐未处理区间，不将旧历史重新视为新事件。观察修订使用当前可见事实和由命令追加／回放维护的本席命令头，避免对整份己方命令历史重复散列。历史、回执及追加日志继续保留。

不可变当前切面可按房间、席位、存储修订和步内秒复用观察；真实状态或步内时间变化使缓存失效。可原地修改局面的自定义宿主不使用身份缓存。时间显示字段与规则窗口的修订语义保持一致，缓存不能使旧方案获得新的行动权限。
