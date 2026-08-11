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
5. 验证两个用户服务真正使用选定的 Node 二进制、Web 首页和 API 健康端点，同时要求 API 报告的 release revision 与待部署提交完全一致，并确认实时模型、同步和 PostgreSQL 就绪检查均通过；失败时恢复上一 release。
6. 健康后用已验证 release 中的版本原子更新远程 `deploy-main.sh`，避免后续部署继续使用旧运行时或逻辑。
7. 只保留最近三个 release，避免服务器磁盘持续增长。

用户服务 unit 属于 dev 主机控制面配置。`control-plane.sh` 会比较 release 与已安装 unit、服务启用/运行状态及实际 Node 进程路径。安装模式会串行化操作、备份既有 unit、原子替换、reload/restart，并在验证失败时自动恢复备份；部署健康门也会拒绝服务实际 Node 路径与选定运行时不一致的 release。

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

远端每日运行 `backup.sh`，以 PostgreSQL custom format 保存数据库备份，并自动删除超过 7 天的副本。备份目录权限为 `0700`，文件权限为 `0600`。该开发基线不代替生产环境的异地加密备份。

恢复时必须新建隔离的临时数据库，禁止覆盖运行中的应用数据库。验证清单和演练结果记录在 [`../../docs/dev-recovery-drill.md`](../../docs/dev-recovery-drill.md)。
