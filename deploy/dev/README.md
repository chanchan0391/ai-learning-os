# 开发环境部署

该配置在 `dev` 服务器上运行轻量 Dex OIDC 服务，并只绑定远端回环地址。浏览器和本地 API 通过 SSH 隧道访问，不向公网开放新的端口。

```sh
ssh -N \
  -L 5556:127.0.0.1:5556 \
  -L 15432:127.0.0.1:5432 \
  -L 8088:127.0.0.1:8088 \
  dev
```

本地 `.env.local` 使用以下地址：

```dotenv
DATABASE_URL=postgresql://ai_learning_os:<password>@127.0.0.1:15432/ai_learning_os
SYNC_ALLOWED_ORIGINS=http://127.0.0.1:5173
# 可选：PostgreSQL 运行时资源边界（以下均为默认值）
DATABASE_POOL_MAX=10
DATABASE_CONNECTION_TIMEOUT_MS=5000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=15000
DATABASE_QUERY_TIMEOUT_MS=20000
DATABASE_IDLE_TRANSACTION_TIMEOUT_MS=15000
DATABASE_MAX_LIFETIME_SECONDS=300
OIDC_ISSUER=http://127.0.0.1:5556/dex
OIDC_CLIENT_ID=ai-learning-os
OIDC_REDIRECT_URI=http://127.0.0.1:5173/api/auth/callback
OIDC_TRANSACTION_SECRET=<at-least-32-random-characters>
# 可选：OIDC discovery、令牌交换和 JWKS 请求时限（毫秒），默认 10000，最大 60000
OIDC_UPSTREAM_TIMEOUT_MS=10000
# 可选：每次结构化模型响应的输出 token 上限，默认 4096，最大 32768
OPENAI_MAX_OUTPUT_TOKENS=4096
# 可选：一次模型调用跨全部重试和退避的总时限（毫秒），默认 60000，最大 120000
OPENAI_TOTAL_TIMEOUT_MS=60000
# 可选：每个 API 实例同时执行的 Agent 请求上限，默认 20
AI_MAX_CONCURRENT_AGENT_REQUESTS=20
# 可选：仅信任这些直连反向代理追加的最右侧 X-Forwarded-For 地址
TRUSTED_PROXY_ADDRESSES=127.0.0.1
# 可选：四项同时配置后启用认证账号的月度模型预算
AI_MONTHLY_TOKEN_LIMIT=250000
AI_MONTHLY_COST_LIMIT_USD=12.50
AI_INPUT_COST_PER_MILLION_USD=<current-model-input-price>
AI_OUTPUT_COST_PER_MILLION_USD=<current-model-output-price>
# 可选：所有账号合计的应用级月度金额熔断
AI_GLOBAL_MONTHLY_COST_LIMIT_USD=250
# 可选：套餐对应的账号月度 token 与金额硬配额；金额使用字符串避免 JSON 浮点歧义
AI_PLAN_BUDGETS_JSON='{"starter":{"monthlyTokenLimit":50000,"monthlyCostLimitUsd":"2.50"},"pro":{"monthlyTokenLimit":250000,"monthlyCostLimitUsd":"12.50"}}'
# 可选：要求付费 Agent 请求具有数据库中的有效订阅权益；启用时套餐表为必填
AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED=false
```

实时模型在启动时要求上述四项账号预算和数据库会话能力同时存在，避免部署误配置成未认证、未计量的付费 Agent API。`AI_ALLOW_UNMETERED_LIVE_MODEL=true` 只允许用于隔离的本地烟雾测试，不得写入 dev 或任何共享环境。

完整容器部署启动后，通过上述隧道打开 `http://127.0.0.1:8088` 即可查看远端 Web、API、OIDC、PostgreSQL 和实时模型组成的完整效果。

若服务器暂时无法从 Docker Hub 拉取基础镜像，可使用 `ai-learning-os-api.service` 和 `ai-learning-os-web.service` 作为等价的用户级运行方式。当前服务固定使用 NVM 的 Node 22.23.1，仍只监听服务器回环地址。

