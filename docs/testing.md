# 测试速查表

所有命令从仓库根目录运行。

## 日常：3 个命令

```bash
volta run pnpm test               # 服务端测试
volta run pnpm --filter web test  # 前端单测
volta run pnpm run e2e            # 浏览器端到端测试
```

## 服务端专项

以下统一使用 `volta run pnpm run <命令>`：

| 命令 | 用途 |
| --- | --- |
| `test:watch` | 持续监听并运行服务端测试。 |
| `test:postgres` | 运行 PostgreSQL 集成测试。 |
| `test:pg-backup` | 验证 PostgreSQL 备份与恢复。 |
| `test:migration-prebackup` | 验证迁移前备份流程。 |
| `test:file-ops-pg` | 验证 PostgreSQL 文件操作只读规划。 |
| `test:reconcile-jsonl-pg` | 验证 PostgreSQL 与 JSONL 只读对账。 |
| `test:age` | 验证真实 age 加密与解密。 |
| `test:restore-real` | 验证真实 age 备份恢复。 |
| `test:owner-transfer` | 验证 SQLite 所有者迁移及 age 加密。 |
| `test:owner-transfer-pg` | 验证 PostgreSQL 所有者迁移及 age 加密。 |

## 默认未包含的 E2E

**长会话性能（production）**：先构建，再运行测试。

```bash
VITE_API_TARGET=http://127.0.0.1:8119 volta run pnpm --filter web exec vite build --config vite.performance.config.ts
VITE_API_TARGET=http://127.0.0.1:8119 volta run pnpm --filter web exec playwright test --config playwright.performance.config.ts
```

**最近会话恢复：**

```bash
volta run pnpm --filter web exec playwright test --config playwright.recent.config.ts
```

## 检查与条件

- `verify`、`verify:release` 均不含前端 unit 或 E2E；`verify:release` 需真实 PostgreSQL 与 age。
- `typecheck` 是类型检查，不是测试；`e2e -- --list` 仅列举，不执行测试。
- 在仓库根目录运行，依赖已安装，并准备好 Chrome。
- PostgreSQL 测试需设置 `PI_TEST_PG_URL`，仅使用专用、可销毁的测试库，绝不使用生产库；备份类还需匹配版本的 PG 工具及 age。
- PostgreSQL 前置条件详见 [postgres-podman-test.md](postgres-podman-test.md)。

## Linux 注意事项

在 Linux（如 Debian/Ubuntu）上让 `volta run pnpm test` 全部通过，还需要：

- 安装 `age`（含 `age-keygen`）和 PostgreSQL 16 客户端工具（`pg_dump`/`pg_restore`），并让 16 版优先出现在 `PATH` 中：单测里的假 `pg_dump` 报告 16.x，版本不匹配会失败。
- 把 `TMPDIR` 指向家目录下的私有目录：备份暂存会检查上级目录，拒绝 `/tmp` 这类带 sticky 位的共享目录。
- 机器负载较高时放宽超时：`migrate-cli` 等用例会超过默认的 5 秒。

```bash
export PATH="/usr/lib/postgresql/16/bin:$PATH"
export TMPDIR="$HOME/.cache/pi-test-tmp"
mkdir -p "$TMPDIR" && chmod 700 "$TMPDIR"
volta run pnpm test --testTimeout=20000
```

注意不要写成 `pnpm test -- --testTimeout=20000`，多出的 `--` 会让超时参数失效。
