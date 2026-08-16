# 浏览器 OIDC 与跨设备同步验收

## 目标与边界

这项验收使用两个隔离的真实 Chromium 浏览器上下文，证明 dev 环境完成 OIDC 授权回调、建立两个独立设备会话、上传一个合成学习目标，并把一个任务完成状态同步到第二个上下文。它不调用模型，不使用真实学习内容，也不把身份凭据、Cookie、页面截图、录屏或 trace 写入仓库和测试报告。

验收账号必须是专用于自动化、允许整账号删除的 dev 账号。测试结束时会通过产品界面永久删除该账号及其合成云端记录，避免测试数据和会话长期累积。不得对个人账号、共享人工测试账号或生产账号设置删除许可。

## 前置条件

1. 按 [`deploy/dev/README.md`](../deploy/dev/README.md) 建立 dev SSH 隧道，并确认 `http://127.0.0.1:8088/api/health` 就绪。
2. 为 Dex 准备一个可在每次删除后重新映射的专用静态测试身份。
3. 首次在执行机安装 Playwright Chromium：`npx playwright install chromium`。浏览器二进制属于本机工具缓存，不提交到 Git。
4. 只在当前 shell 中提供运行时变量；不要写入 `.env`、命令脚本、终端共享记录或仓库文件。

```sh
AI_LEARNING_ACCEPTANCE_BASE_URL=http://127.0.0.1:8088 \
AI_LEARNING_ACCEPTANCE_ISSUER_ORIGIN=http://127.0.0.1:5556 \
AI_LEARNING_ACCEPTANCE_EMAIL='<dedicated-dev-email>' \
AI_LEARNING_ACCEPTANCE_PASSWORD='<runtime-password>' \
AI_LEARNING_ACCEPTANCE_DISPOSABLE_ACCOUNT=true \
npm run acceptance:oidc-sync
```

缺少任一凭据或明确的 disposable 标记时，runner 会在启动浏览器前失败。Web 与 issuer 都必须是无凭据、路径、查询或 fragment 的精确 HTTP loopback origin；填写登录表单前还会确认页面位于指定 issuer，避免配置错误或异常跳转把凭据发送到其他站点。配置关闭截图、录像和 trace；默认 list reporter 只输出固定测试名称、项目、耗时和通过/失败状态。失败日志仍应按敏感运维制品处理，不应粘贴 Cookie、表单值或未审查的页面内容。失败路径会尽力清理已经创建的 disposable 账号；如果进程被强制终止，下一次运行前仍应确认 dev 数据库没有遗留合成记录。

## 验收证据

一次有效运行应记录以下不含凭据或学习正文的证据：

- 执行 UTC 时间、被验收提交和 dev `/api/health` 的 `releaseRevision`；
- `npm run acceptance:oidc-sync` 的退出状态和固定案例名称；
- OIDC 回调后页面显示已登录；
- 第二个隔离上下文下载合成目标；
- 第一个上下文完成任务后，第二个上下文显示相同完成状态；
- 清理后第一个上下文回到已退出状态。

只有真实执行全部通过且 release revision 与目标提交一致后，才能勾选 [`docs/todo.md`](./todo.md) 中的真实浏览器验收项。runner 本身存在不等于验收已经完成。
