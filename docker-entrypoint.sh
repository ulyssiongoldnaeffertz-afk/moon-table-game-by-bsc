#!/bin/sh
set -eu
: "${ADMIN_PASSWORD:?请在云托管环境变量设置至少12位的ADMIN_PASSWORD}"
: "${DATA_DIR:=/mnt/moon-table}"
: "${STORAGE_DRIVER:=snapshot}"
export DATA_DIR STORAGE_DRIVER
if [ "$STORAGE_DRIVER" != snapshot ]; then
  echo '云托管镜像请使用 STORAGE_DRIVER=snapshot；SQLite WAL 不适用于 CFS。' >&2
  exit 1
fi
# Refuse ephemeral container disks; DATA_DIR must be within a real mounted filesystem.
node /app/check-mount.mjs
mkdir -p "$DATA_DIR"
# Hold the kernel lock until Node has completely exited. It releases on a crash too.
# Never allow two replicas to advance the six in-memory rooms independently.
# A new deployment must stop the old instance before the new instance can start.
exec flock --no-fork --exclusive --nonblock --conflict-exit-code 75 "$DATA_DIR/.single-writer.lock" node /app/server.mjs
