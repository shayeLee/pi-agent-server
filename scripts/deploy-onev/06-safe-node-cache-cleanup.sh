#!/usr/bin/env bash
# ONEV 裸机部署：阶段 6，使用包管理器官方命令清理可再生缓存。
# 不删除 node_modules、项目文件、Volta 工具链或应用数据。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

export VOLTA_HOME=/root/.volta
export PATH="$VOLTA_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

echo '===== BEFORE ====='
df -h /
du -sh /root/.npm /root/.cache /root/.local/share/pnpm 2>/dev/null || true

echo
echo '===== TOOL VERSIONS ====='
node --version
npm --version
pnpm --version
yarn --version

echo
echo '===== NPM CACHE CLEAN ====='
npm cache clean --force

echo
echo '===== YARN CACHE CLEAN ====='
yarn cache clean

echo
echo '===== PNPM STORE PRUNE ====='
pnpm store prune

echo
echo '===== SYNC ====='
sync

echo
echo '===== AFTER ====='
df -h /
du -sh /root/.npm /root/.cache /root/.local/share/pnpm 2>/dev/null || true
