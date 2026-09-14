# P8 宿主侧集成测试与演练（证据）

> 状态：**已完成（宿主通用契约）**。本文件只记录 `pi-agent-server` 内可复现的
> fixture/fake 演练；真实插件兼容性证据由插件仓
> `docs/p8-integration-evidence.md` 维护。

## 范围与边界

- **宿主通用契约**：显式 ESM 加载、注册、路由 RBAC、按 mode 创建与恢复会话、图片消息、
  SSE `requestId`、排队与 abort、重启后的只读 export，以及缺失 JSONL 的既有行为。
- **完全隔离**：所有目录由 `mkdtempSync` 创建，存储使用内存 SQLite；插件与 Agent adapter
  均为仓内 fake，不访问真实模型、外部服务或用户数据。
- **不加载真实插件**：本演练文件不解析外部包、不读取外部构建产物、不依赖 `pnpm link`、
  本机路径、插件环境变量或插件业务字段。临时最小 ESM fixture 只验证公开加载入口；
  `tests/application/plugins/loader.test.ts` 覆盖加载器的完整校验矩阵。
  仓内对真实外部包的正向覆盖在 `tests/application/plugins/package-integration.test.ts`：
  它用 `createRequire` 从仓库根解析 `pi-agent-capability-onev`，解析到才加载并断言 manifest，
  解析不到则显式 skip 并打印原因（不依赖绝对路径或 `PI_ONEV_PLUGIN_ROOT`）。
- **不改宿主实现**：`missing JSONL` 仍返回脱敏的 500，是按要求保留并固化的宿主现状。

真实插件的发布物兼容、`register`、迁移、备份恢复、同步、工具及其业务路由由插件仓
`docs/p8-integration-evidence.md` 记录和验证；UI 的浏览器验收证据由相应 UI 仓维护。

## 用例矩阵

| # | 用例 | 关键断言 |
| --- | --- | --- |
| 1 | 临时最小 ESM fixture 加载 | `PluginLoader.load(file:)` 解析公开 default export，保留 `manifest`/`register`，且加载阶段不调用 `register`。 |
| 2 | 加载失败恢复 | 不可解析 specifier 抛固定 `插件加载失败: ` 前缀；无已加载状态；同一 loader 随后可加载合法 fake。 |
| 3 | fake plugin + fake adapter 全链路 | 注册 fake 路由；viewer 读 200、写 403；mode create/restore；`systemPrompt` override 与 `appendSystemPrompt` 分别冻结、恢复不重复追加；图片逐字节传给 adapter；SSE 补发包含 `requestId`；同用户第二会话 queued；错误 requestId abort 为 409，正确 requestId 中止在途任务并释放队列。 |
| 4 | 重启 export 与缺失 JSONL | 重建 HTTP/runtime 后持久会话可只读导出且零 adapter 创建；删除临时 JSONL 后返回 500，响应不泄漏路径。 |

## 验证结果

在仓库根目录执行：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`tsc --noEmit -p tsconfig.json` 无错误） |
| `npx vitest run tests/server/p8-host-drill.test.ts` | `4 passed` |
| `npx vitest run` | `108` test files passed、`11` skipped；`1273` tests passed、`108` skipped |
| `git diff --check` | 通过 |

## 已知限制

- 本演练不证明任何特定真实插件的打包、加载、注册或业务行为；这些归插件仓证据所有。
- 本演练不执行真实迁移、备份恢复、同步、工具、外部服务或浏览器 UI 验收。
- `PluginHost.dispose()` 与 `app.close()` 由每个用例的 cleanup 调用；真实进程信号与
  `startServer` 组合继续由 `tests/server/start-server-lifecycle.test.ts` 覆盖。
