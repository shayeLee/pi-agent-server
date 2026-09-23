#!/usr/bin/env bash
# 只读：现有 ONEV TLS 配置指令摘要、备份容量、DWS 登录帮助。
set -euo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'Run as root'; exit 1; }
echo '===== EXISTING TLS SITE DIRECTIVES ====='
python3 - <<'PY'
import re
from pathlib import Path
p = Path('/data/www/nginx/conf.d/onev-ui.conf')
print(p)
# 不打印任意环境、认证头或证书内容；仅白名单配置指令。
allowed = re.compile(r'^\s*(server\s*\{|\}|(?:listen|server_name|location|root|alias|index|try_files|ssl_certificate|ssl_certificate_key|include|allow|deny|auth_basic|auth_basic_user_file|real_ip_header|real_ip_recursive|set_real_ip_from|proxy_pass)\s)')
for n, line in enumerate(p.read_text().splitlines(), 1):
    if allowed.match(line):
        print(f'{n}: {line}')
PY
echo '===== NGINX VERSIONS ====='
nginx -v
timeout 20s podman exec onemt-nginx nginx -v
echo '===== RELAY PORT ====='
ss -lntp 'sport = :18081'
echo '===== CURRENT STATIC SITE ====='
ls -ld /data/www/nginx/html/onev-ui
timeout 20s du -sh /data/www/nginx/html/onev-ui || true
echo '===== SERVICE ACCOUNT DWS LOGIN HELP ====='
runuser -u onev -- env HOME=/home/onev PATH=/home/onev/.volta/bin:/usr/local/bin:/usr/bin:/bin \
  timeout 20s bash -c 'cd /srv/onev; dws --format json auth login --help'
echo 'SITE_CONFIG_CHECK_COMPLETE'
