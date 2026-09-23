#!/usr/bin/env bash
# 阶段 20b：无同步任务的维护窗口，停写并备份现有生产状态，随后恢复服务。
# 自包含，不依赖 sqlite3 CLI、Python 或生产阶段 7；固定 Node 22.22.3 的 node:sqlite
# DatabaseSync(只读)/backup 保留 WAL 已提交事务。Node 顶层经 onev 的 volta 调用，避免 root 触发下载。
# 不改源码、配置、nginx 或发布目录；不提交 Git；凭据只进 /data 私有归档，不打印内容。
set -euo pipefail
exec 2>&1
[[ $(id -u) -eq 0 ]] || { echo 'ERROR: run as root' >&2; exit 1; }

BACKUP_BASE=/data/onev-backups
HOST=pi-agent-server.service
PUBLISHER=onev-publisher.service
HOST_DB=/data/onev/pi-agent-server/pi-agent-server.db
PLUGIN_DB=/data/onev/pi-agent-capability-onev/onev.db
NODE_HOME=/home/onev
VOLTA_HOME=/home/onev/.volta
VOLTA_BIN=/home/onev/.volta/bin/volta
NODE_VERSION=22.22.3
NODE_IMAGE=/home/onev/.volta/tools/image/node/22.22.3/bin/node
PROBE_TIMEOUT_SECONDS=120
BACKUP_TIMEOUT_SECONDS=1800
BACKUP_DEADLINE_SECONDS=1700
ROOT=''
HOST_WAS_ACTIVE=0
PUBLISHER_WAS_ACTIVE=0

fail() { echo "ERROR: $*" >&2; exit 1; }
health() {
  local url=$1
  for _ in {1..30}; do
    if curl --noproxy '*' --fail --silent --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
node_run() {
  local timeout_seconds=${NODE_TIMEOUT_SECONDS:-$PROBE_TIMEOUT_SECONDS}
  env HOME="$NODE_HOME" VOLTA_HOME="$VOLTA_HOME" \
    PATH="$VOLTA_HOME/bin:/usr/local/bin:/usr/bin:/bin" \
    timeout --signal=TERM --kill-after=30s "${timeout_seconds}s" \
    "$VOLTA_BIN" run --node "$NODE_VERSION" -- node --disable-warning=ExperimentalWarning "$@"
}
restore_services() {
  local rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ $PUBLISHER_WAS_ACTIVE -eq 1 ]] && ! systemctl is-active --quiet "$PUBLISHER"; then
    systemctl start "$PUBLISHER" || { echo "RESTORE ERROR: could not start $PUBLISHER" >&2; rc=1; }
  fi
  if [[ $HOST_WAS_ACTIVE -eq 1 ]] && ! systemctl is-active --quiet "$HOST"; then
    systemctl start "$HOST" || { echo "RESTORE ERROR: could not start $HOST" >&2; rc=1; }
  fi
  if [[ $HOST_WAS_ACTIVE -eq 1 && $PUBLISHER_WAS_ACTIVE -eq 1 ]]; then
    health http://127.0.0.1:9091/healthz || { echo 'RESTORE ERROR: publisher healthz failed' >&2; rc=1; }
    health http://127.0.0.1:18080/readyz || { echo 'RESTORE ERROR: host readyz failed' >&2; rc=1; }
  fi
  exit "$rc"
}
trap restore_services EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for command_name in curl timeout systemctl mountpoint tar git mktemp sha256sum gzip df du stat nginx podman; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done
mountpoint -q /data || fail '/data is not a mountpoint'
systemctl is-active --quiet "$HOST" || fail "$HOST must be active before backup"
HOST_WAS_ACTIVE=1
systemctl is-active --quiet "$PUBLISHER" || fail "$PUBLISHER must be active before backup"
PUBLISHER_WAS_ACTIVE=1
for item in "$HOST_DB" "$PLUGIN_DB" /srv/onev/examples/onev-ui/index.html \
  /srv/onev-publisher/publisher.mjs \
  /etc/pi-agent-server/onev.env; do
  [[ -f "$item" && ! -L "$item" ]] || fail "required production file missing/symlink: $item"
done
for item in /data/onev/pi-agent-server /data/onev/pi-agent-capability-onev \
  /etc/nginx /etc/systemd/system; do
  [[ -d "$item" && ! -L "$item" ]] || fail "required production directory missing/symlink: $item"
