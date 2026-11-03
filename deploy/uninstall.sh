#!/usr/bin/env bash
# shot 摄像头变焦测试服务 —— 完整卸载（root）
#
#   sudo ./deploy/uninstall.sh
#
# 会删除:
#   - systemd 服务 shot-cam / shot-cert-sync.timer
#   - 系统用户 shotcam
#   - /opt/shot（日志先打包到 /root/shot-logs-<时间>.tar.gz）
#   - /opt/stream/Caddyfile 中的 shot 测试站配置块（并 reload Caddy）
# 不会自动改动:
#   - 阿里云安全组的 8082 端口规则（需在控制台手工删除）
#   - 仓库 deploy 目录中已有的 Caddyfile 备份
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo $0" >&2
  exit 1
fi

PREFIX="${SHOT_ROOT:-/opt/shot}"
SVC_USER="${SHOT_USER:-shotcam}"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="/root/shot-logs-$TS.tar.gz"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

say "停止并移除 systemd 单元"
systemctl disable --now shot-cam.service 2>/dev/null || true
systemctl disable --now shot-cert-sync.timer 2>/dev/null || true
rm -f /etc/systemd/system/shot-cam.service \
      /etc/systemd/system/shot-cert-sync.service \
      /etc/systemd/system/shot-cert-sync.timer
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

if [ -d "$PREFIX/logs" ] && [ -n "$(ls -A "$PREFIX/logs" 2>/dev/null)" ]; then
  say "备份日志到 $ARCHIVE"
  tar -czf "$ARCHIVE" -C "$PREFIX" logs
  chmod 600 "$ARCHIVE"
fi

say "移除 Caddy 测试站配置"
if [ -x "$PREFIX/bin/caddy_site.py" ]; then
  python3 "$PREFIX/bin/caddy_site.py" remove || echo "警告: 移除 Caddy 配置失败，请手工检查 /opt/stream/Caddyfile" >&2
elif [ -f /opt/stream/Caddyfile ]; then
  echo "警告: 找不到 caddy_site.py，请手工删除 /opt/stream/Caddyfile 中的 shot-cam-test 配置块" >&2
fi

say "删除 Caddy 中为该 IP 申请的证书目录"
CERT_DIR="/var/lib/docker/volumes/stream_caddy_data/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/8.137.124.107"
if [ -d "$CERT_DIR" ]; then
  rm -rf "$CERT_DIR"
  echo "  已删除 $CERT_DIR"
fi

say "删除 $PREFIX"
rm -rf "$PREFIX"
rm -rf /tmp/shot-src

if id -u "$SVC_USER" >/dev/null 2>&1; then
  say "删除用户 $SVC_USER"
  pkill -u "$SVC_USER" 2>/dev/null || true
  userdel "$SVC_USER" 2>/dev/null || true
fi

echo
echo "✅ 已卸载。请确认:"
echo "   - 端口 8082 已无监听: ss -lntp | grep 8082"
echo "   - 阿里云安全组可移除 8082/TCP 规则（控制台操作）"
echo "   - 日志归档: $ARCHIVE"
echo "   - Caddy 中 Caddyfile.bak.shot.* 备份可自行删除"
