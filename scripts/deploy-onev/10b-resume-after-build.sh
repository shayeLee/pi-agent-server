#!/usr/bin/env bash
# ONEV 裸机部署：阶段 10 已完成宿主/插件构建后的续跑。
# 复用阶段 10 从 E2E 到结尾的逻辑，不重复安装或测试。
set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo 'Usage: 10b-resume-after-build.sh' >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec "$SCRIPT_DIR/10-build-and-initialize.sh" --resume-after-build
