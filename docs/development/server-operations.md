# 云服务器部署与运维

本文描述 Linux 网页大厅的部署、发布和管理。Node.js 常驻运行游戏，Nginx 提供公网访问，systemd 管理进程。AI 控制台可在本机运行。

## SSH 与目录

下文以 `game.example.com` 为大厅域名、`deploy@game.example.com` 为 SSH 登录目标。部署时替换为自己的域名和账户，并在本机 SSH 配置中选择已授权的身份。

| 位置 | 用途 |
| --- | --- |
| `/opt/subterfuge/app` | 源码、依赖、dist 与前端产物 |
| `/var/lib/subterfuge/rooms` | 实际房间数据 |
| `/var/backups/subterfuge` | 数据备份与移除房间的归档 |
| `/opt/subterfuge/releases` | 更新前代码和资源的回滚副本，文件范围以归档清单为准 |
| `/etc/systemd/system/subterfuge-lobby.service` | 游戏服务配置 |
| `/etc/nginx/sites-available/default` | 公网入口与证书配置 |
| `/etc/nginx/snippets/subterfuge-proxy.conf` | 共用反向代理配置 |

代码与数据分开保存；上传源码不能夹带本机运行存档、凭据或无关工作区修改。

## 运行配置

服务器采用 Ubuntu 24.04 x86_64，项目需要 Node.js 22.13+、npm、Python 3 和 Nginx。服务以系统用户 `subterfuge` 运行，从 `/opt/subterfuge/app` 执行 `/usr/local/bin/node dist/packages/server/src/room-hub-main.js`。

```ini
NODE_ENV=production
LOBBY_HOST=127.0.0.1
LOBBY_PORT=4312
LOBBY_DATA_DIR=/var/lib/subterfuge/rooms
```

服务开机启动，异常退出 5 秒后重启；systemd 数据目录权限为 0700，UMask 为 0077，启用 NoNewPrivileges、PrivateTmp、ProtectSystem=strict、ProtectHome，只开放数据目录写入。更新前可用 `systemctl cat subterfuge-lobby` 核对实际配置。

Nginx 监听 80/443，转发到本机 4312，保留 Host 与来源转发头，读取超时 90 秒、关闭代理缓冲，请求体上限 1 MB。无需对公网开放 4312。 首页加载壳及其启动脚本由 Nginx 直接提供；后端不可用时启动脚本显示加载失败与重试，避免永久停留在连接状态。首页内嵌样式使用精确 SHA-256 CSP 哈希，更新加载样式时须同步 Nginx 中的哈希。

公共服务块加载 `scripts/nginx-player-static.conf` 对应配置，除静态脚本、样式与 SVG 外，对超过 1024 字节且客户端接受 gzip 的 JSON 响应启用压缩，减少同步快照在公网链路上的传输量。`text/event-stream` 不在压缩类型中，代理缓冲继续关闭；授权、解压后的响应与协议大小校验保持原语义。配置修改后先运行 `nginx -t`，通过后热重载 Nginx。

将 `https://game.example.com/` 设为玩家和 bot 的公网入口。通过大厅打开本机 bot 控制台会沿用当前大厅地址。HTTP 与 HTTPS 属于不同的浏览器来源，玩家身份保存在各自的来源下。

为自己的域名签发可信 TLS 证书，在 Nginx 中配置证书链和私钥路径，并通过证书客户端定期续期。若用名为 `subterfuge-certificate.timer` 的自建 systemd 定时器，配置续期成功后的 Nginx 重载并检查以下状态。

```sh
systemctl list-timers subterfuge-certificate.timer --all --no-pager
sudo journalctl -u subterfuge-certificate.service -n 30 --no-pager
sudo nginx -t
```

## 首次部署

安装上述依赖，创建独立系统用户 `subterfuge`，建立代码与数据目录并配置对应权限。将经审查的源码上传至 `/opt/subterfuge/app`，从该目录执行：

```sh
npm ci
npm run web:build
node scripts/run-tests.mjs dist/tests/room-hub.test.js dist/tests/lobby-api.test.js dist/tests/lobby-store.test.js
```

