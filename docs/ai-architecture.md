# AI Learning OS AI 架构

## 目标

建立一个可替换、可测试、可评估的 AI 能力层，让 Planner Agent、Teacher Agent、Coach Agent、Evaluator Agent 和 Review Agent 可以共享模型基础设施，同时保持产品逻辑独立于具体模型厂商。

## 核心原则

1. **模型不是产品本身。** 产品价值来自学习闭环、学习者上下文、任务反馈和能力评估。
2. **Agent 不依赖具体厂商。** Agent 只依赖 `ModelProvider` 契约，不直接调用 OpenAI、Claude 或本地模型。
3. **密钥只存在于服务端。** 浏览器不能读取、保存或转发模型 API 密钥。
4. **结构化输出必须验证。** JSON Schema 约束模型格式，领域校验继续验证时间预算和学习规则。
5. **确定性逻辑保留为测试基线。** 没有凭据时仍可开发产品流程，并可比较 AI 计划与规则计划的质量。

## 系统结构

```text
React UI
   │  POST /api/plans、/api/teaching-sessions、/api/evaluations、/api/recovery-plans
   ▼
Local API
   │
   ▼
Planner / Teacher / Coach / Evaluator Agent
   ├── Prompt 与学习规则
   ├── JSON Schema 输出契约
   └── 领域校验
   │
   ▼
ModelProvider
   ├── OpenAIResponsesProvider
   ├── DeterministicModelProvider（开发与测试）
   ├── ClaudeProvider（后续）
   └── LocalModelProvider（后续）
```

## 当前请求流程

1. 用户在浏览器填写学习目标。
2. 浏览器把目标发送到本地 `POST /api/plans`。
3. Planner Agent 验证输入并构造系统指令、用户上下文和 JSON Schema。
4. `ModelProvider` 选择已配置的模型；没有凭据时使用确定性开发实现。
5. Planner Agent 验证模型输出，包括阶段范围、任务初始状态和每日分钟总数。
6. 学习任务通过 Teacher Agent 返回短教学会话，实践任务通过 Evaluator Agent 返回固定量表结果；检测到学习中断时，用户可明确请求 Coach Agent 生成低压力恢复计划。
7. 浏览器把验证后的计划、理解检查回答、成果和评估保存在版本 3 学习记录中。
8. 完成当天学习时，最低掌握度评估的最小下一步和误解会进入次日主动检索；后续间隔根据实际回忆表现动态调整。

## 学习数据控制

浏览器中的学习记录可以导出为版本化 JSON 文件。导出包包含固定格式标识、导出格式版本、UTC 导出时间和完整的版本 3 学习状态，便于用户自行备份或迁移；文件只在浏览器本地生成，不发送到服务端。已归档目标可从归档列表直接导出同一格式的目标命名备份或目标证据 Markdown，无需先恢复为进行中目标，导出也不改变归档状态和当前选择。导入时会校验格式与导出版本、导出时间，以及计划、每日记录、任务、教学成果和评估之间的领域一致性。单目标导入确认后替换同 ID 目标；完整组合导入可只追加本地进行中和归档集合中都不存在的目标 ID，保留本地同 ID 版本、当前选择和时间预算，也可经明确确认用备份全部替换。删除操作也需要明确二次确认，并同时清除当前及旧版本的本地存储键。

每份阶段学习笔记也可单独导出为 UTF-8 Markdown，包含学习目标、阶段、来源学习日、笔记更新时间和导出时间，方便在外部知识库继续使用。删除单份笔记需要二次确认，只移除派生笔记，不删除计划、每日任务或原始学习证据；计划 revision 会按普通本地编辑进入自动同步和冲突保护。

阶段结束回顾保存在学习计划的可选 `retrospectives` 集合中。系统只在阶段最终学习日完成后允许生成，确定性选择评分最高的成果、量表中的强证据和最低分成果的最小下一步作为草稿；四项内容均可编辑，并随计划 revision 进入现有本地导出、进展 Markdown、自动同步和冲突保护。旧计划缺少该字段时按空集合读取，不提升 `LearningState.version`。

页面通过 `LearningStateRepository` 持久化，不直接管理浏览器键名和迁移。未来账号同步采用按计划、学习日和任务产物拆分的服务端模型，以 revision 做乐观并发并以操作 ID 保证重试幂等；完整设计见 [`persistence-model.md`](persistence-model.md)。

## 模型提供者契约

`ModelProvider.generateStructured` 接收：

- `instructions`：稳定的 Agent 身份、职责和规则
- `input`：当前学习者上下文
- `schema`：返回数据的 JSON Schema
- `signal`：可选的取消信号，用于终止已失去调用方的工作

它返回：

- 解析后的结构化数据
- 实际模型名称
- 可选的厂商请求 ID，便于排查问题
- 可选的标准化输入、输出和总 token 用量，用于账号成本记账

