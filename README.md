# AI Learning OS

AI Learning OS 是一个 AI 原生个人学习操作系统。当前版本实现了第一条可运行的 MVP 闭环：用户输入学习目标，系统生成阶段路线和当天任务，用户完成任务并获得即时进度反馈。

## 当前能力

- 创建学习目标：主题、当前基础、目标结果、每日时间和学习周期
- Planner Agent 领域逻辑：生成分阶段学习路线
- Coach Agent 起始闭环：诊断、学习、实践、复盘四类每日任务
- 本地进度保存：刷新页面后保留当前计划和完成状态
- 响应式界面：支持桌面和移动端
- 自动化测试：覆盖输入校验、路线分期、时间预算和完成率

## 本地运行

需要 Node.js 20 或更高版本。

### 最简单方式（macOS）

双击项目根目录的 `Start AI Learning OS.command`。启动窗口会自动打开浏览器；关闭终端窗口即可停止应用。

不要直接双击 `index.html`。它是开发入口文件，需要由本地服务处理；直接打开时页面会显示正确的启动提示。

### 命令行方式

```sh
npm install
npm start
```

`npm start` 会启动应用并自动打开浏览器。

## 验证

```sh
npm test
npm run build
```

## 项目结构

```text
src/
  App.tsx           页面与本地交互状态
  planner.ts        Planner Agent 领域逻辑
  planner.test.ts   自动化测试
  types.ts          核心领域类型
  styles.css        视觉系统与响应式布局
docs/
  mvp-spec.md       MVP 范围与产品决策
  todo.md           当前产品待办列表
```

## 设计原则

第一阶段使用确定性规则生成计划，以便快速验证体验、建立测试基线，并保持零 API 凭据依赖。后续接入 LLM 时，页面和领域模型无需重写，只替换 Planner Agent 的生成实现。