done
[[ -s /srv/onev/examples/onev-ui/index.html ]] || fail 'existing site index empty'
# 本次只升级插件、前端和 publisher；额外保留宿主运行产物，源码恢复只覆盖本次变更面。
for item in /srv/pi-agent-server/dist \
  /srv/pi-agent-capability-onev/src/config.js \
  /srv/pi-agent-capability-onev/src/dingtalk/service.js \
  /srv/pi-agent-capability-onev/src/index.js \
  /srv/pi-agent-capability-onev/src/publication/webhook.js \
  /srv/pi-agent-capability-onev/dist /srv/onev/package.json \
  /srv/onev/build/webpack.demo.js /srv/onev/examples/components/document-link/index.vue; do
  [[ -e "$item" && ! -L "$item" ]] || fail "required rollback input missing/symlink: $item"
done
for repo in pi-agent-server pi-agent-capability-onev onev; do
  [[ -d "/srv/$repo/.git" ]] || fail "missing repository /srv/$repo"
  [[ -z "$(git -C "/srv/$repo" status --porcelain=v1)" ]] || fail "dirty repository /srv/$repo; stop and inspect"
done
[[ -x "$VOLTA_BIN" ]] || fail "missing volta: $VOLTA_BIN"
[[ -x "$NODE_IMAGE" ]] || fail "pinned Node $NODE_VERSION image missing: $NODE_IMAGE (refusing to let root download it)"
# 停机前用独立临时目录做一次完整往返（WAL 源 -> readOnly -> backup -> DELETE -> 重开校验），
# 确认固定 Node 镜像的 node:sqlite backup API 在停机前即可用。
probe_dir=$(mktemp -d /tmp/onev-sqlite-probe-XXXXXX)
if ! node_run - "$probe_dir" "$NODE_VERSION" <<'JS_PROBE'
'use strict';
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const probeDir = process.argv[2];
const expectedVersion = process.argv[3];
const sourcePath = path.join(probeDir, 'probe-source.db');
const destPath = path.join(probeDir, 'probe-dest.db');

(async () => {
  if (process.version !== `v${expectedVersion}`) {
    throw new Error(`expected Node v${expectedVersion}, running ${process.version}`);
  }
  const writer = new DatabaseSync(sourcePath);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('CREATE TABLE probe(value TEXT)');
  writer.prepare('INSERT INTO probe VALUES (?)').run('probe');
  writer.close();
  const reader = new DatabaseSync(sourcePath, { readOnly: true });
  let pages;
  try {
    pages = await backup(reader, destPath, { rate: 256 });
  } finally {
    reader.close();
  }
  const snapshot = new DatabaseSync(destPath);
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') throw new Error('probe target integrity_check failed');
    const journal = snapshot.prepare('PRAGMA journal_mode=DELETE').get();
    if (!journal || String(journal.journal_mode).toLowerCase() !== 'delete') throw new Error('probe journal_mode=DELETE failed');
  } finally {
    snapshot.close();
  }
  const reopened = new DatabaseSync(destPath, { readOnly: true });
  try {
    const integrity = reopened.prepare('PRAGMA integrity_check').get();
    const row = reopened.prepare('SELECT COUNT(*) AS n FROM probe').get();
    if (!integrity || integrity.integrity_check !== 'ok' || !row || row.n !== 1) {
      throw new Error('probe reopen verification failed');
    }
  } finally {
    reopened.close();
  }
  if (!Number.isInteger(pages) || pages < 1) throw new Error('probe backup page count invalid');
  console.log(`node_sqlite_backup_api=available node=${process.version} sqlite=${process.versions.sqlite} probe_pages=${pages}`);
})().catch((error) => {
  console.error(`ERROR: node sqlite backup probe failed: ${error.message}`);
  process.exit(1);
});
JS_PROBE
then
  rm -rf "$probe_dir"
  fail "Node $NODE_VERSION node:sqlite backup API probe failed"
fi
rm -rf "$probe_dir"

