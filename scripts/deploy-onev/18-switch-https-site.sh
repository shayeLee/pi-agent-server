#!/usr/bin/env bash
# ONEV 裸机部署：阶段 18，把 HTTPS 站点容器内 nginx 的旧静态 location 切换为
# 反代宿主 relay（10.88.0.1:18081）。由用户在真实 Ubuntu 上以 root 执行。
#
# 只改 /data/www/nginx/conf.d/onev-ui.conf 中唯一一个旧静态 location 块；
# 不 git、不安装、不联网下载、不改容器定义/网络、不改 onev-pro、不重启容器；
# 只 podman exec onemt-nginx nginx -t 后 nginx -s reload。
# 失败时用写入前已 armed 的 rollback 恢复备份并重新 nginx -t/reload；
# 不 trap 停止任何服务，不删除旧静态目录，不 enable 任何 unit。

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
SITE_NAME=onev-ui.onemt.co
TARGET=/data/www/nginx/conf.d/onev-ui.conf
OLD_STATIC=/data/www/nginx/html/onev-ui
FRONTEND_INDEX=/srv/onev/examples/onev-ui/index.html
BACKUP_ROOT=/data/onev-backups
ACCESS_PATH=/v1/capabilities/onev/access
INJECT_XFF=192.168.6.23

STAGE=''
BACKUP_DIR=''
ARMED=0

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if [ "$ARMED" -eq 1 ] && [ "$rc" -ne 0 ]; then
    echo 'ROLLBACK: switch failed; restoring previous onev-ui.conf' >&2
    if cp --preserve=all -- "$BACKUP_DIR/onev-ui.conf.original" "$TARGET"; then
      local want got
      want="$(sha256sum "$BACKUP_DIR/onev-ui.conf" | awk '{print $1}')"
      got="$(sha256sum "$TARGET" | awk '{print $1}')"
      if [ -n "$want" ] && [ "$want" = "$got" ]; then
        echo 'ROLLBACK: restored config checksum verified' >&2
        if podman exec "$CONTAINER" nginx -t >/dev/null 2>&1; then
          if podman exec "$CONTAINER" nginx -s reload >/dev/null 2>&1; then
            echo 'ROLLBACK: container nginx reloaded with restored config' >&2
          else
            echo 'ROLLBACK: container nginx reload failed after restore' >&2
          fi
        else
          echo 'ROLLBACK: container nginx -t failed after restore; refusing reload' >&2
        fi
      else
        echo 'ROLLBACK FAILED: restored config checksum mismatch; refusing reload' >&2
      fi
    else
      echo 'ROLLBACK FAILED: could not restore config from backup' >&2
    fi
  fi
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  exit "$rc"
}
trap on_exit EXIT

STAGE="$(mktemp -d)"

echo '===== PREFLIGHT (READ ONLY) ====='
for command_name in podman nsenter curl python3 systemctl mountpoint install \
  tar df du stat sha256sum cmp awk grep mktemp rm cat; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done
CURL_BIN="$(command -v curl)"

mountpoint -q /data || fail '/data is not a mountpoint'
[ -f "$TARGET" ] || fail "missing target config: $TARGET"
[ "$(stat -c '%U:%G:%a' "$TARGET")" = 'root:root:644' ] \
  || fail 'existing site config must be root:root 0644; refusing to change its permission policy'
[ -d "$OLD_STATIC" ] || fail "missing old static directory: $OLD_STATIC"
[ -f "$FRONTEND_INDEX" ] || fail "missing frontend index: $FRONTEND_INDEX"
echo "target config  : $TARGET"
echo "old static dir : $OLD_STATIC"
echo "frontend index : $FRONTEND_INDEX"

python3 - "$TARGET" <<'PY'
import os
import sys

path = sys.argv[1]
cur = '/'
for part in path.strip('/').split('/'):
    cur = os.path.join(cur, part)
    if os.path.islink(cur):
        raise SystemExit(f'symlink in target path: {cur}')
