# AI Learning OS 身份方案

## 决策

首版账号系统采用 **OpenID Connect（OIDC）授权码流程 + PKCE**。浏览器只持有由 AI Learning OS 服务端签发的短期、`HttpOnly`、`Secure`、`SameSite=Lax` 会话 Cookie；第三方访问令牌和数据库凭据不进入 React 客户端或本地学习快照。

项目保持身份提供商中立：开发环境可以连接任意标准 OIDC 提供商，部署者通过 issuer、client ID 和 redirect URI 配置自己的租户。核心领域只接收服务端从已验证会话解析出的 `SyncPrincipal`，不会接受请求正文或查询参数中的 `userId`。

## 选择理由

- OIDC 提供标准化发现、签名验证、密钥轮换和登录状态，不需要本项目存储密码。
- 授权码流程配合 PKCE 可避免把访问令牌暴露给浏览器脚本。
- 服务端会话允许同步 API 使用同源 Cookie、CSRF 防护和集中撤销，并保持 React 客户端简单。
- provider-neutral 配置适合公开仓库，不把产品绑定到单一商业身份服务。

## 信任边界

```text
浏览器 → OIDC 登录回调 → 服务端验证 issuer/state/nonce/PKCE
                         → 建立加密或服务端会话
                         → 解析 userId + deviceId
                         → PostgresSyncStore
```

- `GET /api/auth/login` 通过 issuer discovery 发起授权码流程，生成短期签名事务 Cookie，并绑定随机 `state`、`nonce` 和 S256 PKCE verifier。`GET /api/auth/callback` 交换授权码，通过提供商 JWKS 验证 ID Token 的签名、issuer、audience、nonce 和 subject。
- 已实现的会话生命周期只在上述验证全部通过后接收 OIDC issuer + subject，并于事务中创建 `users`、`oidc_identities` 和 `sync_devices` 记录；访问令牌和 ID Token 不写入应用会话或学习记录。
- 会话以高熵不透明令牌签发，数据库只保存 SHA-256 哈希；解析器同时检查会话有效期、会话撤销、账号删除和设备撤销。
- `PostgresSyncStore` 只接受已存在、未删除的用户和未撤销设备。
- `POST /api/auth/session/refresh` 原子撤销旧令牌并签发新令牌；`POST /api/auth/logout` 撤销当前会话并清除 Cookie。二者都校验精确 Origin。“退出所有设备”仍待实现。
- 所有状态变更路由都必须校验 Origin/CSRF token，并设置请求大小与速率限制。

## 上线前阻断项

1. **已实现 OIDC 登录与账号界面：**覆盖 discovery、state、nonce、S256 PKCE、授权码交换、基于 JWKS 的 ID Token 验证，以及登录、自动同步、离线待办和最近同步状态。
2. **已接入会话生命周期：**`PostgresSessionPrincipalResolver` 从 HttpOnly Cookie 的不透明令牌哈希解析 `SyncPrincipal`；`PostgresSessionLifecycle` 负责验证后身份映射、设备登记、令牌哈希存储、轮换和撤销，并已由服务启动配置注入。
3. **已建立路由：**同步 HTTP API 已覆盖认证缺失、跨用户、条件写入、幂等冲突和来源校验；仍需覆盖撤销设备和会话过期的端到端测试。
4. 明确会话、同步游标和已删除账号的保留期限。

## 会话 HTTP 契约

- `GET /api/auth/login?returnTo=/path`：创建 10 分钟有效的签名登录事务并重定向到提供商；`returnTo` 只接受同源绝对路径。
- `GET /api/auth/callback`：验证提供商回调和 ID Token，建立本地用户、设备与应用会话，清除登录事务后重定向到 `returnTo`。
- `GET /api/auth/session`：返回当前用户和设备的认证状态，不延长会话。
- `POST /api/auth/session/refresh`：要求允许的 `Origin` 和有效会话 Cookie，返回相同用户/设备的新会话并撤销旧令牌。
- `POST /api/auth/logout`：要求允许的 `Origin`，撤销当前令牌并返回立即过期的 Cookie。

Cookie 固定使用 `Path=/; HttpOnly; Secure; SameSite=Lax`。数据库只保存 SHA-256 令牌哈希；默认会话有效期为 24 小时。OIDC 回调完成后必须只把已经完整验证的 issuer 和 subject 传给 `establishFromOidc`。

## 运行配置

启用登录需要在数据库和同步来源配置之外，同时设置 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI` 和至少 32 字符的 `OIDC_TRANSACTION_SECRET`。issuer 和生产回调必须使用 HTTPS；本地回调可以使用 `localhost` 或 `127.0.0.1`。四项配置不完整时服务会拒绝启动，避免运行一个部分可信的登录流程。
