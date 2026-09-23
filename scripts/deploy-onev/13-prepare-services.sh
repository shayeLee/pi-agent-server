#!/usr/bin/env bash
# ONEV 裸机部署：阶段 13，只准备 systemd/env/policy/publisher 文件。
# 不启动、不 enable、不 daemon-reload、不碰 nginx、不 git、不下载。
# 内容依据 docs/onev-bare-metal-deployment.md §6/§7；publisher.mjs 与本脚本同目录，
# 由 §6.2 源码原样抽取（不在此脚本内重写）。

set -euo pipefail
exec 2>&1

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

ONEV_HOME=/home/onev
VOLTA_HOME="$ONEV_HOME/.volta"
VOLTA_BIN="$VOLTA_HOME/bin/volta"
COMMON_PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin"
NODE_VERSION=22.22.3

HOST_DIR=/srv/pi-agent-server
PLUGIN_DIR=/srv/pi-agent-capability-onev
FRONTEND_DIR=/srv/onev
HOST_DATA=/data/onev/pi-agent-server
PLUGIN_DATA=/data/onev/pi-agent-capability-onev
PUBLISHER_DIR=/srv/onev-publisher
RELEASES_DIR=/data/onev/onev-ui-releases
ENV_FILE=/etc/pi-agent-server/onev.env
POLICY_FILE="$HOST_DATA/ip-access-policy.json"
HOST_UNIT=/etc/systemd/system/pi-agent-server.service
PUBLISHER_UNIT=/etc/systemd/system/onev-publisher.service
BACKUP_ROOT=/data/onev-backups

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER_SRC="$SCRIPT_DIR/publisher.mjs"

DEFAULT_MODEL="${ONEV_DEPLOY_DEFAULT_MODEL:-openai-codex/gpt-5.6-luna}"
if [ -z "$DEFAULT_MODEL" ] || ! printf '%s' "$DEFAULT_MODEL" | grep -Eq '^[A-Za-z0-9._/-]+$'; then
  echo 'ERROR: ONEV_DEPLOY_DEFAULT_MODEL 必须是单行 provider/modelId（仅字母数字._/-）' >&2
  exit 1
fi

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

echo '===== PREFLIGHT (READ ONLY) ====='
# /data 必须是独立挂载点，避免把生产数据写进根分区。
mountpoint -q /data || fail '/data is not a mountpoint'
df -h / /data

id onev >/dev/null 2>&1 || fail 'service user onev does not exist'
[ -d "$HOST_DATA" ] || fail "missing data dir: $HOST_DATA"
[ -d "$PLUGIN_DATA" ] || fail "missing data dir: $PLUGIN_DATA"
[ -r "$HOST_DIR/dist/main.js" ] || fail "missing entry: $HOST_DIR/dist/main.js"
[ -r "$PLUGIN_DIR/dist/index.js" ] || fail "missing plugin entry: $PLUGIN_DIR/dist/index.js"
[ -x /usr/local/bin/dws ] || fail 'missing executable: /usr/local/bin/dws'
[ -x "$VOLTA_BIN" ] || fail "missing volta: $VOLTA_BIN"
[ -r "$PUBLISHER_SRC" ] || fail "missing publisher source: $PUBLISHER_SRC"
[ -d "$FRONTEND_DIR" ] || fail "missing frontend dir: $FRONTEND_DIR"
[ -s "$FRONTEND_DIR/examples/onev-ui/index.html" ] || fail 'build:docs output is required before preparing releases'
install -d -o onev -g onev -m 0750 "$PUBLISHER_DIR"

# 模型凭证：只做 stat / 可读性判定，绝不读取或打印内容。
for file in "$ONEV_HOME/.pi/agent/auth.json" "$ONEV_HOME/.pi/agent/models.json"; do
  [ -e "$file" ] || fail "missing model config file: $file"
  [ ! -L "$file" ] || fail "model config file must not be a symlink: $file"
  stat -c 'MODEL_FILE %F mode=%a owner=%U:%G size=%s %n' -- "$file"
done
runuser -u onev -- test -r "$ONEV_HOME/.pi/agent/auth.json" || fail 'auth.json not readable by onev'
runuser -u onev -- test -r "$ONEV_HOME/.pi/agent/models.json" || fail 'models.json not readable by onev'
for file in "$ONEV_HOME/.pi/agent/auth.json" "$ONEV_HOME/.pi/agent/models.json"; do
  [ -f "$file" ] || fail "model config must be a regular file: $file"
  [ "$(stat -c '%a:%U' -- "$file")" = '600:onev' ] \
    || fail "model config must be mode 600 owned by onev: $file"
done

# 拒绝覆盖运行中的同名服务配置。
for unit in pi-agent-server onev-publisher; do
  if systemctl is-active --quiet "$unit"; then
    fail "$unit.service is active; refusing to overwrite a running service configuration"
  fi