if not os.path.isfile(path):
    raise SystemExit(f'target is not a regular file: {path}')
print('target path has no symlink components and is a regular file')
PY

for unit in pi-agent-server.service onev-publisher.service; do
  systemctl is-active --quiet "$unit" || fail "$unit is not active"
done
echo 'host services active: pi-agent-server.service, onev-publisher.service'

probe() {
  curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    --output /dev/null "$1"
}
probe http://127.0.0.1:18080/health || fail 'agent /health probe failed'
probe http://127.0.0.1:18080/readyz || fail 'agent /readyz probe failed'
probe http://127.0.0.1:9091/healthz || fail 'publisher /healthz probe failed'
echo 'agent /health, /readyz and publisher /healthz are reachable'

podman inspect "$CONTAINER" > "$STAGE/inspect.json" \
  || fail "podman inspect $CONTAINER failed"
python3 - "$STAGE/inspect.json" "$STAGE/container-conf.path" <<'PY'
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

# 从实际 bind mount 推导容器内 onev-ui.conf 路径，不假设固定路径。
mounts = container.get('Mounts') or []
destinations = []
for mount in mounts:
    if not isinstance(mount, dict) or mount.get('Type') != 'bind':
        continue
    source = str(mount.get('Source') or '')
    destination = str(mount.get('Destination') or '')
    if source == '/data/www/nginx/conf.d/onev-ui.conf':
        raise SystemExit('Single-file bind mount is not supported; directory mount required')
    elif source == '/data/www/nginx/conf.d':
        destinations.append(destination.rstrip('/') + '/onev-ui.conf')
if len(destinations) != 1:
    raise SystemExit(f'could not uniquely resolve container onev-ui.conf path: {destinations}')
container_conf = destinations[0]
if not container_conf.startswith('/etc/nginx/') or not container_conf.endswith('.conf'):
    raise SystemExit(f'unexpected container onev-ui.conf path: {container_conf}')
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    fh.write(container_conf)
print(f'container config path from bind mount: {container_conf}')
PY

CONTAINER_CONF="$(cat "$STAGE/container-conf.path")"
[ -n "$CONTAINER_CONF" ] || fail 'could not resolve container onev-ui.conf path'

CONTAINER_PID="$(podman inspect -f '{{.State.Pid}}' "$CONTAINER")" \
  || fail 'could not read container State.Pid'
case "$CONTAINER_PID" in
  ''|*[!0-9]*) fail "invalid container pid: $CONTAINER_PID" ;;
esac
[ "$CONTAINER_PID" -gt 0 ] || fail 'container pid is not positive'
echo "container pid: $CONTAINER_PID"

host_sha="$(sha256sum "$TARGET" | awk '{print $1}')"
container_sha="$(podman exec "$CONTAINER" cat "$CONTAINER_CONF" | sha256sum | awk '{print $1}')"
[ -n "$container_sha" ] || fail "could not read container $CONTAINER_CONF"
[ "$host_sha" = "$container_sha" ] \
  || fail 'host and container onev-ui.conf differ; bind mount not confirmed'
echo 'bind mount confirmed: host and container onev-ui.conf match'

podman exec "$CONTAINER" nginx -t || fail 'current container nginx -t failed'
echo 'current container nginx -t OK'

relay_code="$(nsenter --target "$CONTAINER_PID" --net -- "$CURL_BIN" \
  --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 10 \
  --output /dev/null --write-out '%{http_code}' \
  -H "Host: $SITE_NAME" "http://${RELAY_ADDR}:${RELAY_PORT}/index.html")" \
  || fail 'relay static probe failed to connect'
[ "$relay_code" = '200' ] || fail "relay static returned $relay_code (expected 200)"
echo 'relay static via container netns: /index.html 200'

echo
echo '===== BACKUP ====='
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/onev-ui-https-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
chmod 0700 "$BACKUP_DIR"
[ -d "$BACKUP_DIR" ] || fail 'could not create backup directory'

