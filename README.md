# AI Learning OS

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

AI Learning OS 是一个 AI 原生个人学习操作系统。当前版本实现了第一条可运行的 AI 学习闭环：Planner Agent 生成路线，Teacher Agent 提供短教学和主动理解检查，Evaluator Agent 根据成果证据反馈，并把最小下一步带入后续计划。

## 当前能力

- 创建学习目标：主题、当前基础、目标结果、每日时间和学习周期
- Planner Agent 领域逻辑：生成分阶段学习路线
- 服务端 Agent API：浏览器不接触模型密钥
- 可替换模型层：OpenAI Responses API 与确定性开发实现
- Coach Agent 起始闭环：诊断、学习、实践、复盘四类每日任务，并根据难度反馈生成下一天
- Teacher Agent 教学会话：短讲解、示例、书面主动理解检查和可观察完成信号
- Evaluator Agent 成果反馈：四维证据量表、领域一致性校验和最小下一步
- 自适应次日计划：同时结合任务难度、评估结果和已识别误解
- 多天进度记录：连续学习天数、最近历史和每日反馈
- 版本化本地保存：保存教学回答、成果和评估，自动迁移旧计划并安全恢复异常数据
- 学习数据控制：下载版本化 JSON 副本，并通过二次确认删除本地记录
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

## 验证

```sh
npm test
npm run build
```

## 项目结构

```text
src/
  App.tsx           页面与本地交互状态
  learning-state.ts 多天状态、教学成果、评估、迁移与下一天生成
  planner.ts        Planner Agent 领域逻辑
  planner.test.ts   自动化测试
  types.ts          核心领域类型
  styles.css        视觉系统与响应式布局
server/
  agents/           Planner、Teacher、Evaluator 的编排、Prompt 和领域校验
  ai/               模型提供者契约与厂商适配器
  app.ts            本地 HTTP API
docs/
  ai-architecture.md AI 能力架构与安全边界
  mvp-spec.md       MVP 范围与产品决策
  todo.md           当前产品待办列表
```

## 设计原则

确定性规则作为开发和评估基线保留。配置模型后，Planner Agent 会通过同一个结构化契约调用实时 AI；页面和领域模型不依赖具体厂商。详细设计见 [`docs/ai-architecture.md`](docs/ai-architecture.md)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，并在提交代码前运行 `npm run check`。

## License

本项目采用 [MIT License](LICENSE)。
