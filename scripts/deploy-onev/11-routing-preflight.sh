#!/usr/bin/env bash
# ONEV 路由部署：阶段 11，只读 Ubuntu root 检查。
# 只输出路由、监听、挂载和文件元数据摘要；不调用仓库工具、不读取凭据或配置文件内容。

exec 2>&1
set -u

if (( EUID != 0 )); then
  echo 'ERROR: must run as root'
  exit 1
fi

if ! command -v timeout >/dev/null 2>&1; then
  echo 'ERROR: timeout command is required; no checks were run'
  exit 1
fi

TIMEOUT_SECONDS=20

have_command() {
  command -v "$1" >/dev/null 2>&1
}

echo '===== ROUTING PREFLIGHT (READ ONLY) ====='
echo 'WARNING: this is a summary only; inspect it before sharing logs.'


echo
echo '===== LISTENING PORTS (ss) ====='
if ! have_command ss; then
  echo 'ss: NOT FOUND'
elif ! have_command python3; then
  echo 'python3: NOT FOUND; ss summary not filtered'
else
  timeout "${TIMEOUT_SECONDS}s" ss -lntp 2>/dev/null \
    | timeout "${TIMEOUT_SECONDS}s" python3 -c '
import re
import sys

ports = re.compile(r":(?:18080|9091|80|443)\b")
for line in sys.stdin:
    if ports.search(line):
        print(line.rstrip())
'
  ss_status=("${PIPESTATUS[@]}")
  if (( ss_status[0] != 0 )); then
    echo "ss: unavailable or failed (exit=${ss_status[0]})"
  elif (( ss_status[1] != 0 )); then
    echo "ss filter: failed (exit=${ss_status[1]})"
  fi
fi

INSPECT_FILTER='
import json
import sys

try:
    value = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if isinstance(value, list):
    value = value[0] if value else {}
if not isinstance(value, dict):
    sys.exit(0)

network_settings = value.get("NetworkSettings")
if not isinstance(network_settings, dict):
    network_settings = {}
raw_networks = network_settings.get("Networks")
if not isinstance(raw_networks, dict):
    raw_networks = {}
networks = {}
for name, details in raw_networks.items():
    if isinstance(details, dict):
        networks[str(name)] = {
            "Gateway": details.get("Gateway"),
            "IPAddress": details.get("IPAddress"),
        }

mounts = []
raw_mounts = value.get("Mounts")
if isinstance(raw_mounts, list):
    for mount in raw_mounts:
        if isinstance(mount, dict):
            mounts.append({
                "Source": mount.get("Source"),
                "Destination": mount.get("Destination"),
                "Type": mount.get("Type"),
                "RW": mount.get("RW"),
            })

host_config = value.get("HostConfig")
if not isinstance(host_config, dict):
    host_config = {}
network_mode = value.get("NetworkMode")
if network_mode is None:
    network_mode = host_config.get("NetworkMode")
port_bindings = host_config.get("PortBindings")
if port_bindings is None:
    port_bindings = network_settings.get("Ports", {})

summary = {
    "NetworkMode": network_mode,
    "Networks": networks,
    "Mounts": mounts,
    "PortBindings": port_bindings,
}
print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
'

print_nginx_summary() {
  local label="$1"
  shift
  echo
  echo "===== ${label} (nginx -T SUMMARY ONLY) ====="
  if ! have_command python3; then
    echo 'python3: NOT FOUND; nginx summary not filtered'
    return
  fi
  if ! have_command "$1"; then
    echo "$1: NOT FOUND"
    return
  fi

  timeout "${TIMEOUT_SECONDS}s" "$@" 2>/dev/null \
    | timeout "${TIMEOUT_SECONDS}s" python3 -c '
import re
import sys

source = re.compile(r"^\s*#\s*configuration\s+file\b", re.I)
directive = re.compile(
    r"^\s*(?:"
    r"listen|server_name|location|root|alias|proxy_pass|"
    r"real_ip_header|set_real_ip_from|real_ip_recursive"
    r")\b"
    r"|^\s*proxy_set_header\s+(?:X-Forwarded-For|X-Real-IP)\b",
    re.I,
)
for line in sys.stdin:
    if source.search(line) or directive.search(line):
        print(line.rstrip())
'
  nginx_status=("${PIPESTATUS[@]}")
  if (( nginx_status[0] != 0 )); then
    echo "nginx summary source command failed or timed out (exit=${nginx_status[0]})"
  elif (( nginx_status[1] != 0 )); then
    echo "nginx summary filter failed or timed out (exit=${nginx_status[1]})"
  fi
}


