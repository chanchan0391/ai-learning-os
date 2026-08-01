# AI Learning OS 持久化模型

## 目标

在不破坏当前本地优先体验的前提下，为账号与跨设备同步建立稳定的数据边界。当前版本默认先写入浏览器，已登录用户的更改进入自动同步队列；服务端按计划和每日记录分别持久化，避免直接把整份浏览器 JSON 当作长期数据库模型。

## 当前实现边界

React 页面通过 `LearningStateRepository` 读写学习状态，默认实现是 `BrowserLearningStateRepository`。该适配器负责：

- 按 `v3 → v2 → v1` 顺序发现本地记录；
- 复用领域层校验和迁移，不在存储层复制规则；
- 把迁移结果提升到当前键并删除旧键；
- 对损坏数据安全重置；
- 清除所有受支持的本地版本。

这让界面不依赖学习状态的 `localStorage` 键名。`BrowserSyncClient` 另外保存不含学习正文的 revision 和内容指纹，用来判断本地更改、远端更改和两端冲突；`AutoSyncQueue` 只保存是否仍有待同步更改和最近成功时间，不复制学习正文。同步元数据损坏时可以安全丢弃，不影响本地学习记录。

服务端包含不对外暴露的 `InMemorySyncStore` 领域基线，以及实现同一语义的 `PostgresSyncStore`。PostgreSQL 版本通过事务、用户行锁、复合外键和持久幂等记录覆盖并发写入；迁移位于 `server/sync/migrations/`，可通过 `npm run db:migrate` 执行。调用方必须先从可信会话解析 `userId` 和 `deviceId`，再传入存储层；存储层不会接受客户端提交的所有者字段。当前实现覆盖：

- 学习计划和每日记录的独立实体写入；
- 阶段学习笔记作为计划实体的一部分同步，保留阶段绑定、已追加的来源学习日和更新时间；来源日同时作为证据追加的去重边界；
- 从 1 开始递增的 revision 与条件更新冲突；
- 按用户隔离的幂等操作键；
- 绑定用户的不透明增量游标；
- 每日记录只能引用当前用户拥有的计划。

内存版本只用于测试领域规则，进程重启会丢失数据。PostgreSQL 版本已经通过兼容数据库集成测试。同步 HTTP 路由已通过可信身份解析器连接统一的 `SyncStore` 契约，并完成请求结构、条件头、来源白名单和错误映射。服务启动配置在同时提供 `DATABASE_URL` 与精确 `SYNC_ALLOWED_ORIGINS` 时注入 PostgreSQL 仓库和哈希会话解析器；配置缺失时同步关闭，配置不完整或来源不安全时拒绝启动。OIDC 登录回调、会话创建、轮换和登出已经接入页面。认证与同步端点限流、安全审计、账号删除和隐私说明已实现。生产部署仍需完成真实 OIDC/数据库恢复演练，并公布其备份、日志和模型提供商保留期限。

## 服务端关系模型

服务端以 PostgreSQL 为首选持久层。结构化列用于查询、所有权和并发控制；Agent 产物保留为带版本的 JSON，避免模型输出迭代导致频繁拆表。

当前首个迁移先落地同步所需的 `users`、`sync_devices`、`learning_plans`、`daily_records`、`sync_operations` 和 `sync_cursors`。计划与每日记录暂以已验证的 `value` JSONB 保存，同时用独立列固定所有权、外键、revision、更新时间和变更序列；下表中的阶段、任务和产物拆表会在同步 HTTP 试点前继续实施。

| 表 | 关键字段 | 约束与用途 |
| --- | --- | --- |
| `users` | `id`, `created_at`, `deleted_at` | 身份主体；当前删除接口硬删除该行并触发全部所属数据级联清除 |
| `learning_plans` | `id`, `user_id`, `subject`, `current_level`, `target_outcome`, `daily_minutes`, `duration_weeks`, `created_at`, `updated_at`, `revision` | `user_id` 强制所有权；`revision` 支持乐观并发 |
| `learning_stages` | `id`, `plan_id`, `position`, `title`, `outcome`, `start_week`, `end_week` | `(plan_id, position)` 与 `(plan_id, id)` 唯一 |
| `daily_records` | `id`, `plan_id`, `day_number`, `local_date`, `status`, `completed_at`, `difficulty`, `reflection`, `revision` | `(plan_id, day_number)` 唯一；每天独立同步 |
| `daily_tasks` | `id`, `daily_record_id`, `position`, `type`, `title`, `description`, `minutes`, `completed` | `(daily_record_id, position)` 与 `(daily_record_id, id)` 唯一 |
| `task_artifacts` | `daily_task_id`, `schema_version`, `teaching_session`, `understanding_responses`, `submission`, `evaluation`, `updated_at` | 每个任务最多一个产物集合；JSON 写入前必须走领域校验 |
| `sync_devices` | `id`, `user_id`, `label`, `last_seen_at`, `revoked_at` | 可撤销设备身份，不保存浏览器指纹 |
| `auth_sessions` | `token_hash`, `user_id`, `device_id`, `expires_at`, `revoked_at` | 只保存不透明会话令牌哈希；绑定可撤销设备并强制过期 |
| `sync_operations` | `id`, `user_id`, `device_id`, `operation_id`, `entity_type`, `entity_id`, `base_revision`, `created_at` | `(user_id, operation_id)` 唯一，保证重试幂等 |

