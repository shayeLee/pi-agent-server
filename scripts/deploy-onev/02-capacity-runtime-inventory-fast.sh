#!/usr/bin/env bash
# ONEV 裸机部署：阶段 2 快速版。只读、按目录限时，不扫描整个根文件系统。

set -u

run_limited_du() {
  local path="$1"
  echo "--- $path ---"
  if [ ! -e "$path" ]; then
    echo 'NOT FOUND'
    return
  fi
  timeout 20s du -x -h --max-depth=1 "$path" 2>/dev/null \
    | sort -h | tail -20
  local rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 124 ]; then
    echo "TIMEOUT after 20s: $path"
  fi
}

echo '===== FILESYSTEM ====='
df -hT /
df -ih /

echo
echo '===== CONTAINER SUMMARY ====='
if command -v podman >/dev/null 2>&1; then
  timeout 20s podman ps --all --size 2>&1 || true
  timeout 20s podman system df 2>&1 || true
fi
if command -v docker >/dev/null 2>&1; then
  timeout 20s docker ps --all --size 2>&1 || true
  timeout 20s docker system df 2>&1 || true
fi

echo
echo '===== JOURNAL / LOGS / CACHE ====='
journalctl --disk-usage 2>&1 || true
du -sh \
  /var/log \
  /var/cache/apt \
  /var/lib/apt/lists \
  /var/cache \
  /tmp \
  2>/dev/null || true

echo
echo '===== TARGETED DIRECTORY USAGE ====='
for path in \
  /var/lib/containers \
  /var/lib/docker \
  /var/lib \
  /var/log \
  /srv \
  /root \
  /home \
  /opt \
  /tmp
do
  run_limited_du "$path"
done

echo
echo '===== REPOSITORIES ====='
for repo in /srv/pi-agent-server /srv/pi-agent-capability-onev /srv/onev; do
  echo "--- $repo ---"
  du -sh "$repo" "$repo/.git" "$repo/node_modules" 2>/dev/null || true
  git -C "$repo" status --short 2>/dev/null || true
done

echo
echo '===== LARGE LOG / CACHE FILES ====='
find /var/log /var/cache /tmp /srv \
  -xdev -type f -size +200M -printf '%s %p\n' 2>/dev/null \
  | sort -n | tail -30 \
  | awk '{ size=$1; $1=""; printf "%.1f MiB%s\n", size/1048576, $0 }'

echo
echo '===== NGINX ROUTING SUMMARY ====='
nginx -T 2>/dev/null \
  | grep -nE '^[[:space:]]*(listen|server_name|root|alias|proxy_pass|location)[[:space:]]' \
  | head -240 || true

echo
echo '===== TOOLCHAIN ABSOLUTE PATHS ====='
bash -lc '
  command -v node || true
  command -v pnpm || true
  command -v yarn || true
  command -v volta || true
  node --version 2>/dev/null || true
  pnpm --version 2>/dev/null || true
  yarn --version 2>/dev/null || true
  volta --version 2>/dev/null || true
'

echo
echo '===== END ====='
