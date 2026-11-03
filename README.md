# shot · 手机摄像头变焦测试页

临时服务：在手机上打开一个 HTTPS 页面，点击按钮调用后置摄像头，测试 **0.5x / 1.0x / 2.0x / 3.0x / 5.0x** 是否可用，并自动把过程日志和画面截图回传到服务器。

主要针对 **华为 HarmonyOS（Pura 70 / Pura 80 等）**，用于确认浏览器是否暴露摄像头 `zoom` 能力、0.5x 超广角能否被网页调用——**大概率不行**，这里就是把"不行"的证据（能力范围、报错、画面视野）完整记录下来。

## 在线地址

| 用途 | 地址 |
| --- | --- |
| 手机测试页 | <https://8.137.124.107:8082/> |
| 日志后台 | `https://8.137.124.107:8082/admin?token=<见服务器 /opt/shot/config.json>` |

> 必须用 **HTTPS** 打开。浏览器规定非安全上下文（HTTP）下 `navigator.mediaDevices` 不存在，摄像头根本调不起来——这也是为什么服务跑在 8082 的 TLS 上，而不是普通 HTTP。

## 页面上能做什么

- **开始测试**：申请后置摄像头，打印 `getCapabilities()` / `getSettings()` / `getSupportedConstraints()`，并判断 `zoom` 能力区间
- **0.5x ~ 5x 按钮**：优先走原生 `applyConstraints({zoom})`（含 `advanced` 写法兜底），失败则退化为数码裁切，并在角标里标出「原生 / 数码 / 不支持」
- **一键全流程测试**：自动依次切 0.5/1/2/3/5，每档截图上传，一次点完就能收工
- **切换摄像头**：部分机型把超广角暴露成独立的 `videoinput`，可以逐个试
- **拍照存证**：把当前画面（含数码裁切）截成 JPEG 上传
- **诊断信息 / 运行日志**：可复制、可本地下载，网络不通时也能把 JSON 发出来
- 日志自动批量上传，失败自动重试，页面切后台/关闭时用 `sendBeacon` 补传

## 架构

```
手机浏览器 ──HTTPS(8082, Let's Encrypt IP 证书)──> shot-cam (Python 标准库, systemd)
                                                     ├── /            测试页
                                                     ├── /api/log     日志上传(JSONL)
                                                     ├── /api/frame   截图上传(JPEG)
                                                     └── /admin?token 日志后台/打包下载
证书来源: /opt/stream 的 Caddy 容器为 8.137.124.107 申请 Let's Encrypt 短期证书(6 天)
          → 由 systemd timer 每 10 分钟同步到 /opt/shot/tls
```

后端零第三方依赖（Python 3.12 标准库），只有一个 systemd 服务 + 一个证书同步定时器。

## 部署

见 [docs/DEPLOY.md](docs/DEPLOY.md)。一句话版：

```bash
rsync -az ./ admin@8.137.124.107:/tmp/shot-src/
ssh admin@8.137.124.107 'sudo bash /tmp/shot-src/deploy/install.sh'
```

## 取日志

```bash
# 方式一：本地脚本（推荐）
./scripts/fetch-logs.sh

# 方式二：浏览器后台打包下载
https://8.137.124.107:8082/admin?token=xxx  →  下载全部（zip）
```

日志结构：`/opt/shot/logs/<日期>/<会话ID>.jsonl` 与 `<日期>/frames/*.jpg`，一行一条 JSON，包含 UA、IP、能力、每次变焦请求与结果。

## 卸载

见 [docs/UNINSTALL.md](docs/UNINSTALL.md)。一句话版：

```bash
ssh admin@8.137.124.107 'sudo /opt/shot/bin/uninstall.sh'
```

## 测试方法

见 [docs/HUAWEI-TEST.md](docs/HUAWEI-TEST.md)。

## 目录

```
app/main.py            HTTP(S) 服务：静态页 + 日志/截图接收 + 后台
app/static/            前端页面
deploy/install.sh      安装（root）
deploy/uninstall.sh    完整卸载（root）
deploy/caddy_site.py   管理 Caddyfile 里的 IP 证书站点块
deploy/sync-cert.sh    从 Caddy 容器同步证书
deploy/*.service|timer systemd 单元
scripts/fetch-logs.sh  本地拉取日志
docs/                  部署/卸载/测试文档
```
