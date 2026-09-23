#!/usr/bin/env bash
# Read-only production backup capability check. This does not create or run a backup.
set -uo pipefail
exec 2>&1

if [[ $(id -u) -ne 0 ]]; then
  echo 'ERROR: run as root (sudo bash ...)' >&2
  exit 1
fi

NODE_IMAGE=/home/onev/.volta/tools/image/node/22.22.3/bin/node
VOLTA=/home/onev/.volta/bin/volta
HOST=/srv/pi-agent-server
PLUGIN=/srv/pi-agent-capability-onev
ENV_FILE=/etc/pi-agent-server/onev.env

check_file() {
  if [[ -f "$1" ]]; then printf 'present=%s\n' "$1"; else printf 'missing=%s\n' "$1"; fi
}

printf '%s\n' '===== PINNED NODE / VOLTA ====='
if [[ -x "$NODE_IMAGE" ]]; then
  echo 'pinned_node=executable'
  if [[ -x "$VOLTA" ]]; then
    echo 'volta=executable'
    if env HOME=/home/onev VOLTA_HOME=/home/onev/.volta "$VOLTA" run --node 22.22.3 -- node -e '
const { DatabaseSync, backup } = require("node:sqlite");
if (typeof DatabaseSync !== "function" || typeof backup !== "function") {
  console.log("node_sqlite_backup_api=unavailable"); process.exitCode = 1;
} else {
  console.log(`node_sqlite_backup_api=available node=${process.version}`);
}' ; then :; else echo 'node_sqlite_probe=failed'; fi
  else
    echo 'volta=missing_or_not_executable'
  fi
else
  echo 'pinned_node=missing_or_not_executable (not invoking Volta; refusing download)'
fi

printf '%s\n' '===== HOST BACKUP FILES ====='
check_file "$HOST/dist-backup/scripts/backup.js"
check_file "$HOST/dist-backup/scripts/restore.js"
check_file "$HOST/scripts/backup.ts"

printf '%s\n' '===== PLUGIN BACKUP FILES (package bin mapping) ====='
# 已核对本地 package.json：onev 和 pi-agent-capability-onev 都指向 dist/cli.js。
check_file "$PLUGIN/dist/cli.js"
check_file "$PLUGIN/dist/backup/backup.js"
check_file "$PLUGIN/dist/backup/restore.js"
check_file "$PLUGIN/dist/storage/sqlite.js"

printf '%s\n' '===== REQUIRED COMMANDS ====='
for name in age age-keygen timeout tar sha256sum systemctl; do
  if command -v "$name" >/dev/null 2>&1; then printf '%s=available\n' "$name"; else printf '%s=missing\n' "$name"; fi
done

printf '%s\n' '===== KNOWN ENVIRONMENT KEYS (values withheld) ====='
for key in PI_BACKUP_STAGING_ROOT ONEV_BACKUP_ROOT; do
  if [[ -f "$ENV_FILE" ]] && grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE"; then
    printf '%s=present\n' "$key"
  else
    printf '%s=missing\n' "$key"
  fi
done
echo 'age_recipient_path=not_configured_in_known_deployment_convention (user secret directories not searched)'

printf '%s\n' '===== SERVICE STATE ====='
for unit in pi-agent-server.service onev-publisher.service; do
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  printf '%s active=%s enabled=%s\n' "$unit" "${active:-unknown}" "${enabled:-unknown}"
done

echo 'BACKUP_CAPABILITIES_CHECK_COMPLETE (核查完成；非已备份)'
