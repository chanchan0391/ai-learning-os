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
OIDC_ISSUER=http://127.0.0.1:5556/dex
OIDC_CLIENT_ID=ai-learning-os
OIDC_REDIRECT_URI=http://127.0.0.1:5173/api/auth/callback
OIDC_TRANSACTION_SECRET=<at-least-32-random-characters>
```

完整容器部署启动后，通过上述隧道打开 `http://127.0.0.1:8088` 即可查看远端 Web、API、OIDC、PostgreSQL 和实时模型组成的完整效果。

若服务器暂时无法从 Docker Hub 拉取基础镜像，可使用 `ai-learning-os-api.service` 和 `ai-learning-os-web.service` 作为等价的用户级运行方式。当前服务固定使用 NVM 的 Node 22.21.1，仍只监听服务器回环地址。

### 自动部署

由于 dev 服务器位于内网且当前不能稳定访问 GitHub 下载端点，开发机通过 launchd 每五分钟运行安装在用户级 Application Support 中的 `publish-main.sh`。它在独立缓存目录读取 `origin/main` 的不可变提交、通过 SSH 上传归档，再由远端 `deploy-main.sh`：

1. 接收不可变的提交归档，在解压前校验 SHA-256 完整性。
2. 执行 `npm ci` 和 `npm run check`。
3. 在迁移前创建 PostgreSQL 备份，再执行幂等迁移。
4. 原子切换 `current` 符号链接并重启 Web 与 API。
5. 验证两个用户服务、Web 首页和 API 健康端点，同时确认实时模型和同步已启用；失败时恢复上一 release。
6. 只保留最近三个 release，避免服务器磁盘持续增长。

常规部署成功不发送通知。自动部署失败、持续版本落后或需要人工判断时，依照仓库协作规则通过 Gmail 通知项目所有者。

查看状态时使用：

```sh
launchctl print gui/$(id -u)/com.ai-learning-os.deploy-main
tail -n 100 ~/Library/Logs/ai-learning-os-deploy.log
cat ~/services/ai-learning-os/current/DEPLOYED_COMMIT
```

数据库迁移必须遵守 expand/contract：激活新版本前运行的迁移必须与上一应用版本兼容，确保健康检查失败后可以安全回滚应用。

这条基于开发机的链路只适用于内网 dev。生产环境必须使用独立 CI/CD Runner、受保护环境、短期部署身份、审批策略和集中式告警，不能依赖个人工作站在线。

远端 `~/services/ai-learning-os/dev.env` 保存 Dex 测试账号配置，权限应为 `0600`。应用数据库密码和本地运行配置只保存在本地 `.env.local`，不得提交到 Git。

远端每日运行 `backup.sh`，以 PostgreSQL custom format 保存数据库备份，并自动删除超过 7 天的副本。备份目录权限为 `0700`，文件权限为 `0600`。该开发基线不代替生产环境的异地加密备份。

恢复时必须新建隔离的临时数据库，禁止覆盖运行中的应用数据库。验证清单和演练结果记录在 [`../../docs/dev-recovery-drill.md`](../../docs/dev-recovery-drill.md)。
