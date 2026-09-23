#!/usr/bin/env bash
# ONEV 裸机部署：阶段 16，只新增宿主 nginx relay。
# 不修改容器配置、不切换网站、不 git、不 sync/build、不读密钥。
#
# 拓扑：
#   浏览器 --HTTPS--> Podman 容器 onemt-nginx (10.88.0.2, 网关 10.88.0.1)
#     --http--> 宿主 nginx relay 10.88.0.1:18081 --http--> 127.0.0.1:18080
#
# 本脚本只做四件事：
#   1) 只读预检：/data 挂载、前端 index 可读、nginx -t、两个后台 active、
#      容器网络/状态精确匹配（Python 校验，不打印 Env）；
#   2) 备份目标配置（如存在）到 /data/onev-backups/<唯一目录> (0700)；
#   3) 写入 /etc/nginx/conf.d/onev-agent-relay.conf，nginx -t 后 reload（不 restart）；
#   4) 验收：借 nsenter 进入容器 netns 调宿主 curl 模拟容器来源，本机直连伪造 XFF 必须 403。
# 任何失败都会恢复旧目标或移除新目标，并重新 nginx -t && reload；
# 绝不停止 pi-agent-server / onev-publisher。

set -euo pipefail
exec 2>&1

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

# ---- 固定预期值（按现场实测，不要随意放宽）----
CONTAINER=onemt-nginx
BRIDGE_IP=10.88.0.2
BRIDGE_GW=10.88.0.1
RELAY_ADDR=10.88.0.1
RELAY_PORT=18081
RELAY_SERVER_NAME=onev-ui.onemt.co
RELAY_ENDPOINT="http://${RELAY_ADDR}:${RELAY_PORT}"
AGENT_ENDPOINT=http://127.0.0.1:18080
FRONTEND_INDEX=/srv/onev/examples/onev-ui/index.html
TARGET=/etc/nginx/conf.d/onev-agent-relay.conf
BACKUP_ROOT=/data/onev-backups
CLIENT_ADMIN_A=192.168.6.23
CLIENT_ADMIN_B=192.168.2.55
CLIENT_DENIED=192.168.6.24

STAGE=''
BACKUP_DIR=''
HAD_OLD=0
INSTALLED=0

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

reload_nginx() {
  if systemctl reload nginx >/dev/null 2>&1; then
    return 0
  fi
  nginx -s reload
}

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if [ "$INSTALLED" -eq 1 ] && [ "$rc" -ne 0 ]; then
    echo 'ROLLBACK: relay install/verify failed; restoring previous state' >&2
    if [ "$HAD_OLD" -eq 1 ] && [ -f "$BACKUP_DIR/onev-agent-relay.conf" ]; then
      if ! install -o root -g root -m 0644 "$BACKUP_DIR/onev-agent-relay.conf" "$TARGET"; then
        echo 'ROLLBACK FAILED: manual restoration required; refusing reload' >&2
        rm -rf "$STAGE"
        exit "$rc"
      fi
      echo "ROLLBACK: restored $TARGET from $BACKUP_DIR" >&2
    else
      if ! rm -f "$TARGET"; then
        echo 'ROLLBACK FAILED: manual removal required; refusing reload' >&2
        rm -rf "$STAGE"
        exit "$rc"
      fi
      echo "ROLLBACK: removed new $TARGET" >&2
    fi
    if nginx -t; then
      if reload_nginx; then
        echo 'ROLLBACK: nginx reloaded with restored configuration' >&2
      else
        echo 'ROLLBACK: nginx reload failed after restore' >&2
      fi
    else
      echo 'ROLLBACK: nginx -t failed after restore; manual intervention required' >&2
    fi
  fi
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  exit "$rc"
}
trap on_exit EXIT

STAGE="$(mktemp -d)"

echo '===== PREFLIGHT (READ ONLY) ====='
for command_name in ss curl python3 nginx systemctl podman nsenter runuser \
  mountpoint install grep mktemp date cp rm; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done
CURL_BIN="$(command -v curl)"

