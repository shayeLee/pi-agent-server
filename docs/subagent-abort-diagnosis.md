# 主请求中止与后台 subagent 生命周期（SDK 1.1.0）

## 当前证据与语义

- `src/runtime/session-runtime.ts:abortInternal` 校验 request ownership，撤销 notification generation，再调用 adapter.abort；queued 请求取消排队，不启动工具。
- `src/agent/pi-agent-adapter.ts:abort` 中止 requestAbort（模型 stream gate），清理主队列，调用 SDK session.abort；没有调用 subagent_stop 或 dispose。中止成功后丢弃主请求残余事件。
- SDK `dist/core/agent-session.js:abort` 取消 retry/compaction/branch summary，调用 agent.abort 并等待 idle。`pi-agent-core/dist/agent.js:abort` 取消 activeRun 的 AbortController；`agent-loop.js` 将该 signal 传给 tool.execute。这仍必须取消普通文件/命令工具，不能全局屏蔽 signal。
- 经授权只读检查 `$HOME/.pi/agent/extensions/agent-team/index.ts`：`startBackgroundRun`（约 1183 行）、`runSingleAgent`（约 1340 行）不接收父 signal；child stop 控制独立，普通主请求 abort 不会发 SIGTERM/SIGKILL。`subagent_wait`（约 2493 行）只取消等待、返回仍在运行状态，不调用 record.stop。`subagent_stop` 显式调用 record.stop。

因此，在**本次检查的版本**中，未发现“普通 WebUI abort 杀死已经运行的 child”的代码路径；没有为了保 child 而删除主任务 abort/admission guard。该结论不等同于已复现或解释用户此前观察到的真实 child 退出。

## 通知与原请求关联

后台通知先 append `agent-team:notification`，独立 notification subscription 即使主任务 aborted 仍可显示。host admission 被 abort 阻断，因此 child 完成不会自动重新启动被中止的主任务。明确新用户请求被接受后才重新开放 admission；已拒绝 notificationId 的 ACK 保留，重试不能串到新请求。

当前 payload 只有 version、notificationId、runIds、text；扩展 run registry 没有 originating requestId / host generation。host 在**首次 post 时**捕获当前 generation，而不是 child 启动时：因此首次完成通知若延迟到新请求后才 post，现有协议不能辨别它属于之前被中止的任务。这与“已 post 的旧世代 admission 被取消”是不同情形。不能声称现有 generation 能拒绝所有迟到 child 通知。

## 需要另外授权/确定的边界（未改动）

1. 全局扩展 `subagent.execute`（约 2047 行）忽略 `_signal`；parallel loop 每轮仍可能启动任务；runSingleAgent 注册 Fleet 后、真正 spawn 前还有文件 await。若要求取消尚未启动的任务，需要全局扩展变更：仅在 launch admission / 每次 await 后及 spawn 前检查主 signal；spawn 成功后解除父 signal 关联，已运行 child 不受影响。禁止把父 signal 转接成 child stop。
2. 若必须禁止旧 child 的首次通知进入新主请求，需要 launch 时获取 host ownership token，并保存在 run record，通知携带该关联，host 校验后拒绝取消世代；旧通知仍可显示。不能通过 SDK-direct fallback、放开 admission 或忽略所有工具 signal 实现。需先确定协议扩展与全局修改权限。
3. 生命周期保持独立：全局扩展 `session_shutdown`（约 1936 行）仍停止全部 running child。SDK session.dispose 只 abort/invalidate/disconnect，并不直接发 session_shutdown；invalidate 也不发该事件。host delete/shutdown 的现有 abort/dispose 路径没有因此被改变。未对真实后台进程做 delete/shutdown 验证，不能把 registry 的 mock lifecycle 回归测试解释为真实 child 清理已得到证明。

## 验证与范围

`tests/agent/subagent-abort-sdk.test.ts` 使用真实 SDK、临时凭证/资源、离线 synthetic stream 和 fake child promise；覆盖主 abort 取消 wait、不自动续跑，以及 child 独立完成/显式 stop。host 回归覆盖 abort 后通知仍显示、旧通知重试仍拒绝。

上述扩展路径指 Pi CLI 用户级扩展目录，不是本 server 的 `PI_AGENT_DIR`。未修改全局扩展或验证真实 child 的退出；本次是诊断与隔离回归覆盖，并非全局 launch/ownership 修复。
