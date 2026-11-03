#!/usr/bin/env bash
# 从 Caddy 容器里把 8.137.124.107 的证书同步到 /opt/shot/tls
# 由 systemd 定时器与 shot-cam.service 的 ExecStartPre 以 root 身份调用
set -euo pipefail

HOST_IP="8.137.124.107"
ROOT="${SHOT_ROOT:-/opt/shot}"
DEST="$ROOT/tls"
OWNER="${SHOT_USER:-shotcam}"

if [ "$(id -u)" -ne 0 ]; then
  echo "sync-cert: must run as root" >&2
  exit 1
fi

mkdir -p "$DEST"
exec 9>"$DEST/.lock"
flock -w 10 9 || { echo "sync-cert: lock timeout" >&2; exit 1; }

SRC_DIR="$(find /var/lib/docker/volumes -maxdepth 8 -type d \
  -path "*/certificates/*/$HOST_IP" -name "$HOST_IP" 2>/dev/null | head -n1)"

if [ -z "$SRC_DIR" ]; then
  echo "sync-cert: cert dir for $HOST_IP not found under /var/lib/docker/volumes" >&2
  exit 1
fi

CRT="$SRC_DIR/$HOST_IP.crt"
KEY="$SRC_DIR/$HOST_IP.key"
if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
  echo "sync-cert: cert/key missing in $SRC_DIR" >&2
  exit 1
fi

install -m 0644 -o root -g "$OWNER" "$CRT" "$DEST/fullchain.pem"
install -m 0640 -o root -g "$OWNER" "$KEY" "$DEST/privkey.pem"
echo "sync-cert: ok $(openssl x509 -in "$DEST/fullchain.pem" -noout -enddate | cut -d= -f2)"
