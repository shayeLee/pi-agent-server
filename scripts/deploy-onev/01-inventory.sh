#!/usr/bin/env bash
# ONEV 裸机部署：阶段 1，只读生产环境盘点。
# 本脚本不会修改文件、仓库、数据库或服务状态，也不会输出环境变量值。

set -u

echo '===== SYSTEM ====='
hostname
date
head -5 /etc/os-release
uname -m
df -h / /srv
free -h

echo
echo '===== USERS ====='
id onev 2>&1 || true
getent passwd www-data nginx onev 2>/dev/null || true

echo
echo '===== REPOSITORIES ====='
for repo in \
  /srv/pi-agent-server \
  /srv/pi-agent-capability-onev \
  /srv/onev
do
  echo "--- $repo ---"
  if [ -d "$repo/.git" ]; then
    git -C "$repo" status --short
    git -C "$repo" branch --show-current
    git -C "$repo" log -3 --oneline
    git -C "$repo" remote -v \
      | sed -E 's#(https?://)[^/@]+@#\1***@#'
  else
    echo 'NOT A GIT REPOSITORY'
  fi
done

echo
echo '===== RUNTIMES ====='
command -v node || true
command -v npm || true
command -v pnpm || true
command -v yarn || true
command -v volta || true
node --version 2>/dev/null || true
pnpm --version 2>/dev/null || true
volta --version 2>/dev/null || true

echo
echo '===== SERVICES ====='
systemctl list-unit-files --type=service \
  | grep -E 'pi-agent|onev|publisher' || true

for unit in \
  pi-agent-server.service \
  onev-publisher.service
do
  echo "--- $unit status ---"
  systemctl show "$unit" --no-pager -p ActiveState -p SubState -p UnitFileState 2>&1 || true
  echo "--- $unit definition ---"
  systemctl cat "$unit" 2>&1 \
    | sed -E 's/(API_KEY|TOKEN|SECRET|PASSWORD)=[^[:space:]]+/\1=***REDACTED***/g' \
    | head -120 || true
done

echo
echo '===== PORTS ====='
ss -lntp | grep -E ':(80|443|8080|9091)\b' || true

echo
echo '===== NGINX ====='
nginx -t 2>&1 || true
systemctl show nginx --no-pager -p ActiveState -p SubState -p UnitFileState 2>&1 || true

echo
echo '===== DATA PATHS ====='
for path in \
  /var/lib/pi-agent-server \
  /var/lib/pi-agent-capability-onev \
  /srv/onev/examples/onev-ui
do
  echo "--- $path ---"
  ls -ld "$path" 2>&1 || true
  du -sh "$path" 2>/dev/null || true
done

echo
echo '===== ENV KEYS ONLY, NO VALUES ====='
if [ -f /etc/pi-agent-server/onev.env ]; then
  sed -n 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' \
    /etc/pi-agent-server/onev.env | sort
else
  echo '/etc/pi-agent-server/onev.env NOT FOUND'
fi

echo
echo '===== END ====='
