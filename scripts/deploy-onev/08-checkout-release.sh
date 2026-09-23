#!/usr/bin/env bash
# ONEV 裸机部署：阶段 8，拉取并固定三个已验证的发布 commit。
# 前置条件：阶段 7 备份成功；三个仓库工作区必须干净。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'ERROR: must run as root' >&2
  exit 1
fi

# 宿主/插件的后续提交按部署方决定移除了跨平台 lockfile；代码功能分别包含
# 4677d8b0 / 4487585。安装阶段使用 --no-frozen-lockfile。
HOST_COMMIT='7ee010a2'
PLUGIN_COMMIT='00b3a095'
FRONTEND_COMMIT='7cf0ab79'

checkout_release() {
  local repo="$1"
  local commit="$2"
  local path="/srv/$repo"

  echo "===== $repo -> $commit ====="
  test -d "$path/.git"
  if [ -n "$(git -C "$path" status --porcelain=v1)" ]; then
    echo "ERROR: dirty repository: $path" >&2
    git -C "$path" status --short >&2
    exit 1
  fi

  git -C "$path" fetch --prune origin
  git -C "$path" cat-file -e "$commit^{commit}"
  git -C "$path" switch --detach "$commit"

  actual="$(git -C "$path" rev-parse --short=8 HEAD)"
  expected="$(git -C "$path" rev-parse --short=8 "$commit")"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: commit verification failed for $repo: $actual != $expected" >&2
    exit 1
  fi
  test -z "$(git -C "$path" status --porcelain=v1)"
  git -C "$path" log -1 --oneline
  echo
}

avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
if [ "$avail_kb" -lt 5242880 ]; then
  echo 'ERROR: less than 5 GiB available; refusing checkout' >&2
  exit 1
fi

checkout_release pi-agent-server "$HOST_COMMIT"
checkout_release pi-agent-capability-onev "$PLUGIN_COMMIT"
checkout_release onev "$FRONTEND_COMMIT"

echo '===== RELEASE CHECKOUT COMPLETE ====='
df -h /