[ -d /etc/nginx/conf.d ] || fail '/etc/nginx/conf.d does not exist'
mountpoint -q /data || fail '/data is not a mountpoint'
[ -f "$FRONTEND_INDEX" ] || fail "missing frontend index: $FRONTEND_INDEX"
runuser -u www-data -- test -r "$FRONTEND_INDEX" \
  || fail "www-data cannot read $FRONTEND_INDEX"
echo "frontend index readable by www-data: $FRONTEND_INDEX"

listeners="$(ss -H -ltn "sport = :${RELAY_PORT}" 2>/dev/null)" \
  || fail 'ss listener check failed'
[ -z "$listeners" ] || fail "port ${RELAY_PORT} already has a listener; refusing to run"
echo "port ${RELAY_PORT} is free"

for unit in pi-agent-server.service onev-publisher.service; do
  systemctl is-active --quiet "$unit" || fail "$unit is not active"
done
echo 'backends active: pi-agent-server.service, onev-publisher.service'

nginx -t || fail 'current nginx configuration fails nginx -t'
echo 'current nginx -t OK'

probe_agent() {
  curl --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    --output /dev/null "$1"
}
probe_agent "$AGENT_ENDPOINT/health" || fail 'agent /health probe failed'
probe_agent "$AGENT_ENDPOINT/readyz" || fail 'agent /readyz probe failed'
echo 'agent /health and /readyz are reachable on loopback'

# 容器网络/状态：Python 精确校验；只输出网络摘要，绝不打印 Env。
podman inspect "$CONTAINER" > "$STAGE/inspect.json" \
  || fail "podman inspect $CONTAINER failed"
python3 - "$STAGE/inspect.json" <<'PY'
import json
import sys

with open(sys.argv[1], 'rb') as fh:
    data = json.load(fh)

if not isinstance(data, list) or len(data) != 1:
    raise SystemExit('container inspect: expected exactly one container')

container = data[0]
name = str(container.get('Name', '')).lstrip('/')
if name != 'onemt-nginx':
    raise SystemExit(f'container name mismatch: {name!r}')

state = container.get('State') or {}
if state.get('Running') is not True or state.get('Status') != 'running':
    raise SystemExit('container is not running')

networks = (container.get('NetworkSettings') or {}).get('Networks') or {}
pairs = []
for net_name, details in networks.items():
    if isinstance(details, dict):
        pairs.append((net_name, details.get('IPAddress'), details.get('Gateway')))
if not pairs:
    raise SystemExit('container has no networks')

expected = ('10.88.0.2', '10.88.0.1')
if not any((ip, gw) == expected for _, ip, gw in pairs):
    raise SystemExit(f'container bridge ip/gateway mismatch: {pairs}')
for net_name, ip, gw in pairs:
    if ip and ip != '10.88.0.2':
        raise SystemExit(f'unexpected container ip on network {net_name}: {ip}')

summary = ','.join(f'{n}:{ip}/{gw}' for n, ip, gw in pairs)
print(f'container running with expected bridge: {summary}')
PY

CONTAINER_PID="$(podman inspect -f '{{.State.Pid}}' "$CONTAINER")" \
  || fail 'could not read container State.Pid'
case "$CONTAINER_PID" in
  ''|*[!0-9]*) fail "invalid container pid: $CONTAINER_PID" ;;
esac
[ "$CONTAINER_PID" -gt 0 ] || fail 'container pid is not positive'
echo "container pid: $CONTAINER_PID"

echo
echo '===== BACKUP TARGET (IF ANY) ====='
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
BACKUP_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$-relay"
install -d -o root -g root -m 0700 "$BACKUP_DIR"
if [ -e "$TARGET" ]; then
  [ -f "$TARGET" ] || fail "target exists but is not a regular file: $TARGET"
  cp -a -- "$TARGET" "$BACKUP_DIR/onev-agent-relay.conf"
  HAD_OLD=1
  echo "backed up: $TARGET -> $BACKUP_DIR/onev-agent-relay.conf"
else
  echo "no existing target; recorded empty baseline"
fi
nginx -T > "$BACKUP_DIR/nginx-T.before.txt" 2>&1 || true
ls -la "$BACKUP_DIR"
echo "BACKUP_DIR=$BACKUP_DIR"

