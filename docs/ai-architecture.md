# AI Learning OS AI 架构

## 目标

建立一个可替换、可测试、可评估的 AI 能力层，让 Planner Agent、Teacher Agent、Coach Agent 和 Evaluator Agent 可以共享模型基础设施，同时保持产品逻辑独立于具体模型厂商。

## 核心原则

1. **模型不是产品本身。** 产品价值来自学习闭环、学习者上下文、任务反馈和能力评估。
2. **Agent 不依赖具体厂商。** Agent 只依赖 `ModelProvider` 契约，不直接调用 OpenAI、Claude 或本地模型。
3. **密钥只存在于服务端。** 浏览器不能读取、保存或转发模型 API 密钥。
4. **结构化输出必须验证。** JSON Schema 约束模型格式，领域校验继续验证时间预算和学习规则。
5. **确定性逻辑保留为测试基线。** 没有凭据时仍可开发产品流程，并可比较 AI 计划与规则计划的质量。

## 系统结构

```text
React UI
   │  POST /api/plans、/api/teaching-sessions、/api/evaluations
   ▼
Local API
   │
   ▼
Planner / Teacher / Evaluator Agent
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
6. 学习任务通过 Teacher Agent 返回短教学会话，实践任务通过 Evaluator Agent 返回固定量表结果。
7. 浏览器把验证后的计划、理解检查回答、成果和评估保存在版本 3 学习记录中。
8. 完成当天学习时，最低掌握度评估的最小下一步和误解会进入次日任务。

## 学习数据控制

浏览器中的学习记录可以导出为版本化 JSON 文件。导出包包含固定格式标识、导出格式版本、UTC 导出时间和完整的版本 3 学习状态，便于用户自行备份或后续迁移；文件只在浏览器本地生成，不发送到服务端。删除操作需要明确二次确认，并同时清除当前及旧版本的本地存储键。当前版本尚不支持从导出文件恢复，避免在没有完整导入校验和冲突策略时写回数据。

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

OpenAI 实现采用 Responses API，并使用 Structured Outputs 约束返回格式。OpenAI 当前建议将 Responses API 用于推理、工具调用和多轮工作流；模型通过环境变量显式选择，不在代码中绑定某个型号。参考：[Responses API](https://developers.openai.com/api/reference/resources/responses)、[模型指南](https://developers.openai.com/api/docs/guides/latest-model)。

### 调用可靠性

OpenAI Provider 对每次尝试设置 30 秒超时，并对网络错误、408、409、429 和 5xx 响应最多重试两次。重试使用有上限的指数退避；服务返回 `Retry-After` 时优先遵循该值。每次尝试都发送唯一的 `X-Client-Request-Id`，便于在没有收到厂商响应 ID 的超时场景中排查。400 等永久请求错误不会重试。

同一次 Agent 调用只向领域层返回一次最终结果，重试过程不会写入学习状态；OpenAI 请求继续使用 `store: false`。浏览器断开连接时，本地 API 会沿 `AbortSignal` 取消正在执行的 Agent 调用，避免无调用方的模型工作继续消耗资源。超时最终映射为 504，主动取消映射为 499，其他厂商错误保留安全状态码和可选请求 ID。此策略遵循官方的[错误处理建议](https://developers.openai.com/api/docs/guides/error-codes)与[客户端请求 ID 指南](https://developers.openai.com/api/reference/overview#supplying-your-own-request-id-with-x-client-request-id)。

## 配置与安全

本地实时模型通过 `.env.local` 配置：

```sh
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=你选择的模型 ID
AI_API_PORT=8787
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

当前先由确定性规则完成最小闭环：保存每日完成状态、难度、反思和评估，并据此调整下一天任务的范围、挑战度与重点误解。后续 Coach Agent 会在相同数据契约上加入中断分析和更长期的节奏调整，而不是直接改变长期目标。

## 测试策略

- Provider 契约测试：请求结构、响应解析、错误映射、超时、取消、有限重试和密钥边界
- Agent 领域测试：学习规则不能被格式正确但内容错误的模型输出绕过
- API 测试：状态、输入校验和完整计划生成
- Teacher/Evaluator 契约测试：必需教学元素、理解检查唯一性、固定量表、总分和掌握等级一致性
- Evals：使用固定学习者样本比较相关性、难度、可执行性和时间预算
- 端到端测试：浏览器创建目标并获得来自本地 API 的计划
- 组件交互与可访问性：在 `jsdom` 中验证关键数据控制流程，并使用 axe-core 扫描渲染后的语义结构；颜色对比仍需在真实浏览器中单独验证

## 暂不采用

- 自行训练基础模型
- 首版即引入复杂 Multi-Agent 编排框架
- 让浏览器直接调用模型厂商
- 在没有 Evals 的情况下自动切换模型
- 把所有学习历史一次性放入 Prompt
