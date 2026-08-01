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

远端 `~/services/ai-learning-os/dev.env` 保存 Dex 测试账号配置，权限应为 `0600`。应用数据库密码和本地运行配置只保存在本地 `.env.local`，不得提交到 Git。

远端每日运行 `backup.sh`，以 PostgreSQL custom format 保存数据库备份，并自动删除超过 7 天的副本。备份目录权限为 `0700`，文件权限为 `0600`。该开发基线不代替生产环境的异地加密备份。

恢复时必须新建隔离的临时数据库，禁止覆盖运行中的应用数据库。验证清单和演练结果记录在 [`../../docs/dev-recovery-drill.md`](../../docs/dev-recovery-drill.md)。