done
echo 'PREFLIGHT_OK'

echo
echo '===== INITIAL RELEASE ====='
# /data/onev 只给 nginx 穿越权，不开放目录列表；业务数据库子目录权限不变。
chmod 0751 /data/onev
install -d -o onev -g onev -m 0755 "$RELEASES_DIR"
if [ ! -e "$RELEASES_DIR/current" ]; then
  initial="initial-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -o onev -g onev -m 0755 "$RELEASES_DIR/$initial"
  cp -a "$FRONTEND_DIR/examples/onev-ui/." "$RELEASES_DIR/$initial/"
  chown -R onev:onev "$RELEASES_DIR/$initial"
  find "$RELEASES_DIR/$initial" -type d -exec chmod go-w,o+rx {} +
  find "$RELEASES_DIR/$initial" -type f -exec chmod go-w,o+r {} +
  runuser -u onev -- ln -s "$initial" "$RELEASES_DIR/current"
fi
[ -L "$RELEASES_DIR/current" ] || fail 'release current must be a symlink'
python3 - "$RELEASES_DIR" <<'PY'
import os,sys
root=sys.argv[1]; current=os.path.join(root,'current'); target=os.readlink(current)
if target in ('.','..') or os.path.isabs(target) or '/' in target:
    raise SystemExit('current target must be one release name')
lexical=os.path.join(root,target)
if os.path.islink(lexical) or not os.path.isdir(lexical):
    raise SystemExit('current target must be a real directory')
index=os.path.join(lexical,'index.html')
if os.path.islink(index) or not os.path.isfile(index) or os.path.getsize(index)==0:
    raise SystemExit('current index missing or invalid')
PY
runuser -u onev -- test -r "$RELEASES_DIR/current/index.html" || fail 'initial release is not readable'
echo "current release: $(readlink "$RELEASES_DIR/current")"

echo
echo '===== BACKUP OLD CONFIG (IF ANY) ====='
install -d -o root -g root -m 0700 "$BACKUP_ROOT"
BACKUP_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -o root -g root -m 0700 "$BACKUP_DIR"
for path in "$ENV_FILE" "$POLICY_FILE" "$HOST_UNIT" "$PUBLISHER_UNIT" "$PUBLISHER_DIR/publisher.mjs"; do
  if [ -e "$path" ]; then
    cp -a -- "$path" "$BACKUP_DIR/"
    echo "backed up: $path"
  fi
done
ls -la "$BACKUP_DIR"
echo "BACKUP_DIR=$BACKUP_DIR"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo
echo '===== WRITE ENV (/etc/pi-agent-server/onev.env) ====='
cat > "$STAGE/onev.env" <<EOF
# ONEV 生产环境（阶段 13 生成；不要提交到 Git，不要写入 unit）。
HOST=127.0.0.1
PORT=18080
AGENT_CWD=$FRONTEND_DIR
DATA_DIR=$HOST_DATA
DB_PATH=$HOST_DATA/pi-agent-server.db
# 准入网段：本机直连/探针 + 已确认内网段。不使用 0.0.0.0/0。
PI_ALLOWED_CLIENT_CIDRS=127.0.0.0/8,192.168.0.0/16,10.0.0.0/8
PI_IP_ACCESS_POLICY_FILE=$POLICY_FILE
PI_MIGRATION_GATE=verify
PI_DATA_MODE=managed
PI_DEFAULT_MODEL=$DEFAULT_MODEL
PI_DEFAULT_THINKING_LEVEL=medium
# Pi 资源目录：auth.json/models.json 已由操作人准备，本脚本只读校验、不复制不改写。
PI_AGENT_DIR=$ONEV_HOME/.pi/agent
PI_AUTH_PATH=$ONEV_HOME/.pi/agent/auth.json
# 裸机用插件构建产物的绝对路径入口（不依赖宿主 node_modules）。
PI_PLUGINS=$PLUGIN_DIR/dist/index.js
# 插件独立数据目录与 DWS。
ONEV_DATA_DIR=$PLUGIN_DATA
ONEV_DWS_ENABLED=true
ONEV_DWS_BIN=/usr/local/bin/dws
# 文档站发布：publisher 构建并原子切换成功后返回 200，插件才完成 job（§6）。
ONEV_PUBLICATION_WEBHOOK_URL=http://127.0.0.1:9091/publish
ONEV_PUBLICATION_WEBHOOK_TIMEOUT_MS=4500000
EOF
install -o root -g onev -m 0640 "$STAGE/onev.env" "$ENV_FILE"

echo
echo '===== WRITE IP POLICY (onev:onev 0600) ====='
cat > "$STAGE/ip-access-policy.json" <<'EOF'
{
  "version": 1,
  "ips": [
    { "ip": "192.168.6.23", "role": "admin" },
    { "ip": "192.168.2.55", "role": "admin" }
  ]
}
EOF
install -o onev -g onev -m 0600 "$STAGE/ip-access-policy.json" "$POLICY_FILE"

