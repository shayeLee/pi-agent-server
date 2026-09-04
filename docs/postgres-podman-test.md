# macOS + Podman 临时 PostgreSQL 测试流程

本文档固化本机使用 Podman 运行临时 PostgreSQL 容器、执行 Phase 2 PG 集成测试的完整步骤。

## 适用范围

- **仅用于真实 PG 集成测试**（所有 `tests/postgres/` 测试均由 `PI_TEST_PG_URL` 门控）。
- 本任务的三个独立 PG 门控文件是：`tests/postgres/migration-engine.test.ts`（真实 v0 migration）、`tests/postgres/migration-prebackup.test.ts`（真实 prebackup→apply→verify）和 `tests/postgres/pg-backup.test.ts`（真实 pg_dump→age→pg_restore）。
- 适用于本地临时测试库或专用测试库场景。
- **严禁使用生产数据库连接串。** 容器数据随容器销毁，不可用于任何需要持久化的场景。

## 前置条件

```bash
# 安装 Podman
brew install podman

# 初始化并启动 Podman machine（macOS 需要 Linux VM 跑容器）
podman machine init
podman machine start

# 验证安装正常
podman info          # 无报错即可
podman ps            # 应显示空列表（无运行中容器）
```

> **macOS Podman machine 与 localhost 端口转发**：Podman 在 macOS 上通过 Linux VM 运行，`-p 127.0.0.1:54329:5432` 会自动配置 VM → host 的端口转发，测试代码通过 `localhost:54329` 即可访问容器内的 PG。

## WP3B2 前置：PostgreSQL client tools 与数据库权限

`pnpm test:pg-backup` 会运行真实 `pg_dump`/`pg_restore`，并在 `PI_TEST_PG_URL` 指向的实例中创建、使用并删除随机命名的 source/target 临时数据库（如 `pi_w3b2_src_*` 与 `pi_restore_*`）。因此只能使用专用、可销毁的测试 PG，以及拥有 `CREATE DATABASE` / `DROP DATABASE` 权限的连接 URL；严禁使用生产或含真实数据的数据库 URL。

**libpq client 的 major 必须与测试 PostgreSQL server major 完全一致**。门禁会安全执行 `SHOW server_version_num`，并解析 `pg_dump --version` 与 `pg_restore --version`；不匹配会在创建 dump 或运行 restore 前 fail-fast，不会过滤或篡改 dump。

先选择要测试的 server major（下面的 16 只是示例，不是固定要求），并按同一 major 安装 client：

```bash
export PG_TEST_PG_MAJOR=16
brew search libpq                         # 确认该 major 的 formula 是否可用
brew install "libpq@${PG_TEST_PG_MAJOR}" # 若 Homebrew 提供版本化 formula
export PATH="$(brew --prefix "libpq@${PG_TEST_PG_MAJOR}")/bin:$PATH"
pg_dump --version
pg_restore --version
```

若 Homebrew 没有对应的 `libpq@<major>` formula，请使用发行版/官方 PostgreSQL client package 安装同一 major，或把匹配版本的 `bin` 目录放在 `PATH` 前面；不要因为宿主机默认安装了更新 major 就强行使用它。

两个版本命令都必须成功且 major 相同；若只在当前 shell 临时设置 `PATH`，每次复跑前都要重新执行 `export`。

## 安全启动 PostgreSQL 容器

```bash
# 生成随机凭据（每次测试建议重新生成）
export PG_TEST_USER=pi_test_$(openssl rand -hex 4)
export PG_TEST_DB=pi_test_$(openssl rand -hex 4)
export PG_TEST_PASSWORD=$(openssl rand -hex 24)

# 启动容器
podman run \
  --name pi-agent-postgres-test \
  --rm \
  -d \
  -e POSTGRES_USER="$PG_TEST_USER" \
  -e POSTGRES_DB="$PG_TEST_DB" \
  -e POSTGRES_PASSWORD="$PG_TEST_PASSWORD" \
  -p 127.0.0.1:54329:5432 \
  docker.io/library/postgres:${PG_TEST_PG_MAJOR}-alpine
```

**参数说明：**

