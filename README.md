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
- Review Agent 自适应复习：主动检索 Evaluator 识别的薄弱点，并根据回忆表现动态安排 1、3、7、14 天间隔
- 复习计划预览：展示未来 14 天将再次检索的薄弱点、来源学习日和预计复习日，并在回忆表现变化后即时重排
- 阶段学习笔记：可手动新建或从学习证据生成，按来源日去重追加新证据，不覆盖人工编辑，并支持全文检索、单份 Markdown 导出与确认删除
- 多天进度记录：连续学习天数、最近历史和每日反馈
- 版本化本地保存：保存教学回答、成果和评估，自动迁移旧计划并安全恢复异常数据
- 学习数据控制：导出或验证恢复版本化 JSON 副本，并通过二次确认删除本地记录
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
- 同步安全边界：认证与同步路由按客户端限流，并输出不含 Cookie、令牌、查询参数和正文的结构化安全审计事件
- 多实例容量保护：PostgreSQL 原子共享哈希客户端限流计数，健康端点报告 60 秒滚动的认证/同步容量与延迟
- 响应式界面：支持桌面和移动端
- 自动化测试：覆盖输入校验、路线分期、时间预算、学习状态、关键界面交互和可访问性扫描
- 持续集成：推送和 Pull Request 自动运行测试与生产构建

## 本地运行

需要 Node.js 20.12 或更高版本。

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

然后在 `.env.local` 中填写 `OPENAI_API_KEY` 和 `OPENAI_MODEL`，重新运行 `npm start`。密钥文件不会被 Git 提交。

如果使用 OpenAI-compatible 服务，可改为配置 `OPENAI_COMPATIBLE_API_KEY`、`OPENAI_COMPATIBLE_BASE_URL`，并通过 `OPENAI_MODEL`（或 `OPENAI_COMPATIBLE_MODEL`）指定模型。兼容模式使用 `/v1/chat/completions` 和 JSON Schema 结构化输出；base URL 可填写服务根地址或已经包含 `/v1` 的地址。远端服务必须使用 HTTPS，本机回环开发服务可使用 HTTP；不要同时配置 OpenAI 和兼容服务的两组密钥。

## 验证

```sh
npm test
npm run build
```

开发账号同步服务时，先在 `.env.local` 配置 `DATABASE_URL` 和精确的 `SYNC_ALLOWED_ORIGINS`，运行 `npm run db:migrate`，再启动 API。迁移也会创建多实例共享限流表；缺少最新迁移时受保护路由会拒绝服务，不会退回不安全的单实例配额。未配置数据库时同步保持关闭；配置不完整时服务会直接拒绝启动。启用登录还需同时配置 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI` 和至少 32 字符的 `OIDC_TRANSACTION_SECRET`；配置完成后，页面会显示登录与“立即同步”控制。身份方案和 HTTP 契约见 [`docs/authentication-design.md`](docs/authentication-design.md)。

数据收集边界、导出/删除控制和恢复演练见 [`docs/privacy-and-recovery.md`](docs/privacy-and-recovery.md)。

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
  todo.md           当前产品待办列表
```

## 设计原则

确定性规则作为开发和评估基线保留。配置模型后，Planner Agent 会通过同一个结构化契约调用实时 AI；页面和领域模型不依赖具体厂商。详细设计见 [`docs/ai-architecture.md`](docs/ai-architecture.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，并在提交代码前运行 `npm run check`。

## License

本项目采用 [MIT License](LICENSE)。
