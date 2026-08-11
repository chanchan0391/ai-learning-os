# AI Learning OS

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

AI Learning OS 是一个 AI 原生个人学习操作系统。当前版本实现了第一条可运行的 AI 学习闭环：Planner Agent 生成路线，Teacher Agent 提供短教学和主动理解检查，Evaluator Agent 根据成果证据反馈，并把最小下一步带入后续计划。

## 当前能力

- 创建学习目标：主题、当前基础、目标结果、每日时间和学习周期
- Planner Agent 领域逻辑：生成分阶段学习路线
- 服务端 Agent API：浏览器不接触模型密钥
- 可替换模型层：OpenAI Responses API 与确定性开发实现
- 稳健的 Agent 调用：30 秒单次超时、可取消请求和瞬时故障有限重试
- Coach Agent 起始闭环：诊断、学习、实践、复盘四类每日任务，并根据难度反馈生成下一天
- Coach Agent 恢复支持：识别至少两个空档日或连续两天偏难，在用户明确请求后生成不追赶旧进度的 10–20 分钟低压力重启计划
- Teacher Agent 教学会话：短讲解、示例、书面主动理解检查和可观察完成信号
- Evaluator Agent 成果反馈：四维证据量表、领域一致性校验和最小下一步
- 自适应次日计划：同时结合任务难度、评估结果和已识别误解
- Review Agent 自适应复习：自动判分闭卷主动回忆答案、保存证据反馈，并据此动态安排 1、3、7、14 天间隔
- 复习计划预览：展示未来 14 天将再次检索的薄弱点、来源学习日和预计复习日，并在回忆表现变化后即时重排
- 学习周回顾：从最近 7 个完成日派生投入时间、成果评分、偏难日、轻松回忆次数和唯一的最小下一步，并可连同阶段进展导出 Markdown
- 纵向学习趋势：用最近与此前的等长完成日窗口比较成果评分、偏难日和轻松回忆变化，证据不足时不做趋势判断
- 跨阶段误解关联：发现经大小写、空白和标点归一后在至少两个阶段重复出现的误解，可一键加入当天任务、自动判分，并把所有关联来源纳入后续自适应复习
- 阶段结束回顾：完成阶段后从成果评估与复盘生成目标总结、代表成果、可迁移能力和下一阶段应用，并允许逐项编辑
- 阶段与目标掌握度检查：阶段完成后汇总理解、应用、证据和反思四维评估；目标级汇总区分日程完成与全部阶段证据达标，并可直接补强最需要证据的阶段；补强实践保留来源并在评估后展示四维与总分变化，同时保持当天总时间预算不变；计划结束后仍可为任一未达标阶段开启补强学习日再归档
- 目标证据报告：计划完成后导出独立 Markdown，汇总目标结论、各阶段四维证据、补强变化与阶段回顾，并附成果正文、逐维证据反馈和最小下一步的可审计明细
- 完整学习日历：按自然月回看每日学习状态、投入时间、成果评分、难度反馈和反思
- 阶段学习笔记：可手动新建或从学习证据生成，按来源日去重追加新证据，不覆盖人工编辑，并支持全文检索、单份 Markdown 导出与确认删除
- 多天进度记录：连续学习天数、最近历史和每日反馈
- 已完成目标归档：保留完整计划与学习证据，登录后跨设备上传和下载，可不恢复目标直接导出版本化备份或证据报告，也可恢复查看并立即创建下一个目标
- 并行目标同步：保留多个进行中计划，可随时新建、切换，并按目标隔离 revision 与内容指纹跨设备同步；旧单目标存储和同步元数据会自动迁移
- 跨目标学习首页：汇总全部进行中目标的今日总工作量与需关注数量，并逐个展示剩余任务、恢复或复习风险，以及最近完成成果
- 跨目标每日预算：设置所有进行中目标共享的本地时间上限，按完整计划工作量提示超载并给出缩减优先级
- 跨目标每日清单：按预算和恢复/复习风险轮转安排完整任务，可直接跳转到对应目标执行
- 跨目标周回顾：按自然周窗口比较各目标投入占比、成果评分变化与偏难风险，推荐一个优先目标，并可导出 Markdown 长期留存
- 版本化本地保存：保存教学回答、成果和评估，自动迁移旧计划并安全恢复异常数据
- 学习数据控制：可导出单目标记录，也可一次备份全部进行中目标、归档目标和本地时间预算；恢复前完整校验并预览新增、跳过、移除和预算变化，同 ID 目标可并排比较进度并逐个选择本地或备份版本，也可明确确认全部替换；覆盖本地证据前会自动下载恢复前组合备份
- 账号数据控制：已登录用户可在二次确认后删除账号、云端学习数据、设备、会话和当前浏览器记录
- 账号安全控制：可经确认一次撤销全部设备和登录会话，同时保留本地与云端学习记录
- 登录设备管理：查看当前活跃设备，并可单独撤销不再使用设备的全部会话
- 可替换持久化边界：页面通过仓库接口保存进度，为账号与跨设备同步预留并发模型
- 同步领域契约：按认证用户隔离计划与每日记录，验证 revision 冲突、不透明游标和幂等重试
- PostgreSQL 同步适配器：事务化条件写入、设备校验、持久幂等记录和可执行迁移
- 服务端会话生命周期：映射验证后的 OIDC 身份、登记设备，只保存不透明令牌哈希，并支持会话查询、原子轮换和登出撤销
- Provider-neutral OIDC 登录：discovery、签名 state/nonce 事务、S256 PKCE、授权码交换和 JWKS ID Token 验证
- 账号与跨设备同步界面：登录后自动合并本地与云端进度，合并快速连续编辑，离线时保留待同步状态并在恢复连接后重试，同时显示最近同步时间
- 冲突安全：两端同时更改时停止自动重试，先预览本地与云端摘要，再明确选择要保留的冲突版本
- 同步安全边界：认证与同步路由按客户端限流，并输出不含原始账号/设备 ID、Cookie、令牌、查询参数和正文的结构化安全审计事件；稳定伪名引用支持短期事件关联
- 浏览器响应安全：API 与 dev Web 入口使用 CSP、禁止跨站嵌入和 MIME 嗅探，并关闭未使用的敏感浏览器能力与 Referrer 泄露
- AI 成本滥用保护：计划、教学、评估、复习和恢复 Agent 分别使用按客户端固定窗口配额，限流拒绝发生在读取正文和调用模型之前
- Agent 输入成本边界：五类模型请求最多接收 64 KiB JSON，并同时覆盖声明长度和分块传输，避免异常学习内容放大输入 token 成本
- 浏览器 API 响应边界：Agent 响应最多 1 MiB、认证响应最多 64 KiB，同步响应最多 9 MiB；声明或流式响应越界时停止读取
- Agent 并发保护：每个 API 实例默认只同时执行 20 个模型任务，满载时在读取正文和调用模型前安全拒绝，并通过健康端点报告容量
- 账号模型预算：可选 PostgreSQL 用量账本按 Agent 与模型记录 token 和估算成本，并以月度 token/金额上限在调用前熔断
- 多实例容量保护：PostgreSQL 原子共享哈希客户端限流计数，健康端点报告 60 秒滚动的 Agent、认证与同步容量和延迟
- 数据库容量监控：健康端点报告 PostgreSQL 连接池上限、打开、空闲、使用中、等待数量和饱和状态，不包含账号、查询或连接信息
- 反向代理限流边界：默认忽略转发地址；只为显式受信的直连代理采用其追加的客户端地址，避免共享代理配额和伪造来源
- 单实例限流容量边界：无数据库模式最多保留 10,000 个客户端与路由范围窗口，容量满时回收过期项并对新身份安全拒绝
- 响应式界面：支持桌面和移动端
- 自动化测试：覆盖输入校验、路线分期、时间预算、学习状态、关键界面交互和可访问性扫描
- Agent 发布评估：固定合成案例覆盖五类 Agent 的质量门槛、延迟和 token 用量，实时模型运行需要显式成本授权
- 持续集成：推送和 Pull Request 自动运行测试与生产构建

