# Web 中止诊断

Web `/abort` 经 runtime、adapter 调用 SDK `session.abort()`；终端直接调用同一方法。预期是取消主任务和等待，不停止已经启动的子代理。

## 捕获实际停止来源

临时启用诊断后启动服务：

```bash
PI_ABORT_TRACE=1 volta run pnpm dev:real
```

stderr 中 `diagnostic: "abort-trace"` 记录中止请求、SDK abort/reload/dispose、native 文件失效、服务关闭，以及 `process.kill` / `ChildProcess.kill` 的信号目标和调用栈。不记录消息、凭证或工具参数；诊断不改变原操作的返回值或异常。信号监测仅覆盖本 Node 进程发出的信号，不能观察外部进程或系统发送的信号。日志含本地源码路径，分享前注意脱敏。

默认关闭；定位后去掉该环境变量并重启。不需要修改扩展。

## 隔离回归

```bash
PI_AGENT_TEAM_EXTENSION_UNDER_TEST="$HOME/.pi/agent/extensions/agent-team/index.ts" \
  volta run pnpm exec vitest run tests/agent/subagent-real-extension-lifecycle.test.ts
```

测试复制扩展到临时目录，使用真实 SDK、HTTP 路由与 OS 子进程；模型流和子进程工作内容为离线 fixture。验证 Web/终端中止后仍能查询、读取日志，显式停止与真正退出仍清理进程。它不能替代现场故障证据。

扩展的重载关闭处理与普通 abort 不同；此前针对此处的扩展修改已经撤回，本仓库不包含该全局修改。尚未查明用户现场子代理停止的触发来源。
