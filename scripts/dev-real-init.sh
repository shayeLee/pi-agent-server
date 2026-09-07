#!/usr/bin/env sh
# dev:real 开发库初始化：与 dev:real 使用同一 DATA_DIR=/tmp/pi-agent-server，
# AGENT_CWD 取运行目录（pnpm run 在项目根目录执行，与 dev:real 启动时一致）。
# 服务启动只验证、不自动初始化，本脚本是首次运行前的显式 bootstrap。
set -eu

mkdir -p /tmp/pi-agent-server
DATA_DIR=/tmp/pi-agent-server AGENT_CWD="$(pwd)" tsx scripts/migrate.ts --bootstrap-baseline --bootstrap-confirm CONFIRMED
