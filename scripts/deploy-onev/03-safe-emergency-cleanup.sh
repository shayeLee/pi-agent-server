#!/usr/bin/env bash
# ONEV 裸机部署：阶段 3，安全释放紧急空间。
# 仅清理可再生的 systemd journal 归档与 APT 缓存/索引。
# 不触碰应用、数据库、容器、源码、/data、/srv 或 /tmp。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

echo '===== BEFORE ====='
df -h /
journalctl --disk-usage || true
du -sh /var/cache/apt /var/lib/apt/lists 2>/dev/null || true

echo
echo '===== VACUUM JOURNAL TO 200 MiB ====='
journalctl --vacuum-size=200M

echo
echo '===== CLEAN APT PACKAGE CACHE ====='
apt-get clean

echo
echo '===== REMOVE REGENERABLE APT INDEX FILES ====='
find /var/lib/apt/lists -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
mkdir -p /var/lib/apt/lists/partial
chmod 700 /var/lib/apt/lists/partial

echo
echo '===== SYNC ====='
sync

echo
echo '===== AFTER ====='
df -h /
journalctl --disk-usage || true
du -sh /var/cache/apt /var/lib/apt/lists 2>/dev/null || true
