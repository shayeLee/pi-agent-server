#!/usr/bin/env bash
# 阶段 20：把同步成功语义升级为“站点构建并原子发布成功”。
# 前提：三个仓库的新代码已部署并构建；本脚本不 git、不安装依赖、不触发文档构建。
set -euo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'ERROR: run as root'; exit 1; }

PUBLISHER_SRC="$(cd "$(dirname "$0")" && pwd)/publisher.mjs"
PUBLISHER_DST=/srv/onev-publisher/publisher.mjs
ENV_FILE=/etc/pi-agent-server/onev.env
RELAY_CONF=/etc/nginx/conf.d/onev-agent-relay.conf
RELEASES=/data/onev/onev-ui-releases
CURRENT="$RELEASES/current"
OLD_SITE=/srv/onev/examples/onev-ui
BACKUP_ROOT=/data/onev-backups
STAGE=''
BACKUP=''
ARMED=0
HOST_WAS_ACTIVE=0
PUB_WAS_ACTIVE=0
PARENT_MODE=''
RELEASES_CREATED=0
CURRENT_CREATED=0
INITIAL_CREATED=''
CONTAINER_PID=''

fail(){ echo "ERROR: $*" >&2; exit 1; }
reload_nginx(){ systemctl reload nginx >/dev/null 2>&1 || nginx -s reload; }
on_exit(){
  rc=$?; trap - EXIT; set +e
  if [[ $rc -ne 0 && $ARMED -eq 1 ]]; then
    echo "ROLLBACK: restoring configuration from $BACKUP" >&2
    systemctl stop pi-agent-server.service onev-publisher.service >/dev/null 2>&1 || true
    cp --preserve=all -- "$BACKUP/onev.env" "$ENV_FILE" || echo 'ROLLBACK FAILED: environment' >&2
    cp --preserve=all -- "$BACKUP/onev-agent-relay.conf" "$RELAY_CONF" || echo 'ROLLBACK FAILED: relay config' >&2
    cp --preserve=all -- "$BACKUP/publisher.mjs" "$PUBLISHER_DST" || echo 'ROLLBACK FAILED: publisher' >&2
    if nginx -t; then reload_nginx || echo 'ROLLBACK FAILED: nginx reload' >&2; fi
    if [[ $RELEASES_CREATED -eq 1 ]]; then
      rm -rf -- "$RELEASES" || echo 'ROLLBACK FAILED: new releases root cleanup' >&2
    else
      [[ $CURRENT_CREATED -eq 1 ]] && rm -f -- "$CURRENT" || true
      [[ -n "$INITIAL_CREATED" ]] && rm -rf -- "$RELEASES/$INITIAL_CREATED" || true
    fi
    [[ -n "$PARENT_MODE" ]] && chmod "$PARENT_MODE" /data/onev || echo 'ROLLBACK FAILED: /data/onev mode' >&2
    systemctl daemon-reload || true
    [[ $PUB_WAS_ACTIVE -eq 1 ]] && systemctl start onev-publisher.service || true
    [[ $HOST_WAS_ACTIVE -eq 1 ]] && systemctl start pi-agent-server.service || true
  fi
  [[ -n "$STAGE" ]] && rm -rf "$STAGE"
  exit "$rc"
}
trap on_exit EXIT
STAGE=$(mktemp -d)

for c in curl python3 install cp find readlink sha256sum runuser nginx systemctl mountpoint podman nsenter; do
  command -v "$c" >/dev/null || fail "missing command: $c"