active_jobs() {
  node_run - "$PLUGIN_DB" <<'JS_JOBS'
'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sync_jobs WHERE status IN ('pending','running')").get();
  if (!row || !Number.isInteger(row.n)) throw new Error('unexpected sync_jobs count result');
  console.log(row.n);
} finally {
  db.close();
}
JS_JOBS
}
count=$(active_jobs) || fail 'could not inspect pending/running sync jobs'
echo "active_sync_jobs_before_stop=$count"
[[ "$count" = 0 ]] || fail 'sync jobs are active; wait for completion'
curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 \
  http://127.0.0.1:9091/healthz | node_run -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw);
    if (value.building !== false || value.pending !== false || value.shuttingDown !== false || (value.debouncePending ?? false) !== false) {
      throw new Error("publisher is not idle");
    }
    console.log("publisher_idle=true");
  } catch (error) {
    console.error("ERROR: " + error.message);
    process.exit(1);
  }
});
' || fail 'publisher is not idle'

# 最坏情况下把数据目录与单独的 DB 快照都按原字节数计入，再预留 10% 和 5 GiB。
# 仅估算，不因此清理生产或旧备份；tar 的 sparse 展开风险按 apparent-size 计入。
need_kb=0
for item in /data/onev/pi-agent-server /data/onev/pi-agent-capability-onev \
  "$HOST_DB" "$PLUGIN_DB" /srv/onev/examples/onev-ui \
  /home/onev/.pi /home/onev/.dws \
  /data/www/nginx/html/onev-ui /data/www/nginx/conf.d/onev-ui.conf \
  /data/onev/onev-ui-releases /srv/pi-agent-server/dist \
  /srv/pi-agent-capability-onev/dist /etc/nginx /etc/systemd/system; do
  if [[ -e "$item" ]]; then
    kb=$(du -sk --apparent-size "$item" | awk '{print $1}')
    need_kb=$((need_kb + kb))
  fi
done
available_kb=$(df -Pk /data | awk 'NR==2 {print $4}')
min_kb=$((need_kb + need_kb / 10 + 5 * 1024 * 1024))
echo "data_backup_required_estimate_kib=$min_kb available_kib=$available_kb"
(( available_kb >= min_kb )) || fail 'insufficient /data free space for conservative backup estimate'

# 仍须由操作人安排无新同步请求的维护窗口；停前/停后两次查库缩小竞态窗口。
echo '===== STOP WRITERS (maintenance window: do not start new sync) ====='
systemctl stop "$HOST"
systemctl is-active --quiet "$HOST" && fail 'host still active after stop'
systemctl stop "$PUBLISHER"
systemctl is-active --quiet "$PUBLISHER" && fail 'publisher still active after stop'
count=$(active_jobs) || fail 'could not recheck sync jobs after stopping writers'
echo "active_sync_jobs_after_stop=$count"
[[ "$count" = 0 ]] || fail 'a sync job appeared during stop; services will be restored'