need_kb=$(( $(du -sk "$OLD_STATIC" | awk '{print $1}') + 65536 ))
avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
case "$avail_kb" in
  ''|*[!0-9]*) fail "could not read free space for $BACKUP_DIR" ;;
esac
echo "backup need >= ${need_kb} KiB; /data free ${avail_kb} KiB"
[ "$avail_kb" -ge "$need_kb" ] \
  || fail "insufficient space on /data for backup (need ${need_kb} KiB, have ${avail_kb} KiB)"

cp --preserve=all -- "$TARGET" "$BACKUP_DIR/onev-ui.conf.original" \
  || fail 'could not preserve original config metadata in private backup directory'
install -o root -g root -m 0600 "$TARGET" "$BACKUP_DIR/onev-ui.conf" \
  || fail 'could not back up config'
tar -C "$(dirname "$OLD_STATIC")" -cf "$BACKUP_DIR/onev-ui-html.tar" \
  "$(basename "$OLD_STATIC")" || fail 'could not back up old static directory'
chmod 0600 "$BACKUP_DIR/onev-ui.conf" "$BACKUP_DIR/onev-ui-html.tar"
ls -la "$BACKUP_DIR"
echo "BACKUP_DIR=$BACKUP_DIR"

echo
echo '===== SWITCH LOCATION ====='
python3 - "$TARGET" "$STAGE/onev-ui.conf.new" <<'PY'
import re
import sys

src_path, out_path = sys.argv[1], sys.argv[2]
with open(src_path, 'r', encoding='utf-8', newline='') as fh:
    src = fh.read()

# 精确匹配旧静态 location 块（恰好三行指令，不宽泛匹配嵌套块）。
pattern = re.compile(
    r'^(?P<indent>[ \t]*)location[ \t]+/[ \t]*\{[ \t]*\r?\n'
    r'[ \t]*root[ \t]+/usr/share/nginx/html/onev-ui[ \t]*;[ \t]*\r?\n'
    r'[ \t]*index[ \t]+index\.html[ \t]+index\.htm[ \t]*;[ \t]*\r?\n'
    r'[ \t]*try_files[ \t]+\$uri[ \t]+\$uri/[ \t]+/index\.html[ \t]*;[ \t]*\r?\n'
    r'[ \t]*\}[ \t]*$',
    re.MULTILINE,
)
matches = pattern.findall(src)
if len(matches) != 1:
    raise SystemExit(f'expected exactly 1 legacy static location block, found {len(matches)}')

replacement = (
    'location / {\n'
    '    proxy_pass http://10.88.0.1:18081;\n'
    '    proxy_http_version 1.1;\n'
    '    proxy_set_header Host onev-ui.onemt.co;\n'
    '    proxy_set_header X-Forwarded-For $remote_addr;\n'
    '    proxy_set_header X-Real-IP $remote_addr;\n'
    '    proxy_set_header Forwarded "";\n'
    '    proxy_set_header CF-Connecting-IP "";\n'
    '    proxy_set_header True-Client-IP "";\n'
    '    proxy_set_header Connection "";\n'
    '    proxy_buffering off;\n'
    '    proxy_cache off;\n'
    '    proxy_read_timeout 1h;\n'
    '}'
)


def indent(match):
    pad = match.group('indent')
    return '\n'.join(pad + line for line in replacement.split('\n'))


new = pattern.sub(indent, src, count=1)
if new.count('proxy_pass http://10.88.0.1:18081;') != 1:
    raise SystemExit('replacement sanity check failed')
if pattern.search(new):
    raise SystemExit('legacy static location block still present after replacement')
with open(out_path, 'w', encoding='utf-8', newline='') as fh:
    fh.write(new)
print('legacy static location block replaced exactly once')
PY

ARMED=1
# 原地更新内容，保留原 inode、属主、权限及 ACL/xattr。
cat "$STAGE/onev-ui.conf.new" > "$TARGET" \
  || fail 'could not write new config'
cmp -s "$STAGE/onev-ui.conf.new" "$TARGET" || fail 'installed config differs from generated config'
[ "$(stat -c '%U:%G:%a' "$TARGET")" = 'root:root:644' ] \
  || fail 'unexpected target ownership/permissions (want root:root:644)'
