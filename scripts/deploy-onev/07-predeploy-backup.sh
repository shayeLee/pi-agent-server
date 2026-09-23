#!/usr/bin/env bash
# ONEV 裸机部署：阶段 7，创建部署前备份与状态清单。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_base="${ONEV_BACKUP_ROOT:-/data/onev-backups}"
install -d -m 0700 "$backup_base"
backup_root="$backup_base/$stamp"
install -d -m 0700 "$backup_root"

exec > >(tee "$backup_root/backup.log") 2>&1

echo "BACKUP_ROOT=$backup_root"
echo '===== FILESYSTEMS ====='
df -h / "$backup_base"
root_avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
backup_avail_kb="$(df -Pk "$backup_base" | awk 'NR==2 {print $4}')"
if [ "$root_avail_kb" -lt 1048576 ]; then
  echo 'ERROR: root filesystem has less than 1 GiB available' >&2
  exit 1
fi
if [ "$backup_avail_kb" -lt 5242880 ]; then
  echo 'ERROR: backup filesystem has less than 5 GiB available' >&2
  exit 1
fi

if systemctl is-active --quiet pi-agent-server.service 2>/dev/null; then
  echo 'ERROR: pi-agent-server.service is active; stop writers before backup' >&2
  exit 1
fi

echo
echo '===== REPOSITORY MANIFESTS ====='
for repo in pi-agent-server pi-agent-capability-onev onev; do
  path="/srv/$repo"
  echo "--- $path ---"
  test -d "$path/.git"
  git -C "$path" status --porcelain=v1 > "$backup_root/$repo.status"
  if [ -s "$backup_root/$repo.status" ]; then
    echo "ERROR: dirty repository: $path" >&2
    cat "$backup_root/$repo.status" >&2
    exit 1
  fi
  git -C "$path" rev-parse HEAD | tee "$backup_root/$repo.head"
  git -C "$path" branch --show-current > "$backup_root/$repo.branch"
  git -C "$path" remote -v > "$backup_root/$repo.remotes"
done

echo
echo '===== NGINX / SYSTEMD / ENV ====='
tar -C / -czf "$backup_root/etc-nginx.tar.gz" etc/nginx
if [ -d /etc/systemd/system ]; then
  tar -C / -czf "$backup_root/etc-systemd-system.tar.gz" etc/systemd/system
fi
if [ -f /etc/pi-agent-server/onev.env ]; then
  install -m 0600 /etc/pi-agent-server/onev.env "$backup_root/onev.env"
fi
nginx -T > "$backup_root/nginx-T.txt" 2>&1
systemctl list-unit-files --type=service > "$backup_root/systemd-services.txt"
if command -v podman >/dev/null 2>&1; then
  podman inspect onemt-nginx > "$backup_root/onemt-nginx.inspect.json" 2>/dev/null || true
fi

echo
echo '===== OPTIONAL DATA ====='
# SQLite 使用在线一致性 backup；整个数据目录另行归档，以覆盖 JSONL、agent 状态、
# 插件附件及其他 sidecar。生产升级时必须先停 writer。
for db in \
  /data/onev/pi-agent-server/pi-agent-server.db \
  /data/onev/pi-agent-capability-onev/onev.db
do
  if [ -f "$db" ]; then
    out="$backup_root/$(basename "$db").backup"
    sqlite3 "$db" ".timeout 5000" ".backup '$out'"
    test "$(sqlite3 "$out" 'PRAGMA integrity_check;')" = 'ok'
  else
    echo "NOT FOUND: $db"
  fi
done

for data_dir in \
  /data/onev/pi-agent-server \
  /data/onev/pi-agent-capability-onev
do
  if [ -d "$data_dir" ]; then
    archive="$backup_root/$(basename "$data_dir")-data.tar.gz"
    tar -C "$(dirname "$data_dir")" -czf "$archive" "$(basename "$data_dir")"
    chmod 0600 "$archive"
  else
    echo "NOT FOUND: $data_dir"
  fi
done

if [ -d /srv/onev/examples/onev-ui ]; then
  tar -C /srv/onev/examples -czf "$backup_root/onev-ui.tar.gz" onev-ui
else
  echo 'NOT FOUND: /srv/onev/examples/onev-ui'
fi

echo
echo '===== CHECKSUMS ====='
(
  cd "$backup_root"
  sha256sum *.tar.gz *.backup 2>/dev/null || true
) | tee "$backup_root/SHA256SUMS"

sync
echo
echo '===== RESULT ====='
du -sh "$backup_root"
df -h / "$backup_base"
echo "BACKUP_COMPLETE=$backup_root"
