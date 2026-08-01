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

- 已实现的会话生命周期在经过验证的 OIDC issuer + subject 首次出现时，于事务中创建 `users`、`oidc_identities` 和 `sync_devices` 记录；未经验证的浏览器输入不能直接调用该入口。
- 会话以高熵不透明令牌签发，数据库只保存 SHA-256 哈希；解析器同时检查会话有效期、会话撤销、账号删除和设备撤销。
- `PostgresSyncStore` 只接受已存在、未删除的用户和未撤销设备。
- `POST /api/auth/session/refresh` 原子撤销旧令牌并签发新令牌；`POST /api/auth/logout` 撤销当前会话并清除 Cookie。二者都校验精确 Origin。“退出所有设备”仍待实现。
- 所有状态变更路由都必须校验 Origin/CSRF token，并设置请求大小与速率限制。

## 上线前阻断项

1. 实现 OIDC 授权发起和回调，包含 discovery、state、nonce、PKCE、授权码交换和 ID Token 验证；会话轮换、当前会话登出和 Origin 防护已完成。
2. **已接入会话生命周期：**`PostgresSessionPrincipalResolver` 从 HttpOnly Cookie 的不透明令牌哈希解析 `SyncPrincipal`；`PostgresSessionLifecycle` 负责验证后身份映射、设备登记、令牌哈希存储、轮换和撤销，并已由服务启动配置注入。
3. **已建立路由：**同步 HTTP API 已覆盖认证缺失、跨用户、条件写入、幂等冲突和来源校验；仍需覆盖撤销设备和会话过期的端到端测试。
4. 明确会话、同步游标和已删除账号的保留期限。

## 会话 HTTP 契约

- `GET /api/auth/session`：返回当前用户和设备的认证状态，不延长会话。
- `POST /api/auth/session/refresh`：要求允许的 `Origin` 和有效会话 Cookie，返回相同用户/设备的新会话并撤销旧令牌。
- `POST /api/auth/logout`：要求允许的 `Origin`，撤销当前令牌并返回立即过期的 Cookie。

Cookie 固定使用 `Path=/; HttpOnly; Secure; SameSite=Lax`。数据库只保存 SHA-256 令牌哈希；默认会话有效期为 24 小时。OIDC 回调完成后必须只把已经完整验证的 issuer 和 subject 传给 `establishFromOidc`。
