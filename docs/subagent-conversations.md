# 子代理会话记录

Web 保留左侧主会话列表；顶部右侧栏图标打开面板，切换「子代理」标签，点击任务在中央查看会话。会话记录只读；子代理运行中时，底部输入框可以**引导**它（与主代理的 `subagent_steer` 相同：在子代理下一回合开始前送达，不打断当前生成），不支持在子代理结束后继续对话。「返回主会话」恢复原对话。轨迹、系统提示词、事件流继续位于同一右侧面板；子代理视图共享同一侧栏开关，侧栏中的轨迹仍指向主会话。窄屏使用已有右侧抽屉，选择任务后自动收起。

## 扩展接入

服务端和 `agent-team` 扩展需要同时更新。仓库提供 `integrations/agent-team/transcript.ts` 和针对当前扩展的 `index.patch`。安装前在目标扩展目录检查补丁是否适用：

```sh
patch --dry-run -p1 -d "$HOME/.pi/agent/extensions/agent-team" < integrations/agent-team/index.patch
patch -p1 -d "$HOME/.pi/agent/extensions/agent-team" < integrations/agent-team/index.patch
cp integrations/agent-team/transcript.ts "$HOME/.pi/agent/extensions/agent-team/transcript.ts"
```

补丁同时加入会话级宿主控制：`session_start` 时扩展经同一 EventBus 发出 `agent-team:host-control`（`{ version: 1, steer(transcriptId, text) }`），宿主据此把用户的引导交给运行中的后台子代理。它与 `subagent_steer` 共用同一条路径（运行状态检查、送达记录、控制 socket），只是在 `input` 记录上标注 `source: "user"`。前台运行没有控制通道，不能引导。

补丁不适用时应人工合并，不能覆盖其他扩展改动。扩展已被加载的会话需要重新加载资源或重启服务后才使用新代码。不要在运行中的真实任务上为了验收而重启。

## 保存方式与边界

- 每次执行生成 UUID；原有数字 runId 仅用于展示和扩展控制，不作为永久身份。
- 扩展使用 Pi `appendEntry("agent-team:transcript", record)`，逐条追加到**主会话 JSONL**。记录包含 `version/id/seq/timestamp/kind/payload`。沿用主会话现有授权、备份、分支和生命周期，不新建独立会话文件，不进入主代理模型上下文。
- `start` 保存角色、完整初始任务、开始时间、模型和思考深度；`configuration` 保存实际思考深度变化，缺失时不展示；`message` 保存实际收到的 user、assistant、toolResult 对象；`tool_execution_start/end` 保存调用 ID、完整参数和结果；`end` 保存终态。不对这些记录的正文、参数、结果做额外截断，工具源头已截断的内容无法补回。
- `subagent_steer` 在发送前保存全文，在传输失败时保存失败状态；socket 写成功仅表示提交。只有实际 user 消息出现后才显示送达。重复内容只在已发生的提交中按顺序匹配；无法匹配的实际用户消息仍完整保存，不虚构送达确认。
- 写盘不依赖主代理调用 `subagent_wait`。写盘失败不广播为已保存数据，并终止该子进程。未能保存终态的记录显示「状态未知」。
- 流式片段在内存中合并、限频广播，完整消息结束时保存；正常停止时还保存最后已观察到的未完成助手消息。进程突然崩溃或断电时，尚未形成完整消息的内存片段可能丢失；不能承诺断电级零丢失。工具已发出的调用有独立开始记录，缺少结果时明确显示结果未记录。
- 新服务实例只读恢复历史，不启动子代理或模型。没有实时进程证据且缺少终态的任务显示「状态未知」，不会伪装成仍在运行或已成功。
- 旧版 `subagent` / `subagent_wait` 的 `details.results[].messages` 可恢复，旧版记录可能不完整。过去只保存了摘要、未收集或已丢失的记录无法补齐。

## API 与读取成本

`POST /v1/sessions/:id/subagents/:runId/steer`（`{ "text": "..." }`，需要 `sessions:control`）由用户引导运行中的子代理。只查找已在内存中的 runtime，不为此创建；会话未加载、扩展未提供宿主控制或子代理未运行时返回 `409` 及稳定 `code`。空 `202` 只表示控制通道已接收，送达仍以子代理记录中实际出现的 user 消息为准。`inputs[].source` 区分主代理（`host`）与用户（`user`）发出的输入。

`GET /v1/sessions/:id/subagents` 返回当前主会话分支的运行列表；`?runId=<runs[].id>` 返回选中子代理的原始消息、输入送达状态以及复用前端 Timeline 的投影。权限与会话导出一致，读取不实例化 runtime，原生会话仍通过 descriptor/source capability 校验。

前端可见时每秒检查列表，关闭面板且未选中子代理时每 5 秒检查；页面隐藏时暂停。只有选中任务的持久版本、流式版本或状态变化才重新下载详情。结束任务不反复下载长日志。冷读取缓存按文件身份、大小和修改时间失效；缓存不替代访问检查。当前页签记住选中的子代理，刷新后重新获取服务端数据。

## 验证

- `tests/agent/subagent-transcript.test.ts`：真实 JSONL 落盘、独立存储实例和新进程恢复、长结果无截断、steer 重复/失败/未确认、部分输出、写失败，以及主模型上下文隔离。
- `tests/server/subagents.test.ts`：只读查询、越权、访问撤销和 live/cold 竞态；用户引导的准入、拒绝码、权限，以及冷会话不创建 runtime。
- `tests/agent/subagent-host-control.test.ts`：宿主控制握手、异常或未知回答一律视为发送失败，dispose 后不可用。
- `tests/agent/subagent-real-extension-lifecycle.test.ts`：显式指定安装的扩展，使用假 Pi 进程做真实 SDK 扩展加载和进程生命周期测试，不调用模型。
- `tests/helpers/subagent-preview.ts`：隔离浏览器验收服务，全部使用模拟数据，不连接真实会话或 provider；接受引导并在约 1.5 秒后模拟送达（需先向会话发送一条消息以创建 runtime）。