## 本地运行

需要 Node.js 22.22.2 或同一主版本的更高版本。NVM 用户可在仓库目录执行 `nvm use`，`.nvmrc` 会选择已验证的 22.23.1。`package.json` 会拒绝不受支持的主版本，CI 与 dev 部署也统一使用 Node.js 22。

### 最简单方式（macOS）

双击项目根目录的 `Start AI Learning OS.command`。启动窗口会自动打开浏览器；关闭终端窗口即可停止应用。

不要直接双击 `index.html`。它是开发入口文件，需要由本地服务处理；直接打开时页面会显示正确的启动提示。

### 命令行方式

```sh
npm install
npm start
```

`npm start` 会启动应用并自动打开浏览器。

默认使用不需要凭据的确定性开发模式。要启用真实 AI 模型：

```sh
cp .env.example .env.local
```

然后在 `.env.local` 中填写 `OPENAI_API_KEY` 和 `OPENAI_MODEL`，重新运行 `npm start`。密钥文件不会被 Git 提交。所有模型响应默认最多使用 4096 个输出 token；可用 `OPENAI_MAX_OUTPUT_TOKENS` 在 32,768 的硬上限内显式调整，并应以固定评估集验证更低上限不会截断结构化结果。一次调用默认总时限为 60 秒，`OPENAI_TOTAL_TIMEOUT_MS` 最多可配置为 120 秒。

