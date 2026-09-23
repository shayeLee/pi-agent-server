#!/usr/bin/env bash
# ONEV 裸机部署：阶段 2，只读定位磁盘占用、现有 nginx 与运行时布局。
# 不删除文件，不修改配置，不停止服务。

set -u

echo '===== FILESYSTEM CAPACITY ====='
df -hT / /srv /var 2>&1 || true
df -ih / /srv /var 2>&1 || true

echo
echo '===== TOP-LEVEL DISK USAGE ====='
du -x -h -d 1 / 2>/dev/null | sort -h | tail -20

echo
echo '===== /var DISK USAGE ====='
du -x -h -d 2 /var 2>/dev/null | sort -h | tail -30

echo
echo '===== /srv DISK USAGE ====='
du -x -h -d 2 /srv 2>/dev/null | sort -h | tail -30

echo
echo '===== /root DISK USAGE ====='
du -x -h -d 2 /root 2>/dev/null | sort -h | tail -30

echo
echo '===== LARGE FILES (>=500 MiB) ====='
find / -xdev -type f -size +500M -printf '%s %p\n' 2>/dev/null \
  | sort -n \
  | tail -30 \
  | awk '{ size=$1; $1=""; printf "%.1f MiB%s\n", size/1048576, $0 }'

echo
echo '===== JOURNAL / LOGS / PACKAGE CACHE ====='
journalctl --disk-usage 2>&1 || true
du -sh /var/log /var/cache/apt /var/lib/apt/lists 2>/dev/null || true
ls -lhS /var/log 2>/dev/null | head -20 || true

echo
echo '===== CONTAINER STORAGE ====='
if command -v podman >/dev/null 2>&1; then
  echo '--- podman ps ---'
  podman ps --all --size 2>&1 || true
  echo '--- podman system df ---'
  podman system df 2>&1 || true
fi
if command -v docker >/dev/null 2>&1; then
  echo '--- docker ps ---'
  docker ps --all --size 2>&1 || true
  echo '--- docker system df ---'
  docker system df 2>&1 || true
fi
for path in /var/lib/containers /var/lib/docker; do
  [ -e "$path" ] && du -sh "$path" 2>/dev/null || true
done

echo
echo '===== REPOSITORY SIZES ====='
for repo in /srv/pi-agent-server /srv/pi-agent-capability-onev /srv/onev; do
  echo "--- $repo ---"
  du -sh "$repo" "$repo/.git" "$repo/node_modules" 2>/dev/null || true
  git -C "$repo" count-objects -vH 2>/dev/null || true
done

echo
echo '===== RUNNING APPLICATION PROCESSES ====='
ps -eo pid,ppid,user,etimes,%cpu,%mem,command --sort=-%mem \
  | grep -E 'PID|node|tsx|webpack|vite|nginx|podman|docker|conmon' \
  | head -80 || true

echo
echo '===== PORT OWNERS ====='
ss -lntp | grep -E ':(80|443|8080|9091)\b' || true

echo
echo '===== NGINX ROUTING SUMMARY ====='
nginx -T 2>/dev/null \
  | grep -nE '^[[:space:]]*(listen|server_name|root|alias|proxy_pass|location)[[:space:]]' \
  | head -240 || true

echo
echo '===== NODE TOOLCHAIN LOCATIONS ====='
for path in \
  /root/.volta \
  /root/.nvm \
  /home/onev/.volta \
  /usr/local/bin/pnpm \
  /usr/local/bin/volta \
  /usr/bin/corepack
do
  ls -ld "$path" 2>&1 || true
done
corepack --version 2>/dev/null || true
yarn --version 2>/dev/null || true
npm --version 2>/dev/null || true

echo
echo '===== END ====='