### 自动部署

由于 dev 服务器位于内网且当前不能稳定访问 GitHub 下载端点，开发机通过 launchd 每五分钟运行安装在用户级 Application Support 中的 `publish-main.sh`。它在独立缓存目录读取 `origin/main` 的不可变提交、通过 SSH 上传归档，再由远端 `deploy-main.sh`：

1. 接收不可变的提交归档，在解压前校验 SHA-256 完整性。
2. 执行 `npm ci` 和 `npm run check`。
3. 在迁移前创建 PostgreSQL 备份，再在数据库 advisory lock 下执行带 SHA-256 完整性验证的幂等迁移。
4. 原子切换 `current` 符号链接并重启 Web 与 API。
5. 在有界连接与响应时间内验证两个用户服务真正使用选定的 Node 二进制、Web 首页和 API 健康端点，同时要求 API 报告的 release revision 与待部署提交完全一致，并确认实时模型、同步和 PostgreSQL 就绪检查均通过；失败时恢复上一 release、重启服务，并使用上一提交标识重新通过完整健康门，明确报告回滚是否真正恢复服务。
6. 健康后用已验证 release 中的版本原子更新远程 `deploy-main.sh`、`backup.sh`、`backup-health.sh`、`application-health.sh`、`host-capacity.sh`、只读 `verify-backup.sh`、隔离 `restore-drill.sh` 与共享 Docker 客户端解析助手；publisher 发现同一 revision 时仍会进入远端轻量对账，并只在内容或执行权限漂移时刷新它们，避免激活后中断让后续部署、每日备份、健康监控或恢复演练继续使用旧逻辑。
7. 只保留最近三个已验证 release；健康门失败时，在回滚或停止服务后删除未通过验证且不再活动的 release。部署还会清理超过一天的完整或未完成上传归档及 `.deploy-*` 临时工作区；当前 revision 的托管归档在校验或部署失败时也会删除，避免连续失败或不可捕获终止持续占用服务器磁盘。所有删除都在部署锁内执行，只匹配受管目录的直属制品，并在删除前重新确认目标是当前用户拥有的真实目录；失败 release 还必须确认不是当前版本。远端 runner 在加锁或写入前要求部署根目录与受管子目录均为当前用户拥有的真实目录，并拒绝符号链接、非普通、不归部署用户所有或具有多个硬链接的现有锁目标。release 内 runner 与已安装 runner 同样要求当前用户独占的普通文件，更新通过不可预测临时文件原子完成，避免共享 inode 或预置 staged 路径把内容写向非受管目标。publisher 每轮都会拒绝符号链接形式、不归当前用户所有或允许组/其他用户写入的缓存父目录、checkout 与 `.git`，并验证其 `origin` 与配置仓库完全一致，再从该远端解析不可变 revision，避免缓存重定向、跨用户替换或本地篡改静默改变部署来源；首次 clone 前会完成同样的父目录校验，clone 后重新验证生成目录。publisher 使用 macOS 自带的 `shlock` 原子记录进程归属；进程异常退出后，下一轮会识别失效 PID 并回收锁，不会永久停止自动发布。publisher 日志达到 5 MiB 后在发布锁内轮转，保留四代近期诊断记录；触发轮转的当前轮次会继续写入第一代文件，下一轮由 launchd 创建新的主日志路径，因此不会截断仍打开的文件描述符。可用 `AI_LEARNING_PUBLISH_LOG_MAX_BYTES` 调整单代阈值。SSH/SCP 连接使用连接超时和 keepalive 失联判定；release 下载同时具有总时间和低速中止边界，网络停滞会让本轮明确失败并由后续定时轮次重试。控制面安装在写入 unit 或备份前要求部署目录、systemd 用户 unit 目录和控制面备份目录均为当前用户拥有的真实目录，并拒绝符号链接锁文件；锁与备份分别收紧为 `0600` 与 `0700`。

