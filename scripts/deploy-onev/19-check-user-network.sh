#!/usr/bin/env bash
# 只读网络诊断：不修改 sing-box/路由/防火墙，不显示代理密码或配置文件。
set -uo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'Run as root'; exit 1; }
echo '===== USER IDS ====='
id root
id onev
echo '===== PROXY VARIABLE NAMES ONLY (CURRENT PROCESS) ====='
python3 - <<'PY'
import os
names = ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy')
for n in names:
    print(f'{n}: {"set" if os.environ.get(n) else "unset"}')
PY
echo '===== POLICY ROUTING ====='
ip -4 rule show
ip -6 rule show
echo '===== INTERFACES ====='
ip -brief address show
echo '===== SING-BOX STATUS METADATA ====='
systemctl show sing-box.service --property=ActiveState,SubState,User,MainPID --no-pager
CURL=$(command -v curl) || exit 1
# --noproxy 不绕过透明 TUN，仅排除显式 HTTP/SOCKS 代理变量的影响。
for user in root onev; do
  echo "===== CLEAN ENV NETWORK PROBE: $user ====="
  if [[ "$user" = root ]]; then home=/root; else home=/home/onev; fi
  runuser -u "$user" -- env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c 'cd /; exec "$1" --noproxy "*" --connect-timeout 5 --max-time 15 -sS -o /dev/null -w "HTTP=%{http_code} remote_ip=%{remote_ip} total=%{time_total}s\n" https://github.com/' bash "$CURL"
  echo "probe_exit=$?"
done
echo 'NOTE: identical probes test system networking only; model endpoint/systemd namespace may still differ.'
echo 'USER_NETWORK_CHECK_COMPLETE'