echo
echo '===== PODMAN CONTAINER NETWORK / MOUNTS (SELECTED FIELDS ONLY) ====='
if ! have_command podman; then
  echo 'podman: NOT FOUND'
elif ! have_command python3; then
  echo 'python3: NOT FOUND; podman inspect was not emitted'
else
  timeout "${TIMEOUT_SECONDS}s" podman inspect onemt-nginx 2>/dev/null \
    | timeout "${TIMEOUT_SECONDS}s" python3 -c "$INSPECT_FILTER"
  inspect_status=("${PIPESTATUS[@]}")
  if (( inspect_status[0] != 0 )); then
    echo "podman inspect onemt-nginx: unavailable or failed (exit=${inspect_status[0]})"
  elif (( inspect_status[1] != 0 )); then
    echo "podman inspect filter: failed or timed out (exit=${inspect_status[1]})"
  fi
fi

print_nginx_summary \
  'PODMAN onemt-nginx ROUTING' \
  podman exec onemt-nginx nginx -T

print_nginx_summary \
  'BARE-METAL NGINX ROUTING' \
  nginx -T


echo
echo '===== ONEV DWS HELP ONLY ====='
if ! have_command runuser; then
  echo 'runuser: NOT FOUND'
elif ! have_command bash; then
  echo 'bash: NOT FOUND; dws help was not run'
else
  timeout "${TIMEOUT_SECONDS}s" runuser -u onev -- env \
    HOME=/home/onev \
    VOLTA_HOME=/home/onev/.volta \
    PATH=/home/onev/.volta/bin:/usr/local/bin:/usr/bin:/bin \
    bash -c 'cd /srv/onev && dws --format json auth --help'
  dws_status=$?
  if (( dws_status != 0 )); then
    echo "dws auth --help: unavailable or failed (exit=${dws_status})"
  fi
fi


echo
echo '===== /home/onev/.dws PERMISSION ONLY ====='
if ! have_command ls; then
  echo 'ls: NOT FOUND'
else
  timeout "${TIMEOUT_SECONDS}s" ls -ld -- /home/onev/.dws 2>/dev/null
  dws_dir_status=$?
  if (( dws_dir_status != 0 )); then
    echo "/home/onev/.dws: not found or unavailable (exit=${dws_dir_status})"
  fi
fi


echo
echo '===== DWS-RELATED FILE EXISTENCE / STAT ONLY (NO CONTENT READ) ====='
if ! have_command stat; then
  echo 'stat: NOT FOUND'
else
  for path in \
    /data/onev/pi-agent-server/pi-agent/auth.json \
    /data/onev/pi-agent-server/pi-agent/models.json
  do
    if timeout "${TIMEOUT_SECONDS}s" stat \
      --printf='EXISTS %n mode=%A uid=%u gid=%g size=%s mtime=%y\n' \
      -- "$path" 2>/dev/null
    then
      :
    else
      stat_status=$?
      if (( stat_status == 124 )); then
        echo "STAT TIMEOUT: $path"
      else
        echo "NOT FOUND: $path"
      fi
    fi
  done
fi


echo
echo '===== FILESYSTEM CAPACITY ====='
if ! have_command df; then
  echo 'df: NOT FOUND'
else
  timeout "${TIMEOUT_SECONDS}s" df -h -- / /data
  df_status=$?
  if (( df_status != 0 )); then
    echo "df: unavailable or failed (exit=${df_status})"
  fi
fi


echo
echo '===== END: SUMMARY ONLY; CHECK BEFORE SHARING ====='
