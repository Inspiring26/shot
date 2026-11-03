#!/usr/bin/env bash
# 本地运行：把服务器上的测试日志拉下来
#   ./scripts/fetch-logs.sh [目标目录]
set -euo pipefail

HOST="${SHOT_HOST:-admin@8.137.124.107}"
DEST="${1:-./shot-logs-$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$DEST"
echo "==> 从 $HOST:/opt/shot/logs 拉取"
ssh "$HOST" 'sudo tar -czf - -C /opt/shot logs' | tar -xzf - -C "$DEST"

echo "==> 完成: $DEST/logs"
find "$DEST/logs" -type f | head -20
echo "文件数: $(find "$DEST/logs" -type f | wc -l | tr -d ' ')"