配置与上述路径一致的 systemd 服务和 Nginx 代理；HTTPS 证书签发、续期及云防火墙需单独配置，构建项目不会创建这些配置。正式服务直接运行构建好的入口，避免每次启动都执行 `npm run lobby:start` 的构建步骤。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now subterfuge-lobby
sudo nginx -t
sudo systemctl enable --now nginx
curl --fail http://127.0.0.1:4312/api/rooms
```

上线前还须验证公网网页、两人加入、开局、刷新重连和重启后的身份恢复。构建或 HTTP 成功不等于所有功能验收通过。

## 更新发布

发布前明确目标版本、文件范围、回滚副本和是否涉及后端。工作区可能存在并行或未提交修改，不得未经核对就打包整个工作目录发布。服务器不必保存 GitHub 凭据，可通过 SCP 上传源码包。

本机 PowerShell 可对已确认的提交使用 `git archive --format=tar.gz --output=outputs/cloud-deploy/source.tar.gz <提交>`，然后执行：

```powershell
scp outputs/cloud-deploy/source.tar.gz deploy@game.example.com:/tmp/subterfuge-source.tar.gz
```

先建立本地输出目录。`git archive` 不包含未提交修改与新增未跟踪文件；若发布工作区补丁，应显式列出需要的文件，包含新增模块并排除存档、秘密及其他任务的修改。

### 前端热更新

1. 在独立暂存目录准备确认过的源码，执行 `npm ci` 与 `node scripts/build-web.mjs`；涉及 TypeScript 逻辑还须通过 `npm run build` 和相关测试。
2. 将线上待替换文件显式备份到 `/opt/subterfuge/releases/<发布标识>.tar.gz`，检查归档清单。
3. 成组发布相关 HTML、JS、CSS、worker 和对应源码。先写同目录 `.new` 文件，再用 `mv` 替换正式文件，减少单个文件写入时被读取的风险；多个文件的替换并不是整体原子事务，需避免新旧资源混用。
4. 无需重启游戏进程，不改房间数据。同步源码，避免下次构建覆盖修复。
5. 从公网读取资源核对 SHA-256，并检查实际页面和相关操作。刷新浏览器加载新资源，不要求玩家清除站点数据，以免丢失身份。

玩家包由 `scripts/build-player.mjs` 使用生产版 React 和压缩构建生成。HTML 引用 `/assets/player/player-<内容哈希>.js` 与 CSS；发布时先安装新资源，最后替换 HTML，保留旧哈希资源供已打开的页面使用。未版本化的入口与 worker 必须重新验证，不能设置长期不可变缓存。

将 `scripts/nginx-player-static.conf` 安装到 `/etc/nginx/snippets/subterfuge-player-static.conf`，在两个公网 server 块中各包含一次，再通过 `nginx -t` 并重载。该配置只将公共玩家入口、资源及美术文件改为静态服务，游戏 API 仍由原反向代理鉴权；对 JS/CSS 和 JSON 响应开启 gzip，HTML 使用 `no-cache`，哈希资源使用一年不可变缓存，其他美术文件使用协商缓存。Nginx 的 ETag 支持未变化资源返回 304；Node 直连的玩家静态入口也提供内容 ETag 和对应缓存策略。部署后应以请求压缩的实际 GET 验证编码与传输大小，并验证 If-None-Match 返回 304，不能只检查配置文字。

### 后端更新

先在暂存目录构建并测试候选版本，保留旧源码、依赖及 dist。安排维护窗口：

```sh
subterfuge backup
sudo systemctl stop subterfuge-lobby
# 此时切换经过验证的代码、依赖和 dist，保留房间数据目录。
sudo systemctl start subterfuge-lobby
subterfuge status
subterfuge rooms
curl --fail http://127.0.0.1:4312/api/rooms
```

`backup` 会恢复之前运行的服务，因此更新前仍须显式停止。运行中不要覆盖后端模块、数据库或 WAL。活跃 AI 的后端更新还须按[联动存档及重启](linked-checkpoints.md)协调，普通重启不代表远程控制器已恢复。

修改 systemd 文件后先 `sudo systemctl daemon-reload`；修改 Nginx 后先 `sudo nginx -t`，通过后再 `sudo systemctl reload nginx`。不要为更新便利清空正常对局。

## 回滚与恢复

前端故障：检查发布前归档清单，将匹配的 HTML、JS、CSS、worker 与源码成组恢复，无需回滚游戏数据。后端故障：停止服务，恢复兼容的源码、依赖和 dist，再启动。旧代码必须支持当前数据格式，代码回滚不自动意味着数据库可回滚。

数据恢复必须在停止服务后进行：先保护当前数据，在独立目录解压、核对备份及权限，再确认源、目标、停机影响和身份策略后切换。不要直接向运行目录覆盖解压。当前管理命令没有自动恢复功能。

移除房间的归档保留原身份；恢复前应检查房间码冲突。它不是会撤销旧执行器授权的[独立服务 clone 恢复](game-only-server.md)。

## 备份与排障

可按自己的维护时段配置 `subterfuge-backup.timer`，调用 `/usr/local/sbin/subterfuge-backup` 执行一致性备份。备份脚本取得与房间移除共用的锁，停止大厅，打包整个 rooms（包括 SQLite、WAL 和元数据），校验归档后恢复原运行状态。文件名使用 UTC 时间。

备份在同机，不能防止整机丢失；脚本没有自动过期清理，应监控空间并另存异机副本。不要复制运行中的单个 SQLite 文件充当完整备份。

```sh
systemctl list-timers subterfuge-backup.timer --all --no-pager
sudo journalctl -u subterfuge-backup.service -n 30 --no-pager
df -h
sudo du -sh /var/lib/subterfuge /var/backups/subterfuge
```

访问异常依次检查服务状态、服务日志、本机 4312 接口、Nginx 配置与日志、公网 HTTPS；本机正常而公网不通时检查云防火墙及 80/443，不通过清空对局修复网络。具体发布、验证和故障记录放本地 outputs 或 runtime，不追加到本文。

## SSH 管理命令

使用 `scripts/server-admin.py` 管理已部署为 `subterfuge-lobby.service` 的大厅。工具固定访问本机 `127.0.0.1:4312`，房间目录为 `/var/lib/subterfuge/rooms`，备份目录为 `/var/backups/subterfuge`；不适用于路径或服务名不同的部署。`backup` 依赖预先安装的 `/usr/local/sbin/subterfuge-backup` 一致性备份脚本。

从项目根目录安装（需要 Python 3 与 sudo）：

```sh
sudo install -o root -g root -m 0755 scripts/server-admin.py /usr/local/sbin/subterfuge-admin
sudo install -o root -g root -m 0755 scripts/subterfuge /usr/local/bin/subterfuge
```

通过 SSH 运行：

| 命令 | 效果 |
| --- | --- |
| `subterfuge status` | 查看大厅服务状态 |
| `subterfuge rooms` | 查看房间码、人数、容量及阶段，不输出玩家凭据 |
| `subterfuge logs` | 查看最近 60 条服务日志 |
| `subterfuge backup` | 执行一次完整房间备份，短暂停服后恢复 |
| `subterfuge backups` | 列出完整备份和移除房间的归档位置 |
| `subterfuge remove-room ABC123 --yes` | 移除指定房间，完整数据移至 `removed-rooms` 归档；短暂停服，其他房间保留 |
| `subterfuge restart` | 重启大厅并等待接口恢复；保留房间和身份 |

移除操作要求六位大写字母数字房间码和显式 `--yes`，停止服务后再次核对元数据及路径，将完整房间目录移至带 UTC 时间的归档，不直接删除数据库或省略 WAL。它与完整备份共用进程锁；归档仅供运维恢复，不是游戏 clone 或协调存档。运行中的其他房间也会短暂断连，因此应在合适时机执行。归档与备份在同一台服务器上，不代替异机备份。

工具路径校验及归档完整性检查：`python scripts/test_server_admin.py`。
