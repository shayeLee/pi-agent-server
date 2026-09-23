#!/usr/bin/env bash
# ONEV 裸机部署：阶段 14，启动并验收两个仅回环服务。
# 不 enable、不改 nginx、不调用外部模型或钉钉、不创建 sync job。

set -euo pipefail
exec 2>&1

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

for command_name in curl python3 ss systemctl; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "missing command: $command_name"
done

ENV_FILE=/etc/pi-agent-server/onev.env
HOST_UNIT=/etc/systemd/system/pi-agent-server.service
PUBLISHER_UNIT=/etc/systemd/system/onev-publisher.service
HOST_DB=/data/onev/pi-agent-server/pi-agent-server.db
PLUGIN_DB=/data/onev/pi-agent-capability-onev/onev.db

[ -f "$ENV_FILE" ] || fail 'environment file is missing'
[ -f "$HOST_UNIT" ] || fail 'host unit file is missing'
[ -f "$PUBLISHER_UNIT" ] || fail 'publisher unit file is missing'
[ -f "$HOST_DB" ] || fail 'host database is missing'
[ -f "$PLUGIN_DB" ] || fail 'plugin database is missing'

for unit in pi-agent-server.service onev-publisher.service; do
  if systemctl is-active --quiet "$unit"; then
    fail "$unit is already active; refusing to start"
  fi
done

for port in 18080 9091; do
  if ! listeners="$(ss -H -ltn "sport = :$port" 2>/dev/null)"; then
    fail 'ss listener check failed'
  fi
  [ -z "$listeners" ] || fail "port $port already has a listener"
done

echo 'PREFLIGHT_OK'

publisher_started=0
host_started=0

on_exit() {
  local rc="$1"
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    set +e
    echo 'START_FAILED: stopping only services started by this run' >&2
    if [ "$host_started" -eq 1 ]; then
      systemctl stop pi-agent-server.service >/dev/null 2>&1 \
        || echo 'WARNING: could not stop pi-agent-server.service' >&2
    fi
    if [ "$publisher_started" -eq 1 ]; then
      systemctl stop onev-publisher.service >/dev/null 2>&1 \
        || echo 'WARNING: could not stop onev-publisher.service' >&2
    fi
    echo 'For diagnosis, inspect: journalctl -u onev-publisher.service -u pi-agent-server.service --no-pager -n 100' >&2
  fi
  exit "$rc"
}
trap 'on_exit "$?"' EXIT

systemctl daemon-reload

publisher_started=1
systemctl start onev-publisher.service
host_started=1
systemctl start pi-agent-server.service

echo 'SERVICES_STARTED'

probe() {
  curl --fail --silent --connect-timeout 2 --max-time 5 "$1" >/dev/null 2>&1
}

wait_for_probes() {
  local deadline=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if probe 'http://127.0.0.1:18080/health' \
      && probe 'http://127.0.0.1:18080/readyz' \
      && probe 'http://127.0.0.1:9091/healthz'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_probes || fail 'health/readyz/publisher healthz did not pass within 60 seconds'
echo 'endpoint http://127.0.0.1:18080/health verified'
echo 'endpoint http://127.0.0.1:18080/readyz verified'
echo 'endpoint http://127.0.0.1:9091/healthz verified'

python3 - <<'PY'
import subprocess
import sys

expected_ports = {18080, 9091}
try:
    result = subprocess.run(
        ["ss", "-H", "-ltn"],
        check=True,
        capture_output=True,
        text=True,
    )
except (OSError, subprocess.CalledProcessError):
    raise SystemExit("python ss verification failed")

listeners = {port: [] for port in expected_ports}
for line in result.stdout.splitlines():
    fields = line.split()
    if len(fields) < 4:
        continue
    local = fields[3]
    host, separator, port_text = local.rpartition(":")
    if not separator or not port_text.isdigit():
        continue
    port = int(port_text)
    if port in listeners:
        listeners[port].append(host)

for port, hosts in listeners.items():
    if hosts != ["127.0.0.1"]:
        raise SystemExit(f"python ss verification failed for port {port}")

for unit in ("onev-publisher.service", "pi-agent-server.service"):
    status = subprocess.run(
        ["systemctl", "is-active", "--quiet", unit],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if status.returncode != 0:
        raise SystemExit("python systemd active verification failed")
PY

echo 'LOOPBACK_LISTENERS_VERIFIED'

ACCESS_ENDPOINT=http://127.0.0.1:18080/v1/capabilities/onev/access
check_access() {
  local client_ip="$1"
  local expected="$2"
  local body

  if ! body="$(curl --fail --silent --connect-timeout 2 --max-time 5 \
    -H "X-Forwarded-For: $client_ip" "$ACCESS_ENDPOINT" 2>/dev/null)"; then
    return 1
  fi

  if ! printf '%s' "$body" | python3 -c '
import json
import sys

try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)

expected = sys.argv[1] == "true"
if (
    not isinstance(value, dict)
    or set(value) != {"canBind"}
    or type(value.get("canBind")) is not bool
    or value["canBind"] is not expected
):
    raise SystemExit(1)
' "$expected"; then
    return 1
  fi
}

check_access 192.168.6.23 true \
  || fail 'access projection check failed for the first allowed client'
echo "endpoint $ACCESS_ENDPOINT X-Forwarded-For=192.168.6.23 canBind=true"
check_access 192.168.2.55 true \
  || fail 'access projection check failed for the second allowed client'
echo "endpoint $ACCESS_ENDPOINT X-Forwarded-For=192.168.2.55 canBind=true"
check_access 192.168.6.24 false \
  || fail 'access projection check failed for the denied client'
echo "endpoint $ACCESS_ENDPOINT X-Forwarded-For=192.168.6.24 canBind=false"

echo 'NOTE: no sync job was created; a worker may consume existing tasks.'
echo 'LOOPBACK_SERVICES_VERIFIED'
