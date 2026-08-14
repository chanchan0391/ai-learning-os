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
- OIDC discovery、授权码交换和 JWKS 密钥获取共享可配置的上游请求时限，默认 10 秒且不允许超过 60 秒；discovery 限制为 64 KiB，令牌响应和 JWKS 各限制为 256 KiB，并在 JSON 解析或签名验证前取消超限流，避免身份提供商异常长期占用 API 连接或进程内存。同一实例同时发生的 discovery 会共享一个在途请求，失败后立即允许下一次登录重试，避免突发登录或身份上游故障按请求数放大外部流量。三类请求都拒绝 HTTP 重定向，防止 discovery 响应或上游配置把授权码和身份请求转发到未经校验的主机；提供商迁移端点时必须显式更新可信配置。
- 已实现的会话生命周期只在上述验证全部通过后接收 OIDC issuer + subject，并于事务中创建 `users`、`oidc_identities` 和 `sync_devices` 记录；访问令牌和 ID Token 不写入应用会话或学习记录。
- 会话以高熵不透明令牌签发，数据库只保存 SHA-256 哈希；解析器同时检查会话有效期、会话撤销、账号删除和设备撤销。
- `PostgresSyncStore` 只接受已存在、未删除的用户和未撤销设备。
- `POST /api/auth/session/refresh` 原子撤销旧令牌并签发新令牌；`POST /api/auth/logout` 只撤销当前会话；活跃设备清单只返回仍有有效会话的设备，单设备撤销会同时撤销该设备的全部会话；`POST /api/auth/logout-all` 在事务中验证当前会话并撤销该账号的全部会话与设备。`DELETE /api/auth/account` 验证当前会话后事务化删除用户行，依靠外键级联清除身份映射、设备、全部会话和同步数据。所有会话变更都校验精确 Origin。
- 所有状态变更路由都校验精确 Origin；Agent 请求正文限制为 64 KiB，同步正文限制为 1 MB，认证与同步路由还在进入 OIDC、会话或存储逻辑前按客户端地址限流。
- 单进程默认窗口为 60 秒：创建计划 10 次，教学、成果评估和复习评估各 30 次，恢复计划 20 次；登录、回调各 20 次，常规会话变更 60 次，单设备撤销 20 次，退出所有设备和账号删除各 5 次，会话与设备读取和同步读取 120 次，同步写入 60 次。启用数据库后所有实例共享这些配额。响应返回 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`，被拒绝时另返回 `Retry-After`。
- 启用数据库运行时会输出一行一个 JSON 的安全审计事件，记录动作、路径、状态、结果以及认证账号和设备的稳定 SHA-256 截断伪名引用；默认日志不会写入原始用户/设备 ID、Cookie、会话令牌、OIDC code/state、查询字符串、请求正文或客户端地址。伪名引用仅用于在 14 天日志保留窗口内关联同一主体的事件，仍应按受限运维数据处理。

## 上线前阻断项

1. **已实现 OIDC 登录与账号界面：**覆盖 discovery、state、nonce、S256 PKCE、授权码交换、基于 JWKS 的 ID Token 验证，以及登录、自动同步、离线待办和最近同步状态。
2. **已接入会话生命周期：**`PostgresSessionPrincipalResolver` 从 HttpOnly Cookie 的不透明令牌哈希解析 `SyncPrincipal`；`PostgresSessionLifecycle` 负责验证后身份映射、设备登记、令牌哈希存储、轮换和撤销，并已由服务启动配置注入。
3. **已建立路由防护：**同步 HTTP API 已覆盖认证缺失、跨用户、条件写入、幂等冲突、来源校验、共享速率限制和结构化安全审计；登录设备清单、单设备撤销和退出所有设备已覆盖 HTTP、PostgreSQL 和界面测试，会话过期仍由解析器契约测试覆盖。
4. 生产部署者仍需明确数据库备份、基础设施日志和模型提供商数据的保留期限；应用主数据库中的账号数据会立即删除。

## 会话 HTTP 契约

- `GET /api/auth/login?returnTo=/path`：创建 10 分钟有效的签名登录事务并重定向到提供商；`returnTo` 只接受同源绝对路径。
- `GET /api/auth/callback`：验证提供商回调和 ID Token，建立本地用户、设备与应用会话，清除登录事务后重定向到 `returnTo`。
- `GET /api/auth/session`：返回当前用户和设备的认证状态，不延长会话。
- `POST /api/auth/session/refresh`：要求允许的 `Origin` 和有效会话 Cookie，返回相同用户/设备的新会话并撤销旧令牌。
- `POST /api/auth/logout`：要求允许的 `Origin`，撤销当前令牌并返回立即过期的 Cookie。
- `GET /api/auth/devices`：要求有效会话，返回当前账号仍有有效会话的设备、标签、最近活动时间和当前设备标记。
- `DELETE /api/auth/devices/:deviceId`：要求允许的 `Origin` 和有效会话，只能撤销当前账号所属的指定设备及其全部会话；不删除学习数据。
- `POST /api/auth/logout-all`：要求允许的 `Origin` 和有效会话，事务化撤销该账号的全部设备与会话并返回立即过期的 Cookie；学习数据不会被删除。
- `DELETE /api/auth/account`：要求允许的 `Origin` 和有效会话，事务化删除账号及全部所属数据，并返回立即过期的 Cookie。

Cookie 固定使用 `Path=/; HttpOnly; Secure; SameSite=Lax`。数据库只保存 SHA-256 令牌哈希；默认会话有效期为 24 小时。OIDC 回调完成后必须只把已经完整验证的 issuer 和 subject 传给 `establishFromOidc`。

## 运行配置

启用登录需要在数据库和同步来源配置之外，同时设置 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI` 和至少 32 字符的 `OIDC_TRANSACTION_SECRET`。issuer 和生产回调必须使用 HTTPS；通过 SSH 隧道进行本地开发时，issuer 和回调可以使用 `http://localhost` 或 `http://127.0.0.1`。四项配置不完整时服务会拒绝启动，避免运行一个部分可信的登录流程。`OIDC_UPSTREAM_TIMEOUT_MS` 可在 1–60,000 毫秒内调整 discovery、令牌交换和 JWKS 请求时限，未配置时使用 10,000 毫秒。