echo
echo '===== INSTALL RELAY CONFIG ====='
cat > "$STAGE/onev-agent-relay.conf" <<'NGINX'
# ONEV 宿主 relay（由 scripts/deploy-onev/16-prepare-nginx-relay.sh 生成）。
# 只把容器 nginx (10.88.0.2) 转发来的同源请求接入 127.0.0.1:18080；
# 不承载其它站点，不代理 /metrics，不修改任何既有 conf.d 文件。

# 只有原始对端为容器 bridge IP 时才放行，否则一律 403。
map $realip_remote_addr $onev_ui_relay_peer_ok {
    default   0;
    10.88.0.2 1;
}

server {
    listen      10.88.0.1:18081;
    server_name onev-ui.onemt.co;

    # 只信任容器 nginx 的 X-Forwarded-For，取最右一段作为真实客户端 IP。
    set_real_ip_from    10.88.0.2/32;
    real_ip_header      X-Forwarded-For;
    real_ip_recursive   off;

    # 非容器来源（含本机直连伪造 XFF）直接拒绝。
    if ($onev_ui_relay_peer_ok = 0) {
        return 403;
    }
    # 只接受生产域名 Host。
    if ($host != onev-ui.onemt.co) {
        return 403;
    }

    root  /srv/onev/examples/onev-ui;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # 共享代理参数：下面各 location 不覆盖 proxy_set_header，因此全部继承。
    proxy_http_version  1.1;
    proxy_set_header    Connection "";
    proxy_set_header    Host onev-ui.onemt.co;
    proxy_set_header    X-Forwarded-For $remote_addr;
    proxy_set_header    X-Real-IP $remote_addr;
    proxy_set_header    Forwarded "";
    proxy_set_header    CF-Connecting-IP "";
    proxy_set_header    True-Client-IP "";
    proxy_buffering     off;
    proxy_cache         off;
    proxy_read_timeout  1h;
    # client_max_body_size 不在此设置：继承 http 级现宿主上传上限，避免自设奇怪值。

    location = /v1 {
        proxy_pass http://127.0.0.1:18080;
    }
    location ^~ /v1/ {
        proxy_pass http://127.0.0.1:18080;
    }
    location = /health {
        proxy_pass http://127.0.0.1:18080;
    }
    location = /readyz {
        proxy_pass http://127.0.0.1:18080;
    }
}
NGINX

INSTALLED=1
install -o root -g root -m 0644 "$STAGE/onev-agent-relay.conf" "$TARGET"
sha256sum "$TARGET"
echo 'client_max_body_size: inherited from host http block (not overridden)'
nginx -T 2>/dev/null | grep -n 'client_max_body_size' | sed 's/^/  host: /' || true

nginx -t || fail 'new relay configuration fails nginx -t'
if ! nginx -T 2>/dev/null | grep 'onev-agent-relay.conf' >/dev/null; then
  fail 'relay config not included by host nginx (expect include /etc/nginx/conf.d/*.conf)'
fi
echo 'new relay config passes nginx -t and is included'

reload_nginx || fail 'nginx reload failed'
echo 'nginx reloaded (no restart)'

echo
echo '===== VERIFY ====='
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ss -H -ltn "sport = :${RELAY_PORT}" | grep -q . && break
  sleep 1
done

python3 - <<'PY'
import subprocess

result = subprocess.run(
    ["ss", "-H", "-ltn", "sport = :18081"],
    capture_output=True,
    text=True,
)
if result.returncode != 0:
    raise SystemExit("ss listener check failed")

addresses = []
for line in result.stdout.splitlines():
    fields = line.split()
    if len(fields) < 4:
        continue
    host, separator, port = fields[3].rpartition(":")
    if separator and port == "18081":
        addresses.append(host)

if addresses != ["10.88.0.1"]:
    raise SystemExit(f"unexpected 18081 bind addresses: {addresses}")
print("ss: 18081 is bound only to 10.88.0.1")
PY

ns_fetch() { # <outfile> <url> [curl args...]
  local out="$1" url="$2"
  shift 2
  nsenter --target "$CONTAINER_PID" --net -- "$CURL_BIN" \
    --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 15 \
    --output "$out" --write-out '%{http_code}' "$@" "$url"
}

