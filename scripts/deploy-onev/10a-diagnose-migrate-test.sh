#!/usr/bin/env bash
# 只运行迁移 CLI 超时用例，保留全部断言；不操作生产数据库、不启动服务。
set -euo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'Run as root'; exit 1; }
runuser -u onev -- env \
  HOME=/home/onev \
  VOLTA_HOME=/home/onev/.volta \
  PATH=/home/onev/.volta/bin:/usr/local/bin:/usr/bin:/bin \
  TMPDIR=/home/onev/tmp CI=1 \
  timeout --signal=TERM --kill-after=10s 120s bash -c '
    set -euo pipefail
    cd /srv/pi-agent-server
    volta run --node 22.22.3 -- pnpm exec vitest run \
      tests/tools/migrate-cli.test.ts --project=unit \
      -t "reports an absolute target" \
      --testTimeout=30000 --maxWorkers=1 --reporter=verbose
  '
echo 'MIGRATE_TEST_DIAGNOSTIC_PASSED'