umask 077
[[ ! -L "$BACKUP_BASE" ]] || fail 'backup base must not be a symlink'
install -d -o root -g root -m 0700 "$BACKUP_BASE"
ROOT=$(mktemp -d "$BACKUP_BASE/atomic-upgrade-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
chmod 0700 "$ROOT"
echo "BACKUP_DIR=$ROOT"

# SQLite 在线 backup API 包含 WAL 中已提交内容；先写私有 .partial，双重 integrity_check
# 均为唯一 ok 才原子改名。只读打开源库，绝不对生产库执行 checkpoint/迁移或删除其 WAL。
backup_db() {
  NODE_TIMEOUT_SECONDS=$BACKUP_TIMEOUT_SECONDS \
    node_run - "$1" "$2" "$BACKUP_DEADLINE_SECONDS" <<'JS_BACKUP'
'use strict';
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = process.argv[2];
const destPath = process.argv[3];
const deadlineSeconds = Number(process.argv[4]);
const partialPath = `${destPath}.partial`;
const partialSidecars = [`${partialPath}-wal`, `${partialPath}-shm`];

function fail(message) {
  throw new Error(message);
}

function removePartialArtifacts() {
  for (const candidate of [partialPath, ...partialSidecars]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch (error) {
      // 清理尽力而为；残留只会让下次运行按“拒绝覆盖”中止。
    }
  }
}

(async () => {
  if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) fail('invalid backup deadline');
  if (!fs.existsSync(sourcePath)) fail(`source database missing: ${sourcePath}`);
  if (!fs.statSync(sourcePath).isFile()) fail(`source database is not a regular file: ${sourcePath}`);
  // 存在性检查先于任何创建：绝不覆盖既有快照或临时文件，也不改动源库。
  if (fs.existsSync(destPath)) fail(`backup target already exists: ${destPath}`);
  for (const sidecar of partialSidecars) {
    if (fs.existsSync(sidecar)) fail(`backup target sidecar already exists: ${sidecar}`);
  }
  let partialFd;
  try {
    partialFd = fs.openSync(partialPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail(`backup partial already exists: ${partialPath}`);
    throw error;
  }
  fs.closeSync(partialFd);
  const startedAt = Date.now();
  const deadlineMs = deadlineSeconds * 1000;
  let pages = 0;
  try {
    const reader = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      pages = await backup(reader, partialPath, {
        rate: 256,
        progress: () => {
          if (Date.now() - startedAt > deadlineMs) fail(`SQLite backup exceeded ${deadlineSeconds}s`);
        },
      });
    } finally {
      reader.close();
    }
    const snapshot = new DatabaseSync(partialPath);
    try {
      const integrity = snapshot.prepare('PRAGMA integrity_check').get();
      if (!integrity || integrity.integrity_check !== 'ok') fail('backup target integrity_check failed');
      const journal = snapshot.prepare('PRAGMA journal_mode=DELETE').get();
      if (!journal || String(journal.journal_mode).toLowerCase() !== 'delete') {
        fail('could not set backup target journal_mode=DELETE');
      }
    } finally {
      snapshot.close();
    }
    // 已切为 DELETE 且连接全部关闭后，可能遗留空 WAL/SHM；它们不是备份内容。
    for (const sidecar of partialSidecars) {
      if (fs.existsSync(sidecar) && fs.statSync(sidecar).size !== 0) {
        fail(`backup target still depends on WAL: ${sidecar}`);
      }
      fs.rmSync(sidecar, { force: true });
    }
    const reopened = new DatabaseSync(partialPath, { readOnly: true });
    try {
      const integrity = reopened.prepare('PRAGMA integrity_check').get();
      if (!integrity || integrity.integrity_check !== 'ok') fail('reopened backup target integrity_check failed');
    } finally {
      reopened.close();
    }
    if (fs.statSync(partialPath).size <= 0) fail('backup target is empty');
    fs.chmodSync(partialPath, 0o600);
    fs.renameSync(partialPath, destPath);
    console.log(`sqlite_backup=${path.basename(destPath)} bytes=${fs.statSync(destPath).size} pages=${pages} integrity_check=ok`);
  } catch (error) {
    removePartialArtifacts();
    throw error;
  }
})().catch((error) => {
  console.error(`ERROR: sqlite backup failed for ${destPath}: ${error.message}`);
  process.exit(1);
});
JS_BACKUP
}
backup_db "$HOST_DB" "$ROOT/pi-agent-server.db.backup"
backup_db "$PLUGIN_DB" "$ROOT/onev.db.backup"

for repo in pi-agent-server pi-agent-capability-onev onev; do
  git -C "/srv/$repo" rev-parse HEAD > "$ROOT/$repo.head"
  git -C "/srv/$repo" status --porcelain=v1 > "$ROOT/$repo.status"
done
install -o root -g root -m 0600 /etc/pi-agent-server/onev.env "$ROOT/onev.env"
tar -C / -czf "$ROOT/etc-nginx.tar.gz" etc/nginx
tar -C / -czf "$ROOT/etc-systemd-system.tar.gz" etc/systemd/system
nginx -T > "$ROOT/nginx-T.txt" 2>&1 || fail 'nginx -T failed'
podman inspect onemt-nginx > "$ROOT/onemt-nginx.inspect.json" || fail 'podman inspect failed'
for repo in pi-agent-server pi-agent-capability-onev; do
  if [[ "$repo" = pi-agent-server ]]; then db_name=pi-agent-server.db; else db_name=onev.db; fi
  tar -C /data/onev --exclude="$repo/$db_name" \
    --exclude="$repo/$db_name-wal" --exclude="$repo/$db_name-shm" \
    --exclude="$repo/$db_name-journal" -czf "$ROOT/$repo-data.tar.gz" "$repo"
done
tar -C /srv/onev/examples -czf "$ROOT/onev-ui.tar.gz" onev-ui
# 阶段18切换后容器不再服务此目录，但它与容器配置仍属于原站回滚资产。
legacy_paths=()
if [[ -f /data/www/nginx/conf.d/onev-ui.conf ]]; then
  legacy_paths+=(conf.d/onev-ui.conf)
else
  echo 'legacy_https_site_config=not_present'
