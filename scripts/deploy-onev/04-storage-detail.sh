#!/usr/bin/env bash
# ONEV 裸机部署：阶段 4，只读检查 /data、/tmp 与 Volta 的详细占用。

set -u

limited_du() {
  local seconds="$1"
  local depth="$2"
  local path="$3"
  echo "--- $path (max depth $depth, timeout ${seconds}s) ---"
  if [ ! -e "$path" ]; then
    echo 'NOT FOUND'
    return
  fi
  timeout "${seconds}s" du -x -h --max-depth="$depth" "$path" 2>/dev/null \
    | sort -h | tail -40
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 124 ] && echo "TIMEOUT: $path" || true
}

echo '===== FILESYSTEM ====='
df -hT /

echo
echo '===== /data ====='
limited_du 60 1 /data

echo
echo '===== /tmp ====='
limited_du 40 1 /tmp

echo
echo '===== VOLTA ====='
limited_du 30 3 /root/.volta

echo
echo '===== VOLTA INSTALLED TOOL IMAGES ====='
for path in \
  /root/.volta/tools/image/node \
  /root/.volta/tools/image/npm \
  /root/.volta/tools/image/yarn \
  /root/.volta/tools/image/pnpm \
  /root/.volta/tools/inventory; do
  echo "--- $path ---"
  ls -lah "$path" 2>/dev/null || true
done

echo
echo '===== DELETED BUT OPEN FILES ====='
lsof +L1 2>/dev/null \
  | awk 'NR==1 || $7 ~ /^[0-9]+$/' \
  | sort -k7,7n \
  | tail -30 || true

echo
echo '===== END ====='