| 参数 | 作用 |
|------|------|
| `--rm` | 容器停止后自动删除，不留残余；测试结束无需手动清理容器文件 |
| 无 `-v`（无 volume） | 数据仅存于容器内，随 `--rm` 销毁，不污染宿主机 |
| `-p 127.0.0.1:54329:5432` | 仅绑定 loopback 地址，外部网络无法访问；端口 54329 避免与宿主机已有 PG 冲突 |

## 就绪检查与安全版本查询

```bash
podman exec pi-agent-postgres-test pg_isready
# 期望输出：localhost:5432 - accepting connections

# 只输出 server_version_num（例如 160006），不需要也不打印连接串或密码
podman exec pi-agent-postgres-test psql -U "$PG_TEST_USER" -d "$PG_TEST_DB" -Atc 'SHOW server_version_num'
```

查询结果的 major 是 `server_version_num / 10000` 的整数部分；它必须与上面的 `pg_dump --version` 和 `pg_restore --version` major 相同。`test:pg-backup` 会再次执行同样的安全 preflight；若输出 mismatch，按错误中提示安装 matching client，而不是修改 dump。

若未就绪，等待几秒后重试。PG 首次启动需要初始化，通常 2-5 秒。

## 构造测试连接串并运行测试

```bash
# 构造连接串
export PI_TEST_PG_URL="postgresql://${PG_TEST_USER}:${PG_TEST_PASSWORD}@127.0.0.1:54329/${PG_TEST_DB}"

# 进入项目目录
cd /Users/mz/pi-agent-server

# 仅运行 PG 门控测试（推荐：发布门禁 `pnpm test:postgres` 在无 URL 时非零失败，有 URL 时只跑 tests/postgres/**）
volta run pnpm test:postgres

# WP3B2 真实 pg_dump/pg_restore + age backup gate
volta run pnpm test:pg-backup

# 或者跑全量测试（设置 PI_TEST_PG_URL 后 tests/postgres 也真实执行，不再以 skip 呈现）
volta run pnpm test
```

**复跑 PG 门控测试**：设置 `PI_TEST_PG_URL` 后，`tests/postgres/` 下的存储、migration、prebackup 与 backup 门控会真实连接执行，不再以 skip 呈现；用例数以当次 reporter 输出为准，不在本文固定。历史存储集成门控（`postgres.integration.test.ts` + `repository-contract.test.ts`）曾由 `volta run pnpm verify:release` 在真实 PG URL 下通过，结论见 [database-design.md](database-design.md) §9；本流程亦可随时重新验证。

**三个 PG 门控的独立命令**（均要求 `PI_TEST_PG_URL`；缺失 URL 或 age/`pg_dump`/`pg_restore` 等必需依赖时必须非零失败，不能把 skip 称为通过）：`test:postgres` 覆盖 `tests/postgres/` 全部 PG 文件，因此同样执行完整工具门禁；runner 会向子进程设置 required 标志，并用 Vitest reporter 证据确认实际用例执行，普通 root `pnpm test` 不设置该标志、仍可条件 skip。

```bash
cd /Users/mz/pi-agent-server
export PI_TEST_PG_URL="postgresql://${PG_TEST_USER}:${PG_TEST_PASSWORD}@127.0.0.1:54329/${PG_TEST_DB}"

# migration engine（包含 migration-engine.test.ts；同时运行 tests/postgres 下全部 PG 集成门控）
volta run pnpm test:postgres
# WP3C：migration-prebackup.test.ts
volta run pnpm test:migration-prebackup
# WP3B2：pg-backup.test.ts
volta run pnpm test:pg-backup
```

`test:migration-prebackup` 会先检查 age、`pg_dump`、`pg_restore` 与 server major，然后在专用数据库的随机 schema（仅 schema 隔离）的从未迁移状态执行真实 prebackup→v0 apply→verify；测试断言 prebackup manifest 的 ledger version 为 null/empty，之后数据库 ledger 为 v0/pending=0。该命令只创建并清理自己创建的随机 schema 和临时备份目录，不创建 source/target database；失败后请确认测试 PG 是专用可销毁实例，再检查残留 schema。需要完整当前发布门禁时运行 `volta run pnpm verify:release`。

**隔离与清理说明（按测试类型分别适用）**：

