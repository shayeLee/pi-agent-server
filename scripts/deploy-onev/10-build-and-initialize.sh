#!/usr/bin/env bash
# ONEV 裸机部署：阶段 10，安装依赖、构建、测试并初始化数据库。
# 不创建 systemd/nginx 配置，不启动服务。

set -euo pipefail
# 保证通过 ssh | tee 调用时，测试 stderr 也进入部署日志。
exec 2>&1

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

ONEV_HOME=/home/onev
VOLTA_HOME="$ONEV_HOME/.volta"
COMMON_PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin"
HOST_DIR=/srv/pi-agent-server
PLUGIN_DIR=/srv/pi-agent-capability-onev
FRONTEND_DIR=/srv/onev
HOST_DATA=/data/onev/pi-agent-server
PLUGIN_DATA=/data/onev/pi-agent-capability-onev
RESUME_AFTER_BUILD=0
if [ "$#" -eq 1 ] && [ "$1" = '--resume-after-build' ]; then
  RESUME_AFTER_BUILD=1
elif [ "$#" -ne 0 ]; then
  echo 'ERROR: unsupported arguments' >&2
  exit 2
fi

as_onev() {
  local command="$1"
  runuser -u onev -- env \
    HOME="$ONEV_HOME" \
    VOLTA_HOME="$VOLTA_HOME" \
    PATH="$COMMON_PATH" \
    TMPDIR="$ONEV_HOME/tmp" \
    CI=1 \
    bash -c "$command"
}

require_clean() {
  local repo="$1"
  if [ -n "$(git -c safe.directory="$repo" -C "$repo" status --porcelain=v1)" ]; then
    echo "ERROR: tracked working tree is dirty before build: $repo" >&2
    git -c safe.directory="$repo" -C "$repo" status --short >&2
    exit 1
  fi
}

echo '===== PREFLIGHT ====='
df -h / /data
id onev
# backup staging policy 要求服务账号 HOME 为 0700；0750 会按设计 fail-closed。
chown onev:onev "$ONEV_HOME"
chmod 0700 "$ONEV_HOME"
install -d -o onev -g onev -m 0700 "$ONEV_HOME/tmp"
test "$(stat -c '%a:%U:%G' "$ONEV_HOME")" = '700:onev:onev'
test "$(stat -c '%a:%U:%G' "$ONEV_HOME/tmp")" = '700:onev:onev'

if ! command -v age >/dev/null 2>&1 || ! command -v age-keygen >/dev/null 2>&1; then
  echo '===== INSTALL AGE ====='
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends age
fi
age --version
age-keygen --version

require_clean "$HOST_DIR"
require_clean "$PLUGIN_DIR"
require_clean "$FRONTEND_DIR"
test "$(git -c safe.directory="$HOST_DIR" -C "$HOST_DIR" rev-parse --short=8 HEAD)" = '7ee010a2'
test "$(git -c safe.directory="$PLUGIN_DIR" -C "$PLUGIN_DIR" rev-parse --short=8 HEAD)" = '00b3a095'
test "$(git -c safe.directory="$FRONTEND_DIR" -C "$FRONTEND_DIR" rev-parse --short=8 HEAD)" = '7cf0ab79'

if [ "$RESUME_AFTER_BUILD" -eq 1 ]; then
  echo '===== VERIFY EXISTING BUILD OUTPUTS FOR RESUME ====='
  test -r "$HOST_DIR/dist/main.js"
  test -d "$HOST_DIR/dist-migrate"
  test -r "$HOST_DIR/dist-migrate/scripts/migrate.js"
  test -r "$PLUGIN_DIR/dist/index.js"
else
echo
echo '===== HOST INSTALL / BUILD / TEST ====='
as_onev "
  set -euo pipefail
  cd '$HOST_DIR'
  volta run --node 22.22.3 -- pnpm install --no-frozen-lockfile
  volta run --node 22.22.3 -- pnpm typecheck
  # 本机部署使用 SQLite：执行完整 unit 项目，不运行需要 PG16 工具链/集群的 pg-integration 项目。
  # Linux 实测迁移 CLI 单用例需 5.693s；验收预算统一为 30s，不跳过任何 unit 断言。
  echo 'HOST_TEST_COMMAND: vitest run --project=unit --maxWorkers=2 --testTimeout=30000'
  timeout --signal=TERM --kill-after=10s 600s \\
    volta run --node 22.22.3 -- pnpm exec vitest run \\
    --project=unit --maxWorkers=2 --testTimeout=30000
  volta run --node 22.22.3 -- pnpm build
  volta run --node 22.22.3 -- pnpm build:migrate