OpenAI 实现采用 Responses API，并使用 Structured Outputs 约束返回格式。OpenAI 当前建议将 Responses API 用于推理、工具调用和多轮工作流；模型通过环境变量显式选择，不在代码中绑定某个型号。参考：[Responses API](https://developers.openai.com/api/reference/resources/responses)、[模型指南](https://developers.openai.com/api/docs/guides/latest-model)。

### 调用可靠性

OpenAI Provider 对每次尝试设置 30 秒超时，并对网络错误、408、409、429 和 5xx 响应最多重试两次。重试使用有上限的指数退避；服务返回 `Retry-After` 时优先遵循该值。每次尝试都发送唯一的 `X-Client-Request-Id`，便于在没有收到厂商响应 ID 的超时场景中排查。400 等永久请求错误不会重试。

同一次 Agent 调用只向领域层返回一次最终结果，重试过程不会写入学习状态；OpenAI 请求继续使用 `store: false`。浏览器断开连接时，本地 API 会沿 `AbortSignal` 取消正在执行的 Agent 调用，避免无调用方的模型工作继续消耗资源。超时最终映射为 504，主动取消映射为 499，其他厂商错误保留安全状态码和可选请求 ID。此策略遵循官方的[错误处理建议](https://developers.openai.com/api/docs/guides/error-codes)与[客户端请求 ID 指南](https://developers.openai.com/api/reference/overview#supplying-your-own-request-id-with-x-client-request-id)。

### 成本与容量保护

所有会触发模型工作的 Agent HTTP 入口都在读取请求正文和调用 Provider 前进入限流。当前每客户端每 60 秒最多创建 10 个计划、30 个教学会话、30 个成果评估、30 个复习评估和 20 个恢复计划；启用 PostgreSQL 后配额由所有实例原子共享。拒绝事件只记录动作、路径、状态和限流原因，不记录学习目标、回答、成果正文或模型凭据。

`/api/health` 的 60 秒滚动容量快照按 `ai-plan`、`ai-teaching`、`ai-evaluation`、`ai-review` 和 `ai-recovery` 分组，供 dev 验收和后续集中告警使用。这组分钟级配额是滥用与突发成本的第一层保护。

配置账号预算后，五类 Agent 入口要求有效应用会话，并在读取学习正文和调用 Provider 前检查当前 UTC 月已入账的 token 与估算金额。成功调用按账号、Agent 动作、Provider、模型、输入 token 和输出 token 写入 PostgreSQL；不保存 Prompt 或模型输出。达到任一上限后返回 `429` 和下月重置时间。价格由部署者按所选模型配置为每百万 token 的美元成本，因此切换模型前必须同步更新费率。当前熔断按已完成调用记账，最多可能被同一时间已经在途的有限调用超出；生产仍需接入订阅权益、厂商侧全局金额上限和集中成本告警。

## 配置与安全

本地实时模型通过 `.env.local` 配置：

```sh
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=你选择的模型 ID
AI_API_PORT=8787
# 启用账号预算时四项必须同时配置，并要求 DATABASE_URL 与登录会话
AI_MONTHLY_TOKEN_LIMIT=250000
AI_MONTHLY_COST_LIMIT_USD=12.50
AI_INPUT_COST_PER_MILLION_USD=2.00
AI_OUTPUT_COST_PER_MILLION_USD=8.00
```

安全约束：

- `.env.local` 已加入 `.gitignore`。
- API 密钥不进入前端构建、浏览器存储、日志或 Git。
- 模型错误只向客户端返回安全信息和可选请求 ID。
- 请求体限制为 1 MB，响应禁止缓存。
- OpenAI 请求使用 `store: false`；正式上线前仍需完成隐私、保留策略和用户告知设计。

## 开发模式与 AI 模式

### 开发模式

未配置 OpenAI 环境变量时，API 使用 `DeterministicModelProvider`。`GET /api/health` 返回 `aiEnabled: false`，界面和 Agent 流程仍可完整测试。

### AI 模式

同时配置 `OPENAI_API_KEY` 和 `OPENAI_MODEL` 后，API 使用 `OpenAIResponsesProvider`，健康检查返回 `aiEnabled: true`。仅配置其中一项会拒绝启动，防止误以为 AI 已启用。

## Agent 边界

### Planner Agent

当前已实现。负责把目标转化为阶段路线和每日任务，并保证任务总时长符合用户预算。

### Teacher Agent

当前服务端契约与 API 已实现。`POST /api/teaching-sessions` 接收学习目标、当前任务，以及已知概念和近期错误；输出一个短教学会话：

- 单一核心概念与针对当前水平的解释
- 一个完整示例
- 2–3 个要求主动回忆或迁移的理解检查
- 一个最小实践题
- 可观察、可供后续评估的完成信号

理解检查 ID 必须唯一，检查和完成信号不能为空。页面会保存教学会话和书面回答；只有完成全部主动理解检查后，学习任务才能结束。

### Evaluator Agent

当前服务端契约与 API 已实现。`POST /api/evaluations` 接收学习目标、当前任务和学习者成果，使用四个固定维度评分，每项 0–4 分：

| 维度 | 评估重点 |
| --- | --- |
| `understanding` | 能否准确解释核心概念和机制 |
| `application` | 能否把概念应用于当前任务或新场景 |
| `evidence` | 是否提供可复查的结果、测试或观察 |
| `reflection` | 能否识别错误、边界和改进方向 |

总分 0–7 为 `needs-support`，8–12 为 `developing`，13–16 为 `ready`。Agent 领域层会重新计算总分并校验等级，防止格式正确但自相矛盾的模型输出进入产品。每项必须包含提交内容中的证据和可执行反馈，结果还包含误解列表和唯一的最小下一步。页面会保存成果与结果，并在完成当天学习时把最低分评估的下一步带入次日教学任务。

### Coach Agent

当前服务端契约与 API 已实现。领域层从版本 3 学习记录确定性识别两类需要恢复支持的信号：当前学习日之后至少出现两个完整空档日，或最近两个已完成学习日都反馈为 `too-hard`。页面只展示邀请，不自动调用模型；学习者明确选择后，`POST /api/recovery-plans` 接收目标、当前未完成任务和中断上下文，返回 2–3 个恢复步骤。

恢复计划总时长必须为 10–20 分钟且不超过每日预算，每步至少 3 分钟。Agent 使用不评判的语言，不要求补完错过的内容，也不改写长期计划，只帮助学习者重新启动当前任务。输出分钟数、步骤唯一性和必填内容都会经过领域校验；计划目前是即时辅导，不写入学习记录，因此不需要数据迁移。

### Review Agent

当前实现从版本 3 学习记录中的 Evaluator 结果派生复习任务，不保存第二份复习队列。掌握度未达到 `ready` 或仍包含误解的最低分评估，会在次日进入当天诊断任务；复习要求先闭卷解释误解并复述最小下一步。用户记录“忘记了”“费力想起”或“轻松想起”后，下一次间隔分别调整为 1 天、3 天或 7 天；连续轻松回忆会延长到 14 天。页面使用同一确定性派生函数预览未来 14 天的来源学习日、薄弱点和到期日，记录新表现后立即重排。

领域层还会按阶段聚合 Evaluator 的误解证据。匹配键只移除大小写、空白和标点差异；相同键至少覆盖两个阶段后，才输出阶段、来源日、各次最小下一步和一条对比式主动回忆提示。页面与进展导出消费同一派生结果。单阶段重复不会被误报，语义相近但表述不同的误解也不会被自动合并。复习表现和阶段关联都由版本 3 产物确定性派生，因此旧记录无需迁移。

### 阶段与目标掌握度

阶段掌握度从已保存的 Evaluator 四维量表和补强证据实时派生，不增加第二份同步状态。普通成果按完成学习日所属阶段归属；带 `stageMasteryRemediation.stageId` 的补强成果只归入显式来源阶段，即使补强发生在另一阶段或计划外学习日也不重复计数或污染当前日历阶段。目标级报告再聚合所有已完成阶段：未完成全部阶段时标记为进行中；日程完成后仍单独判断是否全部证据达标。优先项先选择缺少任何评估证据的阶段，再选择平均总分最低的待加强阶段，最后以阶段顺序稳定打破平局。界面和 Markdown 导出调用同一领域函数，结论保持可解释且不阻断归档。独立目标证据报告还遍历同一组规范化阶段证据，输出成果正文、任务来源、逐维分数、Evaluator 证据与反馈、误解和最小下一步，避免汇总数字无法追溯到原始学习记录。

### 阶段学习笔记

页面可为当前阶段手动新建笔记，也可确定性汇总教学讲解、书面理解、实践成果、Evaluator 反馈和每日复盘。笔记绑定稳定的阶段 ID，记录来源学习日与更新时间，保存在 `LearningPlan.notes` 中，因此会随计划参与本地导出和跨设备同步。每个阶段只保留一份笔记；追加证据时只读取尚未记录的来源日，把新证据加在正文末尾，不重写学习者编辑过的标题或已有正文，也不会重复追加同一天内容。学习者仍可编辑标题和正文，并在浏览器内全文检索。旧计划没有 `notes` 时按空集合读取，无需提升 `LearningState.version`。

## 测试策略

- Provider 契约测试：请求结构、响应解析、错误映射、超时、取消、有限重试和密钥边界
- Agent 领域测试：学习规则不能被格式正确但内容错误的模型输出绕过
- API 测试：状态、输入校验和完整计划生成
- Teacher/Coach/Evaluator 契约测试：必需教学元素、理解检查唯一性、恢复时间预算、固定量表、总分和掌握等级一致性
- Evals：使用固定学习者样本比较相关性、难度、可执行性和时间预算
- 端到端测试：浏览器创建目标并获得来自本地 API 的计划
- 组件交互与可访问性：在 `jsdom` 中验证关键数据控制流程，并使用 axe-core 扫描渲染后的语义结构；颜色对比仍需在真实浏览器中单独验证

## 暂不采用

- 自行训练基础模型
- 首版即引入复杂 Multi-Agent 编排框架
- 让浏览器直接调用模型厂商
- 在没有 Evals 的情况下自动切换模型
- 把所有学习历史一次性放入 Prompt