done
mountpoint -q /data || fail '/data is not a mountpoint'
[[ -f "$PUBLISHER_SRC" && ! -L "$PUBLISHER_SRC" ]] || fail 'publisher source missing or symlink'
[[ -f "$PUBLISHER_DST" && ! -L "$PUBLISHER_DST" ]] || fail 'installed publisher missing or symlink'
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'environment file missing or symlink'
[[ -f "$RELAY_CONF" && ! -L "$RELAY_CONF" ]] || fail 'relay config missing or symlink'
[[ -s "$OLD_SITE/index.html" ]] || fail 'existing built site is unavailable'
[[ "$(stat -c '%U:%G:%a' "$ENV_FILE")" = root:onev:640 ]] || fail 'unexpected environment permissions'
[[ "$(stat -c '%U:%G:%a' "$RELAY_CONF")" = root:root:644 ]] || fail 'unexpected relay config permissions'
rg_bin=$(command -v rg || true)
if [[ -n "$rg_bin" ]]; then
  "$rg_bin" -q 'DOCS_OUTPUT_PATH' /srv/onev/build/webpack.demo.js || fail 'new frontend build config is not deployed'
  "$rg_bin" -q '4_500_000' /srv/pi-agent-capability-onev/dist/publication/webhook.js || fail 'new plugin dist is not deployed'
else
  grep -q 'DOCS_OUTPUT_PATH' /srv/onev/build/webpack.demo.js || fail 'new frontend build config is not deployed'
  grep -q '4_500_000' /srv/pi-agent-capability-onev/dist/publication/webhook.js || fail 'new plugin dist is not deployed'
fi
systemctl is-active --quiet pi-agent-server.service && HOST_WAS_ACTIVE=1
systemctl is-active --quiet onev-publisher.service && PUB_WAS_ACTIVE=1
[[ $HOST_WAS_ACTIVE -eq 1 && $PUB_WAS_ACTIVE -eq 1 ]] || fail 'host and publisher must be active before migration'
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:18080/readyz >/dev/null
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:9091/healthz > "$STAGE/health.json"
python3 - "$STAGE/health.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1]))
assert v.get('building') is False and v.get('pending') is False and v.get('debouncePending', False) is False
assert v.get('shuttingDown') is False
PY
nginx -t
runuser -u www-data -- test -r "$OLD_SITE/index.html" || fail 'www-data cannot read existing site'
CONTAINER_PID=$(podman inspect -f '{{.State.Pid}}' onemt-nginx) || fail 'cannot inspect onemt-nginx'
[[ "$CONTAINER_PID" =~ ^[1-9][0-9]*$ ]] || fail 'invalid onemt-nginx pid'
PARENT_MODE=$(stat -c '%a' /data/onev)

# publisher 空闲不等于插件无在途同步；操作人须先协调无人发起新同步的维护窗口。
check_sync_idle() {
  [[ -x /home/onev/.volta/tools/image/node/22.22.3/bin/node ]] || fail 'pinned Node missing'
  env HOME=/home/onev VOLTA_HOME=/home/onev/.volta \
    /home/onev/.volta/bin/volta run --node 22.22.3 -- node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/onev/pi-agent-capability-onev/onev.db", { readOnly: true });
try {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE status IN (?, ?)").get("pending", "running");
  if (!row || row.n !== 0) throw new Error("active sync jobs; retry in an idle maintenance window");
} finally { db.close(); }
' || fail 'sync jobs idle check failed'
}
check_sync_idle