所有业务表都包含 `user_id` 或通过不可绕过的外键链归属用户。数据库访问必须在事务内绑定已认证用户，任何客户端提交的 `user_id` 都不可信。

## 同步契约

首版同步使用按实体的拉取与条件写入，不采用最后写入获胜覆盖整份计划。

```text
GET  /api/sync/changes?cursor=<opaque>
PUT  /api/sync/plans/:id
PUT  /api/sync/daily-records/:id
     If-Match: "<revision>"
     Idempotency-Key: <uuid>

200  返回新 revision
409  返回服务端当前实体，客户端提示用户选择保留版本
```

- 创建实体使用 `If-None-Match: *`，更新实体使用带引号的 `If-Match: "<revision>"`；缺失条件头返回 `428`。
- 写入请求必须来自服务端配置的精确 Origin 白名单；身份只由会话解析器提供，正文、查询和路由中的用户字段都不会被信任。
- 计划写入正文是完整 `LearningPlan`；每日记录正文为 `{ "planId": "...", "record": DailyLearningRecord }`。路由在进入仓库前执行完整领域校验。
- 成功写入通过 `ETag` 返回新 revision。revision 冲突和幂等键复用返回 `409`，无效游标返回 `400`，缺少所属计划返回 `422`。
- 服务端游标是不透明、单调推进的值；客户端不能从时间戳推导游标。
- 每次写入携带 `base_revision` 与幂等键；重复请求返回第一次写入的结果。
- 不自动合并同一任务的长文本、理解回答或评估。不同学习日可独立同步。
- 阶段笔记新建、编辑或追加证据都会更新计划 revision；单设备追加只添加尚未记录的来源日，两台设备并发修改时仍沿用计划级冲突预览，不执行长文本自动合并。
- 离线创建的 ID 使用 UUID，避免设备之间碰撞。
- 完成日和评估写入在同一事务中验证，不能产生“已完成但缺少必需成果”的状态。

### 浏览器自动队列

- 登录后执行一次初始同步；本地编辑先持久化到浏览器，再以 1.5 秒防抖合并快速连续更改。
- 队列只记录 `pending` 和最近成功时间。页面重载后会继续处理待办，不把第二份学习正文写入队列。
- 浏览器报告离线时不发送请求；`online` 事件会立即恢复。其他瞬时失败采用有上限的退避重试。
- 本地与云端同时修改同一实体时停止自动重试，保留待办并要求用户比较版本。完成明确选择后才清除待办。
- “立即同步”保留为手动刷新入口，并复用同一队列和冲突边界。

## 版本与迁移

需要区分三个版本：

1. `LearningState.version`：浏览器领域快照版本，当前为 3。
2. `task_artifacts.schema_version`：Agent 产物形状版本。
3. 数据库迁移版本：由迁移工具维护，只描述物理结构。

导入旧快照时先在应用层升级并完整校验，再拆分写入服务端表。服务端读取旧 Agent 产物时使用显式升级器；未知版本不得静默丢字段。

## 隐私、保留与恢复

- 默认只收集学习闭环需要的内容，不保存模型密钥、浏览器指纹或原始模型请求日志。
- 退出所有设备通过当前有效会话授权，在一个数据库事务中撤销该用户全部设备和会话，不删除学习数据。删除账号则硬删除用户行，并由外键级联清除身份、设备、会话、计划、每日记录、游标和幂等记录。
- 备份加密、传输加密和按用户授权是上线阻断项。
- 导出继续使用可移植快照；恢复到已有云计划前必须预览并确认。
- 服务端写入、同步冲突和删除流程都要有不含学习正文的安全审计事件。

## 分阶段实施

1. **已完成：本地仓库边界。** 页面不再直接管理键发现、迁移和删除。
2. **已完成首版：认证与远端仓库。** 已选择 OIDC 授权码 + PKCE 与服务端会话方案，并完成可信会话解析、OIDC 身份映射、用户与设备登记、会话创建/轮换/登出、PostgreSQL 适配器、迁移、启动注入及用户隔离测试。
3. **已完成服务端同步试点。** HTTP API 已验证计划与每日记录的领域校验、revision、游标、幂等、来源校验和错误映射。
4. **已完成首版：离线与冲突界面。** 页面已提供自动队列、离线恢复、退避重试、最近同步时间、显式刷新、写入前冲突检查、本地/云端版本摘要和明确保留选择。
5. **已完成本地上线准备基线。** 已实现账号级联删除、隐私说明、可重复的恢复演练清单、滚动容量指标和 PostgreSQL 多实例共享限流；真实部署仍需执行 OIDC/数据库恢复演练。
