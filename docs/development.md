# 本地开发

## 从源码启动真实服务

```bash
pnpm dev:real
```

`dev:real` 通过 tsx 的 `--env-file-if-exists=.env.local` 加载可选的 `.env.local`。先复制已追踪且不含敏感值的模板：

```bash
cp .env.example .env.local
```

本地模板显式设置开发值 `DATA_DIR=/tmp/pi-agent-server`、`PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,10.0.0.0/8`、`PI_DEFAULT_MODEL=openai-codex/gpt-5.6-luna` 和 `PI_DEFAULT_THINKING_LEVEL=medium`；使用前请修改机器相关值。若 `DATA_DIR` 未设置或为空白，服务默认使用 `~/.pi`。`PI_ALLOWED_CLIENT_CIDRS` 未设置时默认 `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`，并按所有路由的客户端 IP 匹配。

`dev:real` 使用解析后的 `DATA_DIR` 和 `DB_PATH`，服务启动只验证、不自动初始化数据库。首次运行前初始化空目标：

```bash
pnpm dev:real:init
```

`dev:real:init` 与 `dev:real` 加载相同的可选 `.env.local`（已有进程环境变量优先），并复用统一存储 resolver：`DATA_DIR` 未设置或空白时默认 `~/.pi`，`DB_PATH` 可覆盖默认的 `<PI_AGENT_DIR>/pi-agent-server.db`。模板中的 `/tmp` 路径是显式开发示例，不是硬编码默认。对于 SQLite，已有库先在临时 DB/WAL/SHM snapshot 上调用官方只读 schema/ledger verify 引擎，成功或失败都会清理副本。有效 head 会报告“已初始化”并成功退出，不写入；仅不存在或完全空的目标才 bootstrap 并验证。非空且无有效 ledger 的库拒绝 adoption、删除或修复；有效旧版本需要显式离线迁移，绝不自动 apply。PostgreSQL 需使用显式离线 migration CLI。初始化后直接运行 `pnpm dev:real` 即可。

默认凭证来源是 `~/.pi/agent/auth.json`。部署时应通过 `PI_AUTH_PATH` 指向服务专用凭证文件；也可以用 `PI_MODEL_PROVIDER` 和 `PI_MODEL_API_KEY` 注入默认 provider 的运行时 API key。

## 常用命令

日常入口、专项门禁、先决条件与覆盖边界见[测试命令清单](testing.md)。

```bash
pnpm test
pnpm typecheck
pnpm verify
pnpm verify:release     # 需要真实 PostgreSQL 与 age 前置条件
pnpm build
pnpm --filter web test
pnpm --filter web build
pnpm run e2e
```

`pnpm run e2e` 使用本机已安装的 Chrome 并发运行分组（默认取 CPU 核数的一半，最多 6 组；设置 `PI_E2E_CONCURRENCY=1` 则逐组运行）。每组使用独立端口，并由单元测试保证不冲突，各组不会共用服务；保留已有 skip 守卫，默认排除长会话性能与最近会话恢复测试。rich-app/start-state 的 11 个测试在独立 rich 组使用隔离 mock 端口 5226/8126 执行；只有该组的测试进程及服务设置 `MOCK_SCENARIO=rich`。其它组和全量基线 discovery 显式清空该变量，即使调用者环境中已设置。没有专用分组的普通 spec 按文件名轮流分到 `general-1`…`general-N` 几个分片（`web/e2e-groups.ts` 的 `generalShards`），每片有自己的 mock 服务和端口，片内串行、片间并行；直连 mock 的 spec 从 `PI_E2E_MOCK_API` 取地址，不写死端口。各组按上次整组运行的耗时从长到短启动（记录在 `web/node_modules/.cache/pi-e2e-durations.json`，丢失只影响顺序）。某组失败不影响其它组。通过的组只输出一行，失败的组输出完整日志；每组的日志（`output.log`）、原生 Playwright JSON 报告及汇总（通过/失败/跳过/未执行）保存在启动时打印的独立临时目录。使用 `pnpm run e2e -- --list` 可核验分组的 Playwright discovery，不启动服务或执行测试。

开发中只跑相关用例：`pnpm run e2e -- --group=workspace,steps` 只执行这些分组（`general` 表示全部 general 分片）；`pnpm run e2e -- --spec=compaction,start-state` 只执行这些 spec 文件（`.spec.ts` 可省略），每个文件仍在所属分组的配置与端口下运行，同组其它 spec 不执行。两者可组合，被 `--group` 选中的分组整组执行。discovery 始终覆盖全部分组，遗漏/重复校验照常生效；部分运行会打印 `Partial run`/`Partial total`，未执行数只按选中的用例计算，提交前仍应全量运行。`--max-failures=N` 在累计 N 个用例失败后停止：各组 Playwright 到 N 即停，且不再启动新分组，未运行的用例计为未执行，因此运行判定失败。

专项离线命令与 PostgreSQL 门禁见 [docs/operations.md](operations.md)、[docs/postgres-podman-test.md](postgres-podman-test.md)和 `package.json`。
