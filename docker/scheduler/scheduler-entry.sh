#!/usr/bin/env bash
set -euo pipefail

# Environment the container expects:
#   DRILL_SCHEDULER_DIR  -> shared dir (host poll) where requests/results live
#   DRILL_TARGETS        -> comma-separated, e.g. "sqlite,postgres"
#   DRILL_CRON_MINUTE    -> optional cron minute schedule (default every minute)

SCHED_DIR="${DRILL_SCHEDULER_DIR:-/scheduler}"
CRON_MIN="${DRILL_CRON_MINUTE:-*}"
NODE_BIN="/usr/local/bin/node"

mkdir -p "$SCHED_DIR"

# Install a cron schedule that runs the scheduler-node "cron" mode every minute.
cat > /etc/cron.d/drill-scheduler <<CRON
$CRON_MIN * * * * root DRILL_SCHEDULER_DIR="$SCHED_DIR" DRILL_CLI_ROOT="${DRILL_CLI_ROOT:-/app}" $NODE_BIN /usr/local/bin/scheduler-node.mjs --cron >> "$SCHED_DIR/cron.log" 2>&1
CRON
chmod 644 /etc/cron.d/drill-scheduler

# Start the cron daemon (Debian binary is /usr/sbin/cron; run in background).
if [ -x /usr/sbin/cron ]; then
  /usr/sbin/cron >/dev/null 2>&1 &
elif [ -x /usr/sbin/crond ]; then
  /usr/sbin/crond >/dev/null 2>&1 &
fi

# Write an immediate heartbeat so the host can verify the timer is present+recent.
date +%s > "$SCHED_DIR/heartbeat"

# Run the node watcher (on-demand) in the foreground; keeps the container alive.
exec "$NODE_BIN" /usr/local/bin/scheduler-node.mjs --watch