# 容器来源：/health 与 /readyz。
code="$(ns_fetch "$STAGE/health.body" "$RELAY_ENDPOINT/health" \
  -H "Host: $RELAY_SERVER_NAME" -H "X-Forwarded-For: $CLIENT_ADMIN_A")" \
  || fail 'container-source /health probe failed to connect'
[ "$code" = '200' ] || fail "container-source /health returned $code (expected 200)"
echo 'container-source /health 200'

code="$(ns_fetch "$STAGE/readyz.body" "$RELAY_ENDPOINT/readyz" \
  -H "Host: $RELAY_SERVER_NAME" -H "X-Forwarded-For: $CLIENT_ADMIN_A")" \
  || fail 'container-source /readyz probe failed to connect'
[ "$code" = '200' ] || fail "container-source /readyz returned $code (expected 200)"
echo 'container-source /readyz 200'

# 容器来源但 Host 不对：必须 403。
code="$(ns_fetch "$STAGE/badhost.body" "$RELAY_ENDPOINT/health" \
  -H "Host: wrong.example" -H "X-Forwarded-For: $CLIENT_ADMIN_A")" \
  || fail 'wrong-Host probe failed to connect'
[ "$code" = '403' ] || fail "wrong Host returned $code (expected 403)"
echo 'container-source wrong Host rejected with 403'

# 容器来源 + XFF：3 个 canBind 严格布尔对象。
check_canbind() {
  local xff="$1" expected="$2" code
  code="$(ns_fetch "$STAGE/access.body" \
    "$RELAY_ENDPOINT/v1/capabilities/onev/access" \
    -H "Host: $RELAY_SERVER_NAME" -H "X-Forwarded-For: $xff")" || return 1
  [ "$code" = '200' ] || return 1
  python3 - "$STAGE/access.body" "$expected" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], 'rb') as fh:
        value = json.load(fh)
except Exception:
    raise SystemExit(1)

expected = sys.argv[2] == 'true'
if (
    not isinstance(value, dict)
    or set(value) != {'canBind'}
    or type(value.get('canBind')) is not bool
    or value['canBind'] is not expected
):
    raise SystemExit(1)
PY
}

check_canbind "$CLIENT_ADMIN_A" true \
  || fail "canBind check failed for $CLIENT_ADMIN_A"
echo "container-source canBind=true for $CLIENT_ADMIN_A"
check_canbind "$CLIENT_ADMIN_B" true \
  || fail "canBind check failed for $CLIENT_ADMIN_B"
echo "container-source canBind=true for $CLIENT_ADMIN_B"
check_canbind "$CLIENT_DENIED" false \
  || fail "canBind check failed for $CLIENT_DENIED"
echo "container-source canBind=false for $CLIENT_DENIED"

# 容器来源：静态 index。
code="$(ns_fetch "$STAGE/index.body" "$RELAY_ENDPOINT/index.html" \
  -H "Host: $RELAY_SERVER_NAME")" \
  || fail 'static index probe failed to connect'
[ "$code" = '200' ] || fail "static /index.html returned $code (expected 200)"
echo 'container-source static /index.html 200'

# 本机直连同一 bridge 地址：对端不是 10.88.0.2，伪造管理员 XFF 必须 403。
for path in /health /v1/capabilities/onev/access; do
  code="$(curl --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' \
    -H "Host: $RELAY_SERVER_NAME" -H "X-Forwarded-For: $CLIENT_ADMIN_A" \
    "$RELAY_ENDPOINT$path")" \
    || fail "host-direct probe failed to connect: $path"
  [ "$code" = '403' ] || fail "host-direct $path returned $code (expected 403)"
  echo "host-direct $path rejected with 403 (peer is not $BRIDGE_IP)"
done

INSTALLED=0
echo
echo '===== SUMMARY ====='
echo "relay config     : $TARGET (root:root 0644)"
echo "listen           : ${RELAY_ADDR}:${RELAY_PORT} -> 127.0.0.1:18080"
echo "peer allowlist   : ${BRIDGE_IP} only (gateway ${BRIDGE_GW})"
echo "backup dir       : $BACKUP_DIR"
echo 'NOT DONE (by design): no container config change, no site switch, no git, no sync/build, no /metrics proxy.'
echo 'PREPARE_NGINX_RELAY_COMPLETE'
