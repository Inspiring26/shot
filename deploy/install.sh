#!/usr/bin/env bash
# shot 摄像头变焦测试服务 —— 服务器端安装脚本（Ubuntu/Debian，root 运行）
#
#   sudo ./deploy/install.sh
#
# 做的事:
#   1. 创建系统用户 shotcam
#   2. 部署程序到 /opt/shot
#   3. 让 Caddy（stream-caddy 容器）为该 IP 申请 Let's Encrypt 短期证书
#   4. 安装 systemd 服务 shot-cam（8082，HTTPS）与证书同步定时器
set -euo pipefail
umask 022

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo $0" >&2
  exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${SHOT_ROOT:-/opt/shot}"
SVC_USER="${SHOT_USER:-shotcam}"
PORT="${SHOT_PORT:-8082}"
HOST_IP="${SHOT_HOST_IP:-8.137.124.107}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

say "部署源目录: $SRC"

# 1. 用户 --------------------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  say "创建系统用户 $SVC_USER"
  useradd --system --home-dir "$PREFIX" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi

# 2. 目录与文件 --------------------------------------------------------
say "安装文件到 $PREFIX"
mkdir -p "$PREFIX/app" "$PREFIX/bin" "$PREFIX/logs" "$PREFIX/tls"
rm -rf "$PREFIX/app"
cp -a "$SRC/app" "$PREFIX/app"
rm -rf "$PREFIX/app/__pycache__"
chown -R root:root "$PREFIX/app"
chmod -R a+rX "$PREFIX/app"
install -m 0755 "$SRC/deploy/sync-cert.sh" "$PREFIX/bin/sync-cert.sh"
install -m 0755 "$SRC/deploy/caddy_site.py" "$PREFIX/bin/caddy_site.py"
install -m 0755 "$SRC/deploy/uninstall.sh" "$PREFIX/bin/uninstall.sh"

if [ ! -s "$PREFIX/config.json" ]; then
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
  python3 - "$PREFIX/config.json" "$TOKEN" <<'PY'
import json, sys
path, token = sys.argv[1], sys.argv[2]
json.dump({"admin_token": token}, open(path, "w", encoding="utf-8"))
PY
  chown "$SVC_USER:$SVC_USER" "$PREFIX/config.json"
  chmod 0600 "$PREFIX/config.json"
  say "已生成管理 token"
fi
chown -R "$SVC_USER:$SVC_USER" "$PREFIX/logs" "$PREFIX/tls"
chmod 0750 "$PREFIX/logs"

# 3. 证书：让 Caddy 申请 IP 证书 --------------------------------------
say "配置 Caddy 为 IP 申请 Let's Encrypt 短期证书"
if [ -f /opt/stream/Caddyfile ]; then
  python3 "$PREFIX/bin/caddy_site.py" ensure
else
  echo "警告: 未找到 /opt/stream/Caddyfile，跳过证书配置（需自行提供 $PREFIX/tls/fullchain.pem）" >&2
fi

say "等待 Caddy 签发/续期 IP 证书（首次约 10~60 秒）"
for _i in $(seq 1 40); do
  if find /var/lib/docker/volumes -maxdepth 8 -type d -path "*/certificates/*/$HOST_IP" -name "$HOST_IP" 2>/dev/null | grep -q .; then
    break
  fi
  sleep 3
done
"$PREFIX/bin/sync-cert.sh" || true

# 4. systemd -----------------------------------------------------------
say "安装 systemd 单元"
install -m 0644 "$SRC/deploy/shot-cam.service" /etc/systemd/system/shot-cam.service
install -m 0644 "$SRC/deploy/shot-cert-sync.service" /etc/systemd/system/shot-cert-sync.service
install -m 0644 "$SRC/deploy/shot-cert-sync.timer" /etc/systemd/system/shot-cert-sync.timer
systemctl daemon-reload
systemctl enable --now shot-cert-sync.timer >/dev/null 2>&1 || true
systemctl enable --now shot-cam.service

# 5. 自检 --------------------------------------------------------------
say "等待服务就绪"
ok=0
for i in $(seq 1 20); do
  if curl -fsS -k --max-time 3 "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done

TOKEN="$(python3 -c 'import json;print(json.load(open("'"$PREFIX"'/config.json"))["admin_token"])' 2>/dev/null || echo '?')"
echo
if [ "$ok" = 1 ]; then
  echo "✅ 安装完成"
else
  echo "⚠️ 服务未通过自检，请查看: journalctl -u shot-cam -n 50 --no-pager"
fi
cat <<EOF

  手机访问 : https://<公网IP>:$PORT/
  日志后台 : https://<公网IP>:$PORT/admin?token=$TOKEN
  日志目录 : $PREFIX/logs
  管理 token: $TOKEN

  卸载: sudo $PREFIX/bin/uninstall.sh   （或在仓库里执行 deploy/uninstall.sh）
EOF