echo '===== BACKUP ====='
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
BACKUP=$(mktemp -d "$BACKUP_ROOT/atomic-publication-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 0700 "$BACKUP"
cp --preserve=all -- "$ENV_FILE" "$BACKUP/onev.env"
cp --preserve=all -- "$RELAY_CONF" "$BACKUP/onev-agent-relay.conf"
cp --preserve=all -- "$PUBLISHER_DST" "$BACKUP/publisher.mjs"
echo "BACKUP_DIR=$BACKUP"
ARMED=1

# 先停止 writer；旧 publisher 当前空闲，直接 Node 主进程可正常 TERM 退出。
systemctl stop pi-agent-server.service
systemctl stop onev-publisher.service
check_sync_idle

# /data/onev 的其它业务目录仍保持私有；这里只增加“可穿越但不可列目录”的 other +x。
chmod 0751 /data/onev
if [[ ! -e "$RELEASES" ]]; then
  install -d -o onev -g onev -m 0755 "$RELEASES"
  RELEASES_CREATED=1
elif [[ ! -d "$RELEASES" || -L "$RELEASES" ]]; then
  fail "$RELEASES must be a real directory"
fi
[[ "$(stat -c '%U:%G:%a' "$RELEASES")" = onev:onev:755 ]] || fail 'unexpected releases ownership/mode'
if [[ ! -e "$CURRENT" ]]; then
  initial="initial-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir "$RELEASES/$initial"
  INITIAL_CREATED="$initial"
  cp -a "$OLD_SITE/." "$RELEASES/$initial/"
  chown -R onev:onev "$RELEASES/$initial"
  find "$RELEASES/$initial" -type d -exec chmod go-w,o+rx {} +
  find "$RELEASES/$initial" -type f -exec chmod go-w,o+r {} +
  runuser -u onev -- ln -s "$initial" "$CURRENT"
  CURRENT_CREATED=1
else
  [[ -L "$CURRENT" ]] || fail 'current exists but is not a symlink'
fi
python3 - "$RELEASES" "$CURRENT" <<'PY'
import os,sys
root_arg,current_arg=sys.argv[1:]
target=os.readlink(current_arg)
if target in ('.','..') or os.path.isabs(target) or '/' in target:
    raise SystemExit('current target must be one release name')
lexical=os.path.join(root_arg,target)
if os.path.islink(lexical) or not os.path.isdir(lexical):
    raise SystemExit('current target must be a real directory')
root,current=map(os.path.realpath, (root_arg,current_arg))
if os.path.commonpath((root,current)) != root or current == root:
    raise SystemExit('current escapes releases directory')
index=os.path.join(current,'index.html')
if os.path.islink(index) or not os.path.isfile(index) or os.path.getsize(index)==0:
    raise SystemExit('current index missing or invalid')
PY
runuser -u www-data -- test -r "$CURRENT/index.html" || fail 'www-data cannot read current release'

install -o onev -g onev -m 0640 "$PUBLISHER_SRC" "$PUBLISHER_DST"
# 精确追加或替换长轮询超时，不输出环境文件内容。
python3 - "$ENV_FILE" "$STAGE/onev.env" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); lines=p.read_text().splitlines(); key='ONEV_PUBLICATION_WEBHOOK_TIMEOUT_MS='
found=[i for i,x in enumerate(lines) if x.startswith(key)]
if len(found)>1: raise SystemExit('duplicate webhook timeout setting')
if found: lines[found[0]]=key+'4500000'
else: lines.append(key+'4500000')
Path(sys.argv[2]).write_text('\n'.join(lines)+'\n')
PY
install -o root -g onev -m 0640 "$STAGE/onev.env" "$ENV_FILE"

python3 - "$RELAY_CONF" "$STAGE/relay.conf" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old='    root  /srv/onev/examples/onev-ui;'
new='    root  /data/onev/onev-ui-releases/current;'
if s.count(old)!=1: raise SystemExit(f'expected one old relay root, found {s.count(old)}')
Path(sys.argv[2]).write_text(s.replace(old,new))
PY
# 原地写入，保持宿主 nginx 已打开配置 bind/inode 语义及元数据。
cat "$STAGE/relay.conf" > "$RELAY_CONF"
[[ "$(stat -c '%U:%G:%a' "$RELAY_CONF")" = root:root:644 ]] || fail 'relay metadata changed'
nginx -t
reload_nginx

systemctl start onev-publisher.service
for _ in {1..30}; do
  curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:9091/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:9091/healthz
systemctl start pi-agent-server.service
for _ in {1..30}; do
  curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:18080/readyz >/dev/null 2>&1 && break
  sleep 1
done
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:18080/readyz

expected=$(sha256sum "$CURRENT/index.html" | awk '{print $1}')
served=$(nsenter --target "$CONTAINER_PID" --net -- curl --noproxy '*' -fsS --max-time 20 \
  -H 'Host: onev-ui.onemt.co' -H 'X-Forwarded-For: 192.168.6.23' \
  http://10.88.0.1:18081/index.html | sha256sum | awk '{print $1}')
[[ "$expected" = "$served" ]] || fail 'relay does not serve current release'
ARMED=0
echo
echo "current release: $(readlink "$CURRENT")"
echo "backup dir: $BACKUP"
echo 'ATOMIC_PUBLICATION_ENABLED'
