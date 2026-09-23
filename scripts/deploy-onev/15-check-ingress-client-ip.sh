#!/usr/bin/env bash
# 只读查找指定无敏感信息的部署探针；不输出其它用户请求。
set -euo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'Run as root'; exit 1; }
echo '===== HTTPS INGRESS PROBE ====='
python3 - <<'PY'
from pathlib import Path
import ipaddress
marker = b'onev-deploy-ip-check-20260922'
found = False
root = Path('/data/www/nginx/logs')
for p in sorted(root.rglob('*.log')):
    if not p.is_file() or p.is_symlink():
        continue
    with p.open('rb') as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 262144))
        lines = f.read().splitlines()
    for line in lines:
        if marker not in line:
            continue
        found = True
        # nginx combined 日志首列通常为 remote_addr；不输出完整请求或认证信息。
        fields = line.split()
        first = fields[0].decode('ascii', errors='replace') if fields else ''
        try:
            ip = str(ipaddress.ip_address(first))
        except ValueError:
            ip = 'UNRECOGNIZED_LOG_FORMAT'
        print(f'file={p} first_field_ip={ip}')
if not found:
    print('PROBE_NOT_FOUND: 检查域名是否到达本机、日志是否禁用或使用其他路径。')
PY
echo '===== ACCESS LOG FORMAT / DESTINATION ====='
# 仅日志声明，不读取证书、认证配置或环境值。
podman exec onemt-nginx nginx -T 2>/dev/null | python3 -c '
import sys,re
for line in sys.stdin:
    if re.match(r"^\s*(access_log|log_format)\s", line):
        print(line.rstrip())
'
echo 'INGRESS_IP_CHECK_COMPLETE'