用户服务 unit 属于 dev 主机控制面配置。`control-plane.sh` 会比较 release 与已安装 unit、服务启用/运行状态及实际 Node 进程路径。安装模式使用 `flock` 内核文件锁串行化操作；进程异常退出时锁会由操作系统释放，遗留的当前用户独占普通锁文件不会阻塞下一次安装，符号链接、硬链接或跨用户锁会在打开前被拒绝。安装过程会拒绝共享 inode 的 source、已安装 unit 和 staged unit，以不可预测临时文件备份并原子替换，reload/restart 后验证，并在失败时自动恢复；清理遗留 stage 与旧控制面备份前也会重新验证归属和链接类型。部署健康门同样拒绝服务实际 Node 路径与选定运行时不一致的 release。

API 与 Web 用户服务采用 Node/V8 和当前 dev 用户管理器兼容的 systemd 沙箱基线：系统和 home 目录只读、临时目录私有、禁止提权、保护内核参数与控制组接口，并仅保留 Unix/IPv4/IPv6 地址族。控制面会拒绝缺少任一必需指令的源 unit，防止后续编辑静默移除基线。应用若确需新的可写路径或地址族，应先记录威胁模型和最小例外，不能整体关闭沙箱。当前 dev 主机不允许用户管理器更改 capability bounding set，因此未启用会隐式要求该操作的设备、内核模块、内核日志和时钟隔离；生产服务管理器应重新评估并尽可能启用这些限制。

```sh
# 只读检查；任一 unit 漂移、禁用、停止或运行时不符都会返回非零
ssh dev '~/services/ai-learning-os/current/deploy/dev/control-plane.sh status'

# 有意更新 repo 中的 unit 后执行；成功输出可回滚备份目录
ssh dev '~/services/ai-learning-os/current/deploy/dev/control-plane.sh install'
```

Web 服务同时发送仅允许同源脚本、样式、连接和资源的 CSP，并禁止跨站嵌入、MIME 嗅探、Referrer 泄露及未使用的敏感浏览器能力。dev 只通过回环地址和 SSH 隧道提供 HTTP；未来公网 TLS 终止层必须另外配置 HSTS。

常规部署成功不发送通知。自动部署失败、持续版本落后或需要人工判断时，依照仓库协作规则通过 Gmail 通知项目所有者。

查看状态时使用：

```sh
launchctl print gui/$(id -u)/com.ai-learning-os.deploy-main
tail -n 100 ~/Library/Logs/ai-learning-os-deploy.log
cat ~/services/ai-learning-os/current/DEPLOYED_COMMIT
~/services/ai-learning-os/current/deploy/dev/control-plane.sh status
```

数据库迁移必须遵守 expand/contract：激活新版本前运行的迁移必须与上一应用版本兼容，确保健康检查失败后可以安全回滚应用。

这条基于开发机的链路只适用于内网 dev。生产环境必须使用独立 CI/CD Runner、受保护环境、短期部署身份、审批策略和集中式告警，不能依赖个人工作站在线。

远端 `~/services/ai-learning-os/dev.env` 保存 Dex 测试账号配置，权限应为 `0600`。应用数据库密码和本地运行配置只保存在本地 `.env.local`，不得提交到 Git。