每个 API 实例默认最多同时执行 20 个 Agent 请求；可用正整数 `AI_MAX_CONCURRENT_AGENT_REQUESTS` 按可用内存、连接预算和模型配额调整。满载响应为可重试 `503`，并且不会读取学习正文或启动新的模型调用。

如果使用 OpenAI-compatible 服务，可改为配置 `OPENAI_COMPATIBLE_API_KEY`、`OPENAI_COMPATIBLE_BASE_URL`，并通过 `OPENAI_MODEL`（或 `OPENAI_COMPATIBLE_MODEL`）指定模型。兼容模式使用 `/v1/chat/completions` 和 JSON Schema 结构化输出；base URL 可填写服务根地址或已经包含 `/v1` 的地址。远端服务必须使用 HTTPS，本机回环开发服务可使用 HTTP；不要同时配置 OpenAI 和兼容服务的两组密钥。

## 验证

```sh
npm test
npm run build
npm run eval:agents
```

开发账号同步服务时，先在 `.env.local` 配置 `DATABASE_URL` 和精确的 `SYNC_ALLOWED_ORIGINS`，运行 `npm run db:migrate`，再启动 API。非回环数据库还必须设置 `DATABASE_TLS_MODE=verify-full`，由 PostgreSQL 客户端验证服务器证书和主机名；TLS 选项不能混入连接 URL，以免配置优先级产生歧义。迁移也会创建多实例共享限流表；缺少最新迁移时受保护路由会拒绝服务，不会退回不安全的单实例配额。未配置数据库时同步保持关闭；配置不完整时服务会直接拒绝启动。运行时默认每实例最多使用 10 条 PostgreSQL 连接，并对连接获取、空闲连接、连接生命周期、语句、查询等待和空闲事务设置时限；可用 `DATABASE_POOL_MAX`、`DATABASE_CONNECTION_TIMEOUT_MS`、`DATABASE_IDLE_TIMEOUT_MS`、`DATABASE_MAX_LIFETIME_SECONDS`、`DATABASE_STATEMENT_TIMEOUT_MS`、`DATABASE_QUERY_TIMEOUT_MS` 和 `DATABASE_IDLE_TRANSACTION_TIMEOUT_MS` 调整。`/api/health` 的 `databasePool` 快照可用于监控连接使用和等待者；未启用数据库时该值为 `null`。启用登录还需同时配置 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI` 和至少 32 字符的 `OIDC_TRANSACTION_SECRET`；配置完成后，页面会显示登录与“立即同步”控制。单账号默认最多允许 100 个同时具有有效会话的设备，可用 `AUTH_MAX_ACTIVE_DEVICES` 收紧。身份方案和 HTTP 契约见 [`docs/authentication-design.md`](docs/authentication-design.md)。

实时模型必须同时配置 `AI_MONTHLY_TOKEN_LIMIT`、`AI_MONTHLY_COST_LIMIT_USD`、`AI_INPUT_COST_PER_MILLION_USD` 和 `AI_OUTPUT_COST_PER_MILLION_USD`，从而启用账号模型成本熔断、要求 Agent API 登录并阻止凭据误配置成公开未计量端点；费率应与实际模型价格一致。只有隔离的本地实时烟雾测试可以显式设置 `AI_ALLOW_UNMETERED_LIVE_MODEL=true` 绕过该启动保护，任何共享或部署环境都不得使用。可再配置 `AI_GLOBAL_MONTHLY_COST_LIMIT_USD`，让所有账号的已入账估算成本达到应用总上限后统一停止新调用。若启用 `AI_SUBSCRIPTION_ENTITLEMENTS_REQUIRED`，还必须用 `AI_PLAN_BUDGETS_JSON` 显式定义每个可用套餐的月度 token 与金额配额；未知套餐默认拒绝。账本按厂商返回的成功调用用量记账，不保存 Prompt 或模型输出；Agent 单次 JSON 输入限制为 64 KiB，单次输出默认限制为 4096 token，两者共同缩小在途调用成本，但不消除并发检查窗口，生产仍需配置模型厂商侧的独立硬上限。

数据收集边界、导出/删除控制和恢复演练见 [`docs/privacy-and-recovery.md`](docs/privacy-and-recovery.md)。Agent 质量、成本评估集和实时运行门禁见 [`docs/agent-evaluation.md`](docs/agent-evaluation.md)。

## 项目结构

```text
src/
  App.tsx           页面与本地交互状态
  learning-state.ts 多天状态、教学成果、评估、迁移与下一天生成
  learning-storage.ts 本地持久化仓库与版本键迁移
  sync-client.ts     账号会话、条件同步、云端恢复与冲突保护
  sync-queue.ts      自动同步合并、持久待办、离线恢复与退避重试
  planner.ts        Planner Agent 领域逻辑
  planner.test.ts   自动化测试
  types.ts          核心领域类型
  styles.css        视觉系统与响应式布局
server/
  agents/           Planner、Teacher、Coach、Evaluator 的编排、Prompt 和领域校验
  ai/               模型提供者契约与厂商适配器
  evals/            五类 Agent 的固定质量、延迟与 token 发布评估
  sync/             跨设备同步领域契约与用户隔离测试
  auth/             OIDC 登录、应用会话与可信用户/设备身份边界
  runtime-config.ts 数据库、会话和允许来源的启动组合
  app.ts            本地 HTTP API
docs/
  ai-architecture.md AI 能力架构与安全边界
  mvp-spec.md       MVP 范围与产品决策
  persistence-model.md 持久化、所有权与同步设计
  authentication-design.md OIDC、服务端会话与身份信任边界
  privacy-and-recovery.md 数据边界、用户控制与恢复演练
  agent-evaluation.md Agent 评估集、隐私边界与实时成本门禁
  todo.md           当前产品待办列表
```

## 设计原则

确定性规则作为开发和评估基线保留。配置模型后，Planner Agent 会通过同一个结构化契约调用实时 AI；页面和领域模型不依赖具体厂商。详细设计见 [`docs/ai-architecture.md`](docs/ai-architecture.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，并在提交代码前运行 `npm run check`。

## License

本项目采用 [MIT License](LICENSE)。
