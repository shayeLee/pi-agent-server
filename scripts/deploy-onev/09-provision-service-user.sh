#!/usr/bin/env bash
# ONEV 裸机部署：阶段 9，创建服务账号、目录及独立 Node 工具链。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

ONEV_HOME=/home/onev
VOLTA_HOME="$ONEV_HOME/.volta"

echo '===== SERVICE USER ====='
if ! id onev >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$ONEV_HOME" --shell /usr/sbin/nologin onev
fi
id onev
# 宿主 backup staging policy 要求 HOME/TMPDIR 全链不经过共享 sticky 目录。
install -d -o onev -g onev -m 0700 "$ONEV_HOME" "$ONEV_HOME/tmp"

echo
echo '===== DIRECTORIES ====='
install -d -o onev -g onev -m 0755 \
  /srv/pi-agent-server \
  /srv/pi-agent-capability-onev \
  /srv/onev
install -d -o onev -g onev -m 0750 \
  /data/onev \
  /data/onev/pi-agent-server \
  /data/onev/pi-agent-capability-onev \
  /srv/onev-publisher
install -d -o onev -g onev -m 0700 \
  /data/onev/pi-agent-server/pi-agent
install -d -o root -g onev -m 0750 /etc/pi-agent-server

# 服务账号需要构建源码，并在同步时写入 onev docs/assets。
chown -R onev:onev \
  /srv/pi-agent-server \
  /srv/pi-agent-capability-onev \
  /srv/onev

echo
echo '===== VOLTA FOR SERVICE USER ====='
if [ ! -x "$VOLTA_HOME/bin/volta" ]; then
  runuser -u onev -- env HOME="$ONEV_HOME" bash -c \
    'curl --proto "=https" --tlsv1.2 -fsSL https://get.volta.sh | bash -s -- --skip-setup'
fi

test -x "$VOLTA_HOME/bin/volta"
runuser -u onev -- env HOME="$ONEV_HOME" VOLTA_HOME="$VOLTA_HOME" PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
  "$VOLTA_HOME/bin/volta" install node@16.20.2
runuser -u onev -- env HOME="$ONEV_HOME" VOLTA_HOME="$VOLTA_HOME" PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
  "$VOLTA_HOME/bin/volta" install node@22.22.3 pnpm@9.1.4 yarn@1.22.22

echo
echo '===== DWS ====='
DWS_VERSION='1.0.39'
DWS_ARCHIVE='dws-linux-amd64.tar.gz'
DWS_SHA256='cc23c944c6811f80181780dd7dfe19f21a7b27bb36a43b0607f6c12dc2eb928c'
dws_tmp="$(mktemp -d)"
trap 'rm -rf "$dws_tmp"' EXIT
curl --proto '=https' --tlsv1.2 -fsSL \
  "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v${DWS_VERSION}/${DWS_ARCHIVE}" \
  -o "$dws_tmp/$DWS_ARCHIVE"
printf '%s  %s\n' "$DWS_SHA256" "$dws_tmp/$DWS_ARCHIVE" | sha256sum -c -
tar -C "$dws_tmp" -xzf "$dws_tmp/$DWS_ARCHIVE"
dws_source="$(find "$dws_tmp" -type f -name dws -print -quit)"
if [ -z "$dws_source" ]; then
  echo 'ERROR: official DWS archive does not contain dws' >&2
  exit 1
fi
install -o root -g root -m 0755 "$dws_source" /usr/local/bin/dws
/usr/local/bin/dws --version
if [ -d /root/.dws ]; then
  rm -rf "$ONEV_HOME/.dws"
  cp -a /root/.dws "$ONEV_HOME/.dws"
  chown -R onev:onev "$ONEV_HOME/.dws"
  chmod 0700 "$ONEV_HOME/.dws"
fi

echo
echo '===== VERIFY ====='
runuser -u onev -- env HOME="$ONEV_HOME" VOLTA_HOME="$VOLTA_HOME" PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin" bash -c '
  cd /srv/onev
  echo "node=$(volta run --node 22.22.3 -- node --version)"
  echo "pnpm=$(pnpm --version)"
  echo "yarn=$(volta run --node 16.20.2 --yarn 1.22.22 -- yarn --version)"
  echo "volta=$(volta --version)"
  echo "dws=$(command -v dws)"
'
ls -ld \
  /srv/pi-agent-server \
  /srv/pi-agent-capability-onev \
  /srv/onev \
  /data/onev \
  /data/onev/pi-agent-server \
  /data/onev/pi-agent-capability-onev \
  /etc/pi-agent-server

df -h /
echo 'PROVISION_COMPLETE'
