# macOS + Podman 临时 PostgreSQL 测试流程

本文档固化本机使用 Podman 运行临时 PostgreSQL 容器、执行 Phase 2 PG 集成测试的完整步骤。

## 适用范围

- **仅用于真实 PG 集成测试**（`tests/postgres/`：`postgres.integration.test.ts` + `repository-contract.test.ts`，均 `PI_TEST_PG_URL` 门控）。
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
  docker.io/library/postgres:16-alpine
```

**参数说明：**

| 参数 | 作用 |
|------|------|
| `--rm` | 容器停止后自动删除，不留残余；测试结束无需手动清理容器文件 |
| 无 `-v`（无 volume） | 数据仅存于容器内，随 `--rm` 销毁，不污染宿主机 |
| `-p 127.0.0.1:54329:5432` | 仅绑定 loopback 地址，外部网络无法访问；端口 54329 避免与宿主机已有 PG 冲突 |

## 就绪检查

```bash
podman exec pi-agent-postgres-test pg_isready
# 期望输出：localhost:5432 - accepting connections
```

若未就绪，等待几秒后重试。PG 首次启动需要初始化，通常 2-5 秒。

## 构造测试连接串并运行测试

```bash
# 构造连接串
export PI_TEST_PG_URL="postgresql://${PG_TEST_USER}:${PG_TEST_PASSWORD}@127.0.0.1:54329/${PG_TEST_DB}"

# 进入项目目录
cd /Users/mz/pi-agent-server

# 仅运行 PG 门控测试（推荐：发布门禁 `pnpm test:postgres` 在无 URL 时非零失败，有 URL 时只跑 tests/postgres/**）
volta run pnpm test:postgres

# 或者跑全量测试（设置 PI_TEST_PG_URL 后 tests/postgres 也真实执行，不再以 skip 呈现）
volta run pnpm test
```

**复跑 PG 门控测试**：设置 `PI_TEST_PG_URL` 后，`tests/postgres/` 两个门控文件的用例将真实连接 PG 执行，不再以 skip 呈现——用于复跑/重新验证真实验收（当前扩展门控共 45 个：`postgres.integration.test.ts` 21 个 + `repository-contract.test.ts` 24 个，已由 `volta run pnpm verify:release`（真实 PG URL）全部通过，结论见 [database-design.md](database-design.md) §9；本流程亦可随时用于重新验证）。用例数以当次 reporter 输出为准，不在本文固定。

**隔离说明**：每个测试文件使用随机 schema（`pi_test_*`）+ `search_path` 隔离；每用例前 `TRUNCATE TABLE idempotency, sessions, projects CASCADE`（用例顺序无关）；Pool 关闭用例自建独立 Pool/Kysely，不销毁共享 fixture；`afterAll` 仅 drop 自己创建的随机 schema。

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
  docker.io/library/postgres:16-alpine

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
