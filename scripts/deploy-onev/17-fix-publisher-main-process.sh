#!/usr/bin/env bash
# 修复 publisher 主进程：systemd 直接启动 Node，避免 Volta 包装进程阻断 SIGTERM 排空。
# 仅在 publisher 空闲时执行；不改环境文件、不改 nginx、不触发构建。
set -euo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'Run as root'; exit 1; }
mountpoint -q /data
UNIT=/etc/systemd/system/onev-publisher.service
NODE=/home/onev/.volta/tools/image/node/22.22.3/bin/node
[[ -f "$UNIT" && ! -L "$UNIT" && -x "$NODE" ]]
systemctl is-active --quiet onev-publisher.service
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:9091/healthz | python3 -c '
import json,sys
v=json.load(sys.stdin)
assert v.get("building") is False and v.get("pending") is False and v.get("shuttingDown") is False, "publisher must be idle"
'
umask 077
BACKUP=$(mktemp -d /data/onev-backups/publisher-main-XXXXXXXX)
cp -p "$UNIT" "$BACKUP/onev-publisher.service"
python3 - "$UNIT" "$BACKUP/new.service" "$NODE" <<'PY'
from pathlib import Path
import sys
s=Path(sys.argv[1]).read_text()
old='ExecStart=/home/onev/.volta/bin/volta run --node 22.22.3 -- node /srv/onev-publisher/publisher.mjs'
new=f'ExecStart={sys.argv[3]} /srv/onev-publisher/publisher.mjs'
if s.count(old)!=1:
    raise SystemExit('Unexpected ExecStart; refusing modification (possibly already fixed)')
Path(sys.argv[2]).write_text(s.replace(old,new))
PY
changed=0
rollback() {
  rc=$?
  trap - EXIT
  if [[ $rc -ne 0 && $changed -eq 1 ]]; then
    echo "FAILED: restoring publisher unit from $BACKUP"
    if install -o root -g root -m 0644 "$BACKUP/onev-publisher.service" "$UNIT"; then
      systemctl daemon-reload || true
      systemctl start onev-publisher.service || true
    else
      echo 'RESTORE FAILED: manual intervention required'
    fi
  fi
  exit "$rc"
}
trap rollback EXIT
# 直接向旧 unit 下的真实 publisher Node 发 TERM：其 shutdown 会排空 debounce/pending，
# 不依赖旧 Volta 是否转发信号，也不因健康探针与停止之间的新请求而丢任务。
MAIN_PID=$(systemctl show onev-publisher.service --property=MainPID --value)
python3 - "$MAIN_PID" "$NODE" <<'PY'
import os, signal, sys, time
from pathlib import Path
main = int(sys.argv[1])
assert main > 0
records = {}
for p in Path('/proc').iterdir():
    if not p.name.isdigit():
        continue
    try:
        stat = (p/'stat').read_text().rsplit(')', 1)[1].split()
        args = (p/'cmdline').read_bytes().split(b'\0')
        records[int(p.name)] = (int(stat[1]), stat[0], args)
    except (OSError, ValueError):
        pass
matches = []
for pid, (_, state, args) in records.items():
    if state == 'Z' or b'/srv/onev-publisher/publisher.mjs' not in args:
        continue
    try:
        if os.path.realpath(f'/proc/{pid}/exe') != sys.argv[2]:
            continue
    except OSError:
        continue
    cursor, seen = pid, set()
    while cursor in records and cursor not in seen:
        if cursor == main:
            matches.append(pid)
            break
        seen.add(cursor)
        cursor = records[cursor][0]
if len(matches) != 1:
    raise SystemExit('Cannot uniquely identify publisher Node under unit MainPID; refusing signal')
pid = matches[0]
os.kill(pid, signal.SIGTERM)
print('Publisher Node SIGTERM sent; waiting for graceful drain', flush=True)
for _ in range(300):
    try:
        state = Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0]
    except FileNotFoundError:
        break
    if state == 'Z':
        break
    time.sleep(1)
else:
    raise SystemExit('Drain still running after 5min; no forced kill or unit replacement. Inspect journal before retry.')
print('Publisher Node exited without forced kill')
PY
changed=1
systemctl stop onev-publisher.service
install -o root -g root -m 0644 "$BACKUP/new.service" "$UNIT"
systemd-analyze verify "$UNIT"
systemctl daemon-reload
systemctl start onev-publisher.service
for i in {1..20}; do
  if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:9091/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:9091/healthz
PID=$(systemctl show onev-publisher.service --property=MainPID --value)
[[ "$PID" =~ ^[1-9][0-9]*$ ]]
[[ "$(readlink -f "/proc/$PID/exe")" = "$NODE" ]]
echo
# 验证新服务能收到 SIGTERM 并正常退出，之后重新启动。
systemctl stop onev-publisher.service
[[ "$(systemctl show onev-publisher.service --property=ExecMainStatus --value)" = 0 ]]
systemctl start onev-publisher.service
for i in {1..20}; do
  if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:9091/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --noproxy '*' -fsS --max-time 5 http://127.0.0.1:9091/healthz
changed=0
echo
echo "BACKUP_DIR=$BACKUP"
echo 'PUBLISHER_MAIN_PROCESS_VERIFIED'
