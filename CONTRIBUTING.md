# 参与贡献

感谢你关注 AI Learning OS。本项目仍处于早期验证阶段，欢迎围绕学习闭环、Agent 设计、模型评估、前端体验和工程质量贡献改进。

## 开始之前

1. 阅读 [`AI School.md`](./AI%20School.md) 了解产品愿景。
2. 阅读 [`docs/mvp-spec.md`](docs/mvp-spec.md) 和 [`docs/ai-architecture.md`](docs/ai-architecture.md) 了解当前边界。
3. 查看 [`docs/todo.md`](docs/todo.md) 中尚未完成的任务。
4. 对较大的功能或架构调整，请先创建 Issue 讨论范围和成功标准。

## 本地开发

需要 Node.js 20.12 或更高版本。

```sh
npm install
npm run dev
```

提交前运行：

```sh
npm run check
```

## dev 测试环境

当前约定是每次代码或配置更新都同步到 `dev` 测试环境。部署流程为：

1. 运行 `npm run check`。
2. 将源码同步到 `~/services/ai-learning-os/source`，不上传 `.env.local`、密钥或 `node_modules`。
3. 使用服务器 NVM 的 Node 22.21.1；若远端没有 `node_modules`，先执行 `npm ci --prefer-offline --no-audit --no-fund`，再构建并重启用户级 API/Web 服务。
4. 检查 `http://127.0.0.1:8088/api/health`，并对受影响功能执行一次测试。
5. 通过本机 SSH 隧道查看页面：`http://127.0.0.1:8088`。

部署凭据和运行配置只保存在本机 `.env.local` 及服务器权限受限的 `app.env`，不进入 Git。

每次更新还要在 [`CHANGELOG.md`](CHANGELOG.md) 追加内部工作记录，说明更新内容、部署变化、验证结果和剩余风险。该日志主要供项目负责人查看，不要求使用面向用户的发布文案。

## 贡献要求

- 保持用户端、Agent、模型适配器和领域规则之间的边界。
- API 密钥只允许保存在本地 `.env.local`，不得提交凭据或个人数据。
- 新行为必须包含相应测试。
- 中文产品文档使用清晰、具体的短段落。
- 提交信息使用简洁的祈使语气，例如 `feat: add learner feedback model`。

## Pull Request

Pull Request 应说明：

- 要解决的问题和预期结果
- 主要实现决策
- 用户或开发者可观察到的变化
- 已运行的验证及其结果
- 新增配置、数据迁移或安全影响

界面改动请附截图。暂未完成或需要讨论的改动请使用 Draft Pull Request。

## 行为准则

保持尊重、具体和建设性的交流。评审聚焦于代码、产品结果和可验证证据，不针对个人。
