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

- 首次登录在事务中创建 `users` 记录；新设备必须由认证路由登记到 `sync_devices`。
- `PostgresSyncStore` 只接受已存在、未删除的用户和未撤销设备。
- 登出撤销当前会话；“退出所有设备”同时撤销该用户的会话和设备记录。
- 所有状态变更路由都必须校验 Origin/CSRF token，并设置请求大小与速率限制。

## 上线前阻断项

1. 实现 OIDC 回调、会话轮换、登出和 CSRF 防护。
2. 增加认证中间件，把可信会话映射为 `SyncPrincipal`。
3. 接入同步 HTTP 路由，并覆盖跨用户、撤销设备和会话过期测试。
4. 明确会话、同步游标和已删除账号的保留期限。
