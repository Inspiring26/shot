# 部署说明

目标机器：`8.137.124.107`（Ubuntu 24.04，已有 Docker + Caddy 容器 `stream-caddy` 占用 80/443）。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| SSH | `ssh admin@8.137.124.107` 可免密登录，且 `sudo` 免密 |
| 端口 | 安全组已放行 **8082/TCP**（本服务只监听 8082） |
| 80 端口 | 公网可达，Caddy 正在监听（Let's Encrypt 用 HTTP-01/TLS-ALPN 验证 IP 归属） |
| Python | `/usr/bin/python3` ≥ 3.10（Ubuntu 24.04 自带 3.12） |
| Caddy | `/opt/stream/Caddyfile` 存在，容器名 `stream-caddy`（仅用于申请 IP 证书） |

## 1. 上传并安装

```bash
cd shot
rsync -az --delete --exclude 'logs/' --exclude '.git/' ./ admin@8.137.124.107:/tmp/shot-src/
ssh admin@8.137.124.107 'sudo bash /tmp/shot-src/deploy/install.sh'
```

安装脚本会：

1. 创建系统用户 `shotcam`（`/usr/sbin/nologin`）
2. 拷贝程序到 `/opt/shot`，生成 `config.json`（含管理 token，权限 0600）
3. 用 `deploy/caddy_site.py ensure` 在 `/opt/stream/Caddyfile` 追加一个**带标记**的站点块，并 `caddy reload`：
   ```
   # >>> shot-cam-test BEGIN (managed by shot deploy scripts) >>>
   https://8.137.124.107 {
       tls { issuer acme { profile shortlived } }
       respond "shot-cam cert holder" 200
   }
   # <<< shot-cam-test END <<<
   ```
   `profile shortlived` 是 Let's Encrypt 目前唯一允许 **IP 地址** 的证书 profile（约 6 天有效，Caddy 自动续期）。
4. 把证书同步到 `/opt/shot/tls/{fullchain.pem,privkey.pem}`
5. 安装并启动 `shot-cam.service`（8082，HTTPS）与 `shot-cert-sync.timer`（每 10 分钟同步证书）
6. 自检 `https://127.0.0.1:8082/healthz`

## 2. 验证

```bash
curl -sS https://8.137.124.107:8082/healthz          # ok
curl -sS -o /dev/null -w '%{http_code}\n' https://8.137.124.107:8082/   # 200
systemctl status shot-cam --no-pager
```

证书应为 `Let's Encrypt` 签发、SAN 为 `IP Address:8.137.124.107`：

```bash
echo | openssl s_client -connect 8.137.124.107:8082 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
```

## 3. 更新代码

改完代码重复第 1 步即可（install.sh 幂等：覆盖 `/opt/shot/app`、重写 systemd 单元、重启服务，不会重新生成 token）。

## 4. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面上 `navigator.mediaDevices` 为空 | 用 HTTP 打开了；必须 `https://` |
| 证书报错 / 不受信任 | 证书 6 天有效，检查 `shot-cert-sync.timer` 与 Caddy 是否续期：`docker logs stream-caddy \| grep 8.137` |
| 服务起不来 `Permission denied` | 拷贝的文件权限被带到 600；安装脚本会 `chmod -R a+rX`，重跑 install.sh 即可 |
| Caddy reload 后配置没变 | bind mount 绑的是 inode；`caddy_site.py` 已用原地写入，若仍异常执行 `docker restart stream-caddy` |
| Caddy 报 `Default profile does not permit IP address identifiers` | 漏了 `profile shortlived` |

## 5. 证书说明

- IP 证书无法用域名证书替代（本项目没有域名）。
- `shortlived` 证书有效期约 6 天（160 小时），Caddy 在剩余约 1/3 时自动续期；`shot-cert-sync.timer` 每 10 分钟把新证书同步给服务，服务自身在证书文件 mtime 变化后自动重载，无需重启。
- 因此这个服务**不适合长期运行**，只适合临时测试；测完请按 [UNINSTALL.md](UNINSTALL.md) 卸载。
