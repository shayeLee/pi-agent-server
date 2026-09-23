#!/usr/bin/env bash
# ONEV 裸机部署：阶段 5，只读检查磁盘/分区扩容条件及 /data 一级目录。

set -u

echo '===== BLOCK DEVICES ====='
lsblk -o NAME,PATH,TYPE,SIZE,FSTYPE,FSVER,MOUNTPOINTS,PKNAME,PARTTYPE,PARTUUID

echo
echo '===== ROOT MOUNT ====='
findmnt -no SOURCE,FSTYPE,OPTIONS /
df -hT /

echo
echo '===== PARTITION TABLE ====='
fdisk -l /dev/sda 2>&1 || true

echo
echo '===== GROW TOOLS ====='
command -v growpart || true
command -v resize2fs || true
dpkg-query -W -f='${Status} ${Package} ${Version}\n' cloud-guest-utils e2fsprogs 2>/dev/null || true

echo
echo '===== /data CHILDREN ====='
ls -lah /data 2>&1 || true

if [ -d /data ]; then
  while IFS= read -r -d '' child; do
    echo "--- $child ---"
    timeout 15s du -x -s -h "$child" 2>/dev/null || echo 'TIMEOUT'
  done < <(find /data -mindepth 1 -maxdepth 1 -print0 2>/dev/null | sort -z)
fi

echo
echo '===== VOLTA NODE VERSION SIZES ====='
if [ -d /root/.volta/tools/image/node ]; then
  for child in /root/.volta/tools/image/node/*; do
    [ -e "$child" ] || continue
    du -sh "$child" 2>/dev/null || true
  done | sort -h
fi

echo
echo '===== VOLTA INVENTORY NODE ====='
ls -lah /root/.volta/tools/inventory/node 2>/dev/null || true

echo
echo '===== END ====='
