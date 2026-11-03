# 完整卸载

这个服务是**临时**的，测完按下面清单全部清掉，服务器上不会留残留。

## 一条命令

```bash
ssh admin@8.137.124.107 'sudo /opt/shot/bin/uninstall.sh'
```

（仓库里也有同一份：`ssh admin@8.137.124.107 'sudo bash /tmp/shot-src/deploy/uninstall.sh'`）

脚本会按顺序做：

| # | 动作 | 说明 |
| --- | --- | --- |
| 1 | 停止并删除 `shot-cam.service`、`shot-cert-sync.timer` | `disable --now` + 删除 `/etc/systemd/system/shot-*.service|timer` + `daemon-reload` |
| 2 | 备份日志到 `/root/shot-logs-<时间>.tar.gz` | 测完的原始数据不会丢 |
| 3 | 从 `/opt/stream/Caddyfile` 删除 `shot-cam-test` 标记块并 reload Caddy | 恢复成安装前的样子；`stream.weehaa.top` 不受影响 |
| 4 | 删除 Caddy 里为 `8.137.124.107` 申请的证书目录 | `/var/lib/docker/volumes/stream_caddy_data/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/8.137.124.107` |
| 5 | 删除 `/opt/shot`（程序、日志、证书副本、config.json） | |
| 6 | 删除系统用户 `shotcam` | |
| 7 | 删除 `/tmp/shot-src` | 安装用的临时拷贝 |

## 还需要手工做的

1. **阿里云安全组**：删除 8082/TCP 入方向规则（脚本不会动云平台配置）。
2. **Caddyfile 备份**：`/opt/stream/Caddyfile.bak.shot.*`、`Caddyfile.bak.camzoom.*` 可自行删除。
   ```bash
   ssh admin@8.137.124.107 'sudo rm -f /opt/stream/Caddyfile.bak.shot.* /opt/stream/Caddyfile.bak.camzoom.*'
   ```
3. **GitHub 仓库**：不再需要时删除 `Inspiring26/shot`。
4. **本地目录**：删除本仓库和 `scripts/fetch-logs.sh` 拉下来的日志目录。

## 卸载后核对

```bash
ssh admin@8.137.124.107 '
  ss -lntp | grep 8082 || echo "端口已释放"
  systemctl list-unit-files | grep shot || echo "无 shot 单元"
  id shotcam 2>/dev/null || echo "用户已删除"
  ls /opt/shot 2>/dev/null || echo "/opt/shot 已删除"
  grep -c "shot-cam-test" /opt/stream/Caddyfile || echo "Caddyfile 无残留"
  curl -s -m 3 http://127.0.0.1:8082/ || echo "本地 8082 已关闭"
'
```

公网侧：`curl -m 5 https://8.137.124.107:8082/` 应连接失败（安全组规则删除后）。

## 为什么卸载要动 Caddy

浏览器只允许在 **安全上下文（HTTPS）** 下调用摄像头，而本项目没有域名，只能给 IP 申请证书；Let's Encrypt 的 IP 证书必须走 ACME 验证，80/443 已被现有 Caddy 占用，所以借用它申请、续期，再把证书同步给本服务（8082）。

这带来了唯一的"跨项目耦合"：`/opt/stream/Caddyfile` 里的一段带标记配置。卸载脚本会精确删除这段，不影响 `stream.weehaa.top` 的原有配置。