grep -Fq 'proxy_pass http://10.88.0.1:18081;' "$TARGET" \
  || fail 'new config missing proxy_pass'
grep -Fq 'proxy_set_header X-Forwarded-For $remote_addr;' "$TARGET" \
  || fail 'new config missing XFF override'
grep -Fq 'proxy_set_header Host onev-ui.onemt.co;' "$TARGET" \
  || fail 'new config missing fixed Host'
echo 'new config installed as root:root 0644'

podman exec "$CONTAINER" nginx -t || fail 'container nginx -t failed after switch'
podman exec "$CONTAINER" nginx -s reload || fail 'container nginx -s reload failed'
echo 'container nginx -t OK and reloaded (no restart)'

echo
echo '===== VERIFY (HTTPS, default cert verification, no -k) ====='
CURL_BASE=(curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 30 \
  --resolve "${SITE_NAME}:443:127.0.0.1")
BASE_URL="https://${SITE_NAME}"

local_sha="$(sha256sum "$FRONTEND_INDEX" | awk '{print $1}')"
matched=0
# reload 平滑更换 worker 是异步的，允许旧 worker 在短窗口内退出。
for attempt in {1..15}; do
  code="$("${CURL_BASE[@]}" --output "$STAGE/index.html" --write-out '%{http_code}' \
    "$BASE_URL/index.html")" || fail 'HTTPS /index.html request failed (including certificate validation)'
  remote_sha="$(sha256sum "$STAGE/index.html" | awk '{print $1}')"
  if [ "$code" = '200' ] && [ "$remote_sha" = "$local_sha" ]; then
    matched=1
    break
  fi
  sleep 1
done
[ "$matched" -eq 1 ] || fail 'HTTPS index did not converge to new frontend; restoring old site'
echo "HTTPS /index.html 200; sha256 matches $FRONTEND_INDEX"

for path in /health /readyz; do
  code="$("${CURL_BASE[@]}" --output /dev/null --write-out '%{http_code}' \
    "$BASE_URL$path")" || fail "HTTPS $path request failed"
  [ "$code" = '200' ] || fail "HTTPS $path returned $code (expected 200)"
  echo "HTTPS $path 200"
done

code="$("${CURL_BASE[@]}" -H "X-Forwarded-For: $INJECT_XFF" \
  --output "$STAGE/access.json" --write-out '%{http_code}' \
  "$BASE_URL$ACCESS_PATH")" || fail 'HTTPS access request failed'
[ "$code" = '200' ] || fail "HTTPS $ACCESS_PATH returned $code (expected 200)"
python3 - "$STAGE/access.json" <<'PY'
import json
import sys

with open(sys.argv[1], 'rb') as fh:
    value = json.load(fh)
if (
    not isinstance(value, dict)
    or set(value) != {'canBind'}
    or type(value.get('canBind')) is not bool
    or value['canBind'] is not False
):
    raise SystemExit(f'unexpected access projection: {value!r}')
print('access projection {"canBind": false} as expected')
PY
echo "edge override proven: injected X-Forwarded-For $INJECT_XFF was replaced by \$remote_addr"

ARMED=0
echo
echo '===== SUMMARY ====='
echo "switched location : $TARGET (root:root 0644)"
echo "proxy_pass        : http://${RELAY_ADDR}:${RELAY_PORT} (no trailing slash)"
echo "backup dir        : $BACKUP_DIR (0700; config and old static tar 0600)"
echo 'NOTE: local loopback curl may be recorded by the container as 127.0.0.1; default role stays user (canBind=false) either way.'
echo 'NOTE: from a real Mac client IP, HTTPS should return canBind=true; forging X-Forwarded-For cannot change the actual role (edge overrides it).'
echo 'NOT DONE (by design): no service enable, no container restart, no git, no install, no download, no sync, no DWS smoke.'
echo 'HTTPS_SITE_SWITCHED'