远端由受版本控制的 `ai-learning-os-backup.timer` 每日 03:00 UTC 后随机错峰 30 分钟运行 `backup.sh`；`Persistent=true` 会在用户管理器离线后补跑错过的轮次。独立的 `ai-learning-os-backup-monitor.timer` 每 15 分钟运行隐私安全的 `backup-health.sh`，每次备份成功或失败后也会立即触发。`ai-learning-os-application-monitor.timer` 每 5 分钟检查 API/Web unit 仍处于 active、Web 可达，并严格解析 `/api/health`，要求数据库 ready、实时模型与同步启用且 release revision 等于活动 `DEPLOYED_COMMIT`；读取该文件前会验证它由当前用户独占且恰好 41 字节，避免共享 inode 或异常大证明制品进入周期任务。`ai-learning-os-host-capacity-monitor.timer` 每 15 分钟检查部署与备份文件系统同时保留至少 5 GiB、使用率低于 90%、至少 100,000 个 inode 且 inode 使用率低于 90%。监控只输出受管文件名、年龄、提交标识或使用百分比，不输出路径、学习正文或健康响应内容；失败会形成 failed monitor service，`control-plane.sh status` 因而失败并可被主机级采集发现。当前 dev 尚未配置集中告警目的地，生产前必须将失败 unit 接入受控通知路由。控制面会原子安装、回滚并启用全部五个 timer，状态检查同时验证 schedule unit 没有漂移且处于 enabled/active。备份 service 复用应用服务沙箱，并只给默认备份目录开放写权限。以 PostgreSQL custom format 保存数据库备份；备份目录必须使用绝对路径，并在任何权限变更或数据库访问前证明它是真实目录且归当前用户所有，拒绝符号链接、普通文件和跨用户目录。备份、只读验证和隔离恢复会先将 Docker 客户端解析为绝对路径，只接受由 root 或当前用户拥有、不可被组或其他用户写入且没有符号链接或额外硬链接的可执行文件；其直接父目录也必须满足相同归属和写权限边界。可用 `AI_LEARNING_DOCKER_BIN` 显式指定绝对路径。脚本使用 `flock` 串行化定时任务与发布前备份，真实并发会在访问 PostgreSQL 前失败，进程异常退出后内核会自动释放锁；遗留锁只有在当前用户独占普通文件时才会复用，符号链接、硬链接或跨用户目标会在打开、改权和 PostgreSQL 访问前被拒绝。脚本会先拒绝空输出，再用 `pg_restore --list` 验证归档可读取，只有通过验证的临时文件才会以碰撞安全的名称发布。每份归档同时生成只引用文件名的 SHA-256 sidecar；备份目录权限为 `0700`，锁文件、归档与校验文件权限为 `0600`。每轮只清理目录直属、当前用户独占的受管普通文件：超过 7 天的归档、配对或孤立校验文件，以及超过一天的异常终止临时文件；不会删除硬链接制品或递归遍历嵌套路径。该开发基线不代替生产环境的异地加密备份。

控制面现在还会原子安装、回滚并启用第四个 timer：`ai-learning-os-restore-drill.timer`。它每周日 04:00 UTC 后随机错峰最多 2 小时，自动选择最新受管归档，在唯一隔离数据库中完整恢复、验证并删除临时库。任务最多运行 15 分钟；失败会保留为 failed service，并使 `control-plane.sh status` 返回非零。

恢复前必须先运行只读预检；它拒绝相对路径、符号链接、硬链接、非当前用户文件、对组或其他用户开放的权限、错误 sidecar 文件名和校验和，要求归档与 sidecar 都是当前用户独占的私有普通文件，并再次通过容器内 `pg_restore --list` 验证归档：

```sh
~/services/ai-learning-os/verify-backup.sh /home/chanchan/backups/ai-learning-os/<backup>.dump
```

恢复时必须新建隔离的临时数据库，禁止覆盖运行中的应用数据库。验证清单和演练结果记录在 [`../../docs/dev-recovery-drill.md`](../../docs/dev-recovery-drill.md)。

仓库提供的演练命令只通过绝对路径执行上述只读预检，并要求验证助手的父目录由当前用户拥有且不可被组或其他用户写入，避免工作目录或共享可写目录替换待执行助手。随后它会创建不可复用的唯一临时数据库，完整恢复归档，验证核心表、迁移数和不含内容的行数，最后在成功、失败或中断时删除临时数据库：

```sh
~/services/ai-learning-os/restore-drill.sh /home/chanchan/backups/ai-learning-os/<backup>.dump
~/services/ai-learning-os/restore-drill.sh # 省略参数时选择最新受管备份
```

输出只包含表、迁移、账号、计划和每日记录的数量，不输出标识符或学习正文。删除临时数据库失败会让命令明确失败，必须先完成清理再把演练记为成功。

应用监控还会证明备份、备份健康、恢复演练和主机容量 timer 均为 enabled/active，并严格验证数据库连接池快照；出现等待连接、饱和或异常容量字段时，只输出稳定失败说明，不回显健康响应。