echo
echo '===== WRITE SYSTEMD UNITS ====='
cat > "$STAGE/pi-agent-server.service" <<EOF
[Unit]
Description=pi-agent-server with ONEV capability
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=onev
Group=onev
WorkingDirectory=$FRONTEND_DIR
Environment=HOME=$ONEV_HOME
Environment=VOLTA_HOME=$VOLTA_HOME
Environment=PATH=$COMMON_PATH
Environment=TMPDIR=$ONEV_HOME/tmp
EnvironmentFile=$ENV_FILE
ExecStart=$VOLTA_BIN run --node $NODE_VERSION -- node $HOST_DIR/dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$STAGE/pi-agent-server.service" "$HOST_UNIT"

cat > "$STAGE/onev-publisher.service" <<EOF
[Unit]
Description=ONEV docs static-site publisher (loopback HTTP -> build:docs)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=onev
Group=onev
WorkingDirectory=$PUBLISHER_DIR
Environment=HOME=$ONEV_HOME
Environment=VOLTA_HOME=$VOLTA_HOME
Environment=PATH=$COMMON_PATH
Environment=TMPDIR=$ONEV_HOME/tmp
# 直接管理 Node，使 KillMode=mixed 的 SIGTERM 到达 publisher，而非 Volta 包装进程。
ExecStart=$VOLTA_HOME/tools/image/node/$NODE_VERSION/bin/node $PUBLISHER_DIR/publisher.mjs
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=75min
NoNewPrivileges=true
PrivateTmp=true
UMask=0022

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$STAGE/onev-publisher.service" "$PUBLISHER_UNIT"

echo
echo '===== INSTALL PUBLISHER (syntax check first) ====='
runuser -u onev -- env \
  HOME="$ONEV_HOME" \
  VOLTA_HOME="$VOLTA_HOME" \
  PATH="$COMMON_PATH" \
  TMPDIR="$ONEV_HOME/tmp" \
  "$VOLTA_BIN" run --node "$NODE_VERSION" -- node --check "$PUBLISHER_SRC"
install -o onev -g onev -m 0640 "$PUBLISHER_SRC" "$PUBLISHER_DIR/publisher.mjs"

echo
echo '===== VERIFY (static; no daemon-reload / enable / start) ====='
ls -l "$ENV_FILE" "$POLICY_FILE" "$HOST_UNIT" "$PUBLISHER_UNIT" "$PUBLISHER_DIR/publisher.mjs"
stat -c '%a %U:%G %n' "$ENV_FILE" "$POLICY_FILE" "$HOST_UNIT" "$PUBLISHER_UNIT" "$PUBLISHER_DIR/publisher.mjs"
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$HOST_UNIT" "$PUBLISHER_UNIT"
fi

echo
echo '===== PREPARED CONFIG SUMMARY ====='
echo "env file            : $ENV_FILE (root:onev 0640)"
echo "ip policy           : $POLICY_FILE (onev:onev 0600, version 1, admin 192.168.6.23 + 192.168.2.55)"
echo "host unit           : $HOST_UNIT (User=onev, node $NODE_VERSION, $HOST_DIR/dist/main.js, UMask=0077)"
echo "publisher unit      : $PUBLISHER_UNIT (User=onev, UMask=0022, KillMode=mixed, TimeoutStopSec=75min)"
echo "publisher script    : $PUBLISHER_DIR/publisher.mjs (onev:onev 0640)"
echo "listen              : 127.0.0.1:18080 (agent-server) / 127.0.0.1:9091 (publisher)"
echo "backup dir          : $BACKUP_DIR"
echo 'NOT DONE (by design): no daemon-reload, no enable, no start, no nginx change, no git.'

echo
echo '===== PENDING ACCEPTANCE (NOT VERIFIED BY THIS SCRIPT) ====='
echo "1. default model: PI_DEFAULT_MODEL=$DEFAULT_MODEL / thinking=medium; models.json 中的 Modelscope 配置未读取校验，需服务启动后确认可解析。"
echo '2. DWS: 未执行 auth 校验/登录；需确认服务账号 onev 可用 /usr/local/bin/dws（ONEV_DWS_ENABLED=true）。'
echo '3. 启动与探针：systemctl daemon-reload && systemctl enable --now pi-agent-server.service，然后 curl http://127.0.0.1:18080/health 与 /readyz。'
echo '4. 先准备 /data/onev/onev-ui-releases/current，再启动 publisher；POST /publish 会等待构建和原子切换，200 才表示发布成功。'
echo '5. nginx 同源反代 /v1、/health、/readyz 到 127.0.0.1:18080 由阶段 11/12 与操作人另行处理。'
echo 'PREPARE_SERVICES_COMPLETE'
