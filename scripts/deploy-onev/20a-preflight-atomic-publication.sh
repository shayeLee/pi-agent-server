#!/usr/bin/env bash
# 阶段 20a：原子发布升级前的只读现场核查。
# 不停止/重启/重载服务，不写文件，不发起 POST /publish，不输出环境变量或凭据。
set -euo pipefail
exec 2>&1

if [[ $(id -u) -ne 0 ]]; then
  echo 'ERROR: run as root (sudo bash ...)' >&2
  exit 1
fi

fail() { echo "ERROR: $*" >&2; exit 1; }
for command_name in curl python3 systemctl nginx podman mountpoint stat df sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done

printf '===== READ-ONLY ONEV PUBLICATION PREFLIGHT =====\n'
date -u '+utc=%Y-%m-%dT%H:%M:%SZ'
mountpoint -q /data || fail '/data is not a mountpoint'
df -h / /data

printf '\n===== SERVICE STATE =====\n'
for unit in pi-agent-server.service onev-publisher.service nginx.service; do
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  printf '%s active=%s enabled=%s\n' "$unit" "$active" "$enabled"
done
printf 'container_onemt_nginx='; podman inspect -f '{{.State.Status}}' onemt-nginx 2>/dev/null || true

printf '\n===== LOOPBACK HEALTH (status only; no response body) =====\n'
probe() {
  local name=$1 url=$2 code
  code=$(curl --noproxy '*' --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --connect-timeout 3 --max-time 10 "$url") || code="curl_failed_${code:-000}"
  printf '%s=%s\n' "$name" "$code"
}
probe host_health http://127.0.0.1:18080/health
probe host_readyz http://127.0.0.1:18080/readyz
probe publisher_healthz http://127.0.0.1:9091/healthz

printf '\n===== PUBLISHER QUEUE (known fields only) =====\n'
if ! curl --noproxy '*' --fail --silent --show-error --connect-timeout 3 --max-time 10 \
    http://127.0.0.1:9091/healthz \
    | python3 -c 'import json,sys; v=json.load(sys.stdin); print("building=%r pending=%r debouncePending=%r shuttingDown=%r" % tuple(v.get(k, "unknown") for k in ("building","pending","debouncePending","shuttingDown")))'; then
  echo 'publisher queue state unavailable (do not upgrade while a build may be active)'
fi

printf '\n===== STATIC SITE AND RELEASE LAYOUT =====\n'
old=/srv/onev/examples/onev-ui/index.html
current=/data/onev/onev-ui-releases/current
if [[ -s "$old" ]]; then
  printf 'legacy_index=present sha256='; sha256sum "$old" | cut -d ' ' -f 1
else
  echo 'legacy_index=missing_or_empty'
fi
if [[ -L "$current" ]]; then
  printf 'release_current_symlink='; readlink "$current"
  if [[ -s "$current/index.html" ]]; then echo 'release_current_index=present'; else echo 'release_current_index=missing_or_empty'; fi
elif [[ -e "$current" ]]; then
  echo 'release_current=exists_but_not_symlink'
else
  echo 'release_current=not_created'
fi
for item in /data/onev /data/onev/onev-ui-releases \
  /etc/nginx/conf.d/onev-agent-relay.conf /etc/pi-agent-server/onev.env \
  /srv/onev-publisher/publisher.mjs; do
  if [[ -e "$item" ]]; then
    stat -c 'path=%n type=%F owner=%U:%G mode=%a' "$item"
  else
    echo "missing=$item"
  fi
done

printf '\n===== RELAY CONFIG (root classification only; no file contents) =====\n'
relay=/etc/nginx/conf.d/onev-agent-relay.conf
if [[ -f "$relay" ]]; then
  if grep -Fq 'root  /srv/onev/examples/onev-ui;' "$relay"; then
    echo 'relay_root=legacy_checkout'
  elif grep -Fq 'root  /data/onev/onev-ui-releases/current;' "$relay"; then
    echo 'relay_root=atomic_current'
  else
    echo 'relay_root=unknown (inspect manually before any upgrade)'
  fi
fi
if nginx -t >/dev/null 2>&1; then echo 'host_nginx_config=valid'; else echo 'host_nginx_config=INVALID'; fi

printf '\n===== HTTPS HOMEPAGE (status only; no body) =====\n'
code=$(curl --noproxy '*' --silent --show-error --output /dev/null \
  --write-out '%{http_code}' --connect-timeout 3 --max-time 15 \
  --resolve onev-ui.onemt.co:443:127.0.0.1 \
  https://onev-ui.onemt.co/ 2>/dev/null) || code="curl_failed_${code:-000}"
printf 'https_homepage=%s\n' "$code"

printf '\n===== DEPLOYED CODE MARKERS (no secrets) =====\n'
if [[ -f /srv/pi-agent-capability-onev/dist/publication/webhook.js ]] \
  && grep -Fq '4_500_000' /srv/pi-agent-capability-onev/dist/publication/webhook.js; then
  echo 'plugin_final_response_webhook=present'
else
  echo 'plugin_final_response_webhook=not_deployed'
fi
if [[ -f /srv/onev/build/webpack.demo.js ]] \
  && grep -Fq 'DOCS_OUTPUT_PATH' /srv/onev/build/webpack.demo.js; then
  echo 'frontend_staging_output=present'
else
  echo 'frontend_staging_output=not_deployed'
fi
if [[ -f /srv/onev/build/bin/clean-docs-output.js ]]; then
  echo 'frontend_staging_clean_guard=present'
else
  echo 'frontend_staging_clean_guard=not_deployed'
fi
if [[ -f /srv/onev-publisher/publisher.mjs ]] \
  && grep -Fq 'onev-ui-releases' /srv/onev-publisher/publisher.mjs; then
  echo 'atomic_publisher=present'
else
  echo 'atomic_publisher=not_deployed'
fi

printf '\nREAD_ONLY_PREFLIGHT_COMPLETE\n'
echo 'NOTE: publisher idle health is not proof that no plugin sync job is running; coordinate a no-sync window before upgrading.'