fi
if [[ -d /data/www/nginx/html/onev-ui ]]; then
  legacy_paths+=(html/onev-ui)
else
  echo 'legacy_https_static=not_present'
fi
if (( ${#legacy_paths[@]} > 0 )); then
  tar -C /data/www/nginx -czf "$ROOT/legacy-https-site.tar.gz" "${legacy_paths[@]}"
  echo 'legacy_https_site=backed_up'
fi
if [[ -d /data/onev/onev-ui-releases ]]; then
  tar -C /data/onev -czf "$ROOT/preexisting-releases.tar.gz" onev-ui-releases
  echo 'preexisting_releases=backed_up'
else
  echo 'preexisting_releases=not_present'
fi
if [[ -d /home/onev/.pi ]]; then
  tar -C /home/onev -czf "$ROOT/onev-pi-config.tar.gz" .pi
  echo 'onev_pi_config=backed_up (contents withheld)'
else
  echo 'onev_pi_config=not_present'
fi
if [[ -d /home/onev/.dws ]]; then
  tar -C /home/onev -czf "$ROOT/onev-dws-config.tar.gz" .dws
  echo 'onev_dws_config=backed_up (contents withheld)'
else
  echo 'onev_dws_config=not_present'
fi
tar -C / -czf "$ROOT/pre-upgrade-source-files.tar.gz" \
  srv/onev-publisher/publisher.mjs \
  srv/pi-agent-server/dist \
  srv/pi-agent-capability-onev/src/config.js \
  srv/pi-agent-capability-onev/src/dingtalk/service.js \
  srv/pi-agent-capability-onev/src/index.js \
  srv/pi-agent-capability-onev/src/publication/webhook.js \
  srv/pi-agent-capability-onev/dist \
  srv/onev/package.json srv/onev/build/webpack.demo.js \
  srv/onev/examples/components/document-link/index.vue

cat > "$ROOT/RESTORE-NOTES.txt" <<'NOTES'
This is a private local rollback archive for the atomic-publication upgrade, NOT an encrypted backup CLI package.
Keep this directory root-only. It contains credentials. Do not upload its contents with deployment logs.
Before restoring: stop host and publisher; retain a separate backup of the state being replaced.
Data archives intentionally exclude the primary DB and its WAL/SHM/journal sidecars.
Restore data into isolated EMPTY directories, then put pi-agent-server.db.backup at
pi-agent-server/pi-agent-server.db and onev.db.backup at pi-agent-capability-onev/onev.db.
Never overlay these snapshots onto a live database or retain old sidecars next to them.
Verify SHA256SUMS, both DB integrity_check results, ownership and permissions before activation.
Source archive covers only the planned plugin/frontend/publisher changes plus host/plugin runtime dist.
Repository HEAD files are version records, not complete source archives. Do not use this for arbitrary repository recovery.
Any new files added during the upgrade must be removed as part of its separately reviewed rollback procedure.
Do not blindly extract systemd/nginx archives over a running host; restore selected files and validate before reload.
A controlled restore procedure and readiness checks are still required; this archive does not perform auto-rollback.
NOTES

# 每个 tar 完整读取 gzip/tar；校验覆盖所有稳定产物，不纳入仍在写的日志或清单自身。
for archive in "$ROOT"/*.tar.gz; do
  gzip -t "$archive"
  tar -tzf "$archive" > /dev/null
done
(
  cd "$ROOT"
  sha256sum -- *.backup *.tar.gz RESTORE-NOTES.txt onev.env nginx-T.txt onemt-nginx.inspect.json \
    pi-agent-server.head pi-agent-capability-onev.head onev.head \
    pi-agent-server.status pi-agent-capability-onev.status onev.status > SHA256SUMS
  sha256sum -c SHA256SUMS > /dev/null
)
sync
echo 'backup_archives_verified=true (contents withheld)'

systemctl start "$PUBLISHER"
systemctl start "$HOST"
health http://127.0.0.1:9091/healthz || fail 'publisher healthz failed after restart'
health http://127.0.0.1:18080/readyz || fail 'host readyz failed after restart'
systemctl is-active --quiet "$PUBLISHER" || fail 'publisher did not remain active'
systemctl is-active --quiet "$HOST" || fail 'host did not remain active'
echo "BACKUP_DIR=$ROOT"
echo 'BACKUP_BEFORE_ATOMIC_PUBLICATION_COMPLETE'