"

echo
echo '===== PLUGIN INSTALL / BUILD / TEST ====='
as_onev "
  set -euo pipefail
  cd '$PLUGIN_DIR'
  volta run --node 22.22.3 -- pnpm install --no-frozen-lockfile
  volta run --node 22.22.3 -- pnpm test
"
fi

echo
echo '===== HOST ↔ PLUGIN REAL PROJECTION E2E ====='
as_onev "
  set -euo pipefail
  cd '$HOST_DIR'
  link='$HOST_DIR/node_modules/pi-agent-capability-onev'
  target='$PLUGIN_DIR'
  test -d \"\$target\"
  created=0
  if [ -e \"\$link\" ] || [ -L \"\$link\" ]; then
    test -L \"\$link\"
    test \"\$(readlink \"\$link\")\" = \"\$target\"
  else
    ln -s \"\$target\" \"\$link\"
    created=1
  fi
  trap 'if [ \"\$created\" -eq 1 ]; then rm -f -- \"\$link\"; fi' EXIT
  export PI_REQUIRE_ONEV_E2E=1
  # ESM 不读取 NODE_PATH；仅此测试进程用临时相邻 node_modules 链接解析插件，不改生产 PI_PLUGINS。
  volta run --node 22.22.3 -- pnpm exec vitest run \\
    tests/application/plugins/onev-capability-projection.test.ts \\
    --project unit --maxWorkers=1
"

echo
echo '===== FRONTEND INSTALL / BUILD ====='
as_onev "
  set -euo pipefail
  cd '$FRONTEND_DIR'
  unset ONEV_COPILOT_BASE_URL
  # 文档站构建不运行浏览器测试；仅跳过 Puppeteer 浏览器下载，保留其余安装脚本。
  PUPPETEER_SKIP_DOWNLOAD=true volta run --node 16.20.2 --yarn 1.22.22 -- yarn install --frozen-lockfile
  volta run --node 16.20.2 --yarn 1.22.22 -- yarn build:docs
  test -r examples/onev-ui/index.html
"

echo
echo '===== INITIALIZE HOST DATABASE ====='
as_onev "
  set -euo pipefail
  cd '$HOST_DIR'
  export AGENT_CWD='$FRONTEND_DIR'
  export DATA_DIR='$HOST_DATA'
  export DB_PATH='$HOST_DATA/pi-agent-server.db'
  export PI_AGENT_DIR='$HOST_DATA/pi-agent'
  export PI_AUTH_PATH='$HOST_DATA/pi-agent/auth.json'
  volta run --node 22.22.3 -- node dist-migrate/scripts/migrate.js \\
    --bootstrap-baseline --bootstrap-confirm CONFIRMED
  volta run --node 22.22.3 -- node dist-migrate/scripts/migrate.js --verify
"

echo
echo '===== INITIALIZE PLUGIN DATABASE ====='
as_onev "
  set -euo pipefail
  cd '$PLUGIN_DIR'
  export ONEV_DATA_DIR='$PLUGIN_DATA'
  volta run --node 22.22.3 -- pnpm run migrate -- --data-dir '$PLUGIN_DATA'
  volta run --node 22.22.3 -- pnpm run migrate -- --data-dir '$PLUGIN_DATA' --dry-run
"

echo
echo '===== VERIFY ARTIFACTS / OWNERSHIP ====='
test -r "$HOST_DIR/dist/main.js"
test -r "$HOST_DIR/dist-migrate/scripts/migrate.js"
test -r "$PLUGIN_DIR/dist/index.js"
test -r "$FRONTEND_DIR/examples/onev-ui/index.html"
test -f "$HOST_DATA/pi-agent-server.db"
test -f "$PLUGIN_DATA/onev.db"
chown -R onev:onev "$HOST_DATA" "$PLUGIN_DATA" "$FRONTEND_DIR"

# 构建只能产生 ignored 产物；tracked 文件不得被改写。
require_clean "$HOST_DIR"
require_clean "$PLUGIN_DIR"
require_clean "$FRONTEND_DIR"

ls -lh \
  "$HOST_DATA/pi-agent-server.db" \
  "$PLUGIN_DATA/onev.db" \
  "$FRONTEND_DIR/examples/onev-ui/index.html"
df -h / /data
echo 'BUILD_AND_INITIALIZE_COMPLETE'