- **storage integration**（`postgres.integration.test.ts`、`repository-contract.test.ts` 等）：在测试 URL 指定的专用数据库内使用每文件/fixture 的随机 schema 与 `search_path`；测试按约定清理自己创建的 schema，绝不 drop `public` 或任意外部 schema。普通 root `pnpm test` 未配置 URL 时仍可条件 skip。
- **migration prebackup**（`migration-prebackup.test.ts`）：在专用数据库中创建随机 schema，并将连接限定到该 schema；用例结束后只 `DROP SCHEMA ... CASCADE` 自己创建的 schema，同时关闭 Pool/Kysely 和临时备份目录。schema 初始不含业务表，用来验证 prebackup→apply→verify 的真实顺序。
- **backup/restore**（`pg-backup.test.ts`）：由 fixture/运维连接创建随机命名的 source DB（`pi_w3b2_src_*`）和 target DB（`pi_restore_*`）；source 用于真实 `pg_dump`，target 必须是新建且为空的安全目标，恢复完成或失败后由 runner/test 的 `afterAll`/`finally` 删除各自数据库并清理临时 age、dump、JSONL 目录。core 不自动 drop 或创建数据库，也不触碰 public/外部数据库。

失败后请确认测试 URL 指向专用可销毁实例，再检查是否有残留随机 schema/database；不要把生产库用于任何一个门控。

## 清理

```bash
# 停止并删除容器（--rm 会自动删除，显式 stop 更安全）
podman stop pi-agent-postgres-test 2>/dev/null || true

# 清除环境变量，避免泄漏到后续 shell
unset PG_TEST_USER PG_TEST_DB PG_TEST_PASSWORD PI_TEST_PG_URL

# 可选：停止 Podman machine（释放 VM 资源，下次使用再 start）
podman machine stop
```

## 端口冲突处理

若 54329 被占用，改用 54330 并同步 URL：

```bash
# 启动时改端口
podman run \
  --name pi-agent-postgres-test \
  --rm \
  -d \
  -e POSTGRES_USER="$PG_TEST_USER" \
  -e POSTGRES_DB="$PG_TEST_DB" \
  -e POSTGRES_PASSWORD="$PG_TEST_PASSWORD" \
  -p 127.0.0.1:54330:5432 \
  docker.io/library/postgres:${PG_TEST_PG_MAJOR}-alpine

# URL 同步修改
export PI_TEST_PG_URL="postgresql://${PG_TEST_USER}:${PG_TEST_PASSWORD}@127.0.0.1:54330/${PG_TEST_DB}"
```

## 常见排查

| 问题 | 诊断 | 解决 |
|------|------|------|
| `podman: command not found` | 未安装 Podman | `brew install podman` |
| `Error: no running machine` | Podman machine 未启动 | `podman machine init && podman machine start` |
| `podman: connection refused` | PG 容器未启动或端口不对 | `podman ps` 确认容器在运行；检查端口映射 |
| `FATAL: database "xxx" does not exist` | 容器内 DB 未创建 | 确认 `-e POSTGRES_DB` 参数正确；容器启动时 PG 自动创建该库 |
| `ECONNREFUSED 127.0.0.1:54329` | 端口未转发或容器未就绪 | `podman exec pi-agent-postgres-test pg_isready`；若容器不存在，重新 `podman run` |
| `Error: port is already allocated` | 54329 被其他进程占用 | 改用 54330（见上方"端口冲突处理"）；或 `lsof -i :54329` 找到占用进程 |
| 测试全部 skip | `PI_TEST_PG_URL` 未设置 | `export PI_TEST_PG_URL=...`（见上方完整命令） |

**容器日志排查：**

```bash
podman logs -f pi-agent-postgres-test    # 实时查看 PG 启动日志
podman ps -a                             # 列出所有容器（含已停止的）
```

## 安全提示

- **不要在聊天、提交信息或共享文档中泄漏连接串或密码。** `PG_TEST_PASSWORD` 和 `PI_TEST_PG_URL` 仅在本地 shell 中使用。
- 测试创建/删除的 `pi_test_*` schema 是随机生成的临时 schema，**必须使用专用临时库**，绝不可指向包含真实数据的数据库。
- 容器使用 `--rm` 启动，停止后数据自动销毁，不留残余。
- 端口仅绑定 `127.0.0.1`，外部网络无法访问。
