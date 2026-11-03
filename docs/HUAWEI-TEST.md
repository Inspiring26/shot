# 华为鸿蒙测试指引

## 目标

确认在 **HarmonyOS 手机浏览器** 里，网页能否：

1. 打开后置摄像头（`getUserMedia`）
2. 通过 `MediaStreamTrack.applyConstraints({ zoom })` 在 0.5x / 1x / 2x / 3x / 5x 之间切换
3. 特别是 **0.5x 超广角** 是否可达（预期：多数机型不能）

## 准备

- 手机：Pura 70 / Pura 80 / Mate 系列均可
- 浏览器：**华为浏览器** 或 **Chrome**。微信/QQ 内置浏览器也测一轮，但单独记录（内核不同）
- 网络：能访问 `https://8.137.124.107:8082/`（4G/5G 或 Wi-Fi 都行）
- 打开页面后点「开始测试」，在弹出的权限框选择 **允许**

## 操作步骤

1. 打开 <https://8.137.124.107:8082/>，等「诊断信息」出现内容。
2. 点 **开始测试** → 允许相机。
3. 看「诊断信息」里的两行：
   - **支持 zoom 约束**：`是 / 否`
   - **zoom 能力**：`min=… max=… step=…` 或 `无（浏览器未暴露）`
4. 依次点 **0.5x → 1.0x → 2.0x → 3.0x → 5.0x**，每个都停 1 秒，观察画面有没有变化、角标显示什么。
5. 点 **一键全流程测试**（自动跑一遍并每档截图上传，约 8 秒）。
6. 如果有多个后置摄像头，在「摄像头」下拉里逐个切换后重复第 4、5 步。
7. 点 **停止**（日志会自动上传）。

> 画面角标含义：`原生 0.5x` = 硬件/驱动真的切了倍率；`数码 2x（非原生）` = 只是裁切放大；`不支持 0.5x` = 浏览器拒绝了该倍率。

## 关键判读

| 记录字段 | 含义 |
| --- | --- |
| `zoomCapability` | `getCapabilities().zoom` 的 `{min,max,step}`；`null` 表示浏览器没暴露 |
| `zoom.request` / `zoom.apply_ok` / `zoom.apply_err` | 每次切倍率的请求与结果，报错含 `name`（如 `OverconstrainedError`） |
| `zoom.result.final` | 最终判定：`native` / `digital` / `unsupported` |
| `camera.started` | 实际拿到的分辨率、facingMode、deviceId |
| `devices.list` | 枚举到的摄像头数量与标签（超广角是否为独立设备） |

### 典型结论

- **`min >= 1`**：网页只能 1x 起步，0.5x 用不了——这是绝大多数安卓/鸿蒙浏览器的现状。
- **`zoom` 为 null**：浏览器完全没适配 Camera2 的 zoom，只能数码裁切。
- **`applyConstraints` 报 `OverconstrainedError`**：能力声明了但实际不支持，或省略了 `advanced` 写法。
- **画面黑屏/卡住**：驱动或浏览器对超广角流不支持，日志里会有 `NotReadableError` / `TrackStartError`。

## 每组测试记录模板

```
机型：            （如 Pura 80 Ultra）
系统：HarmonyOS   （设置 → 关于手机）
浏览器：           （华为浏览器 版本 / Chrome 版本）
会话 ID：          （页面底部 “会话” 后面那串）
zoom 能力：        min=  / max=  / step=
0.5x：原生 / 数码 / 不支持 / 黑屏
1.0x：
2.0x：
3.0x：
5.0x：
多个后置摄像头：是/否，逐个结果
备注：
```

## 日志在哪

- 服务器：`/opt/shot/logs/<日期>/<会话ID>.jsonl`，截图在 `<日期>/frames/`
- 后台：`https://8.137.124.107:8082/admin?token=<见 /opt/shot/config.json>`
- 本地拉取：`./scripts/fetch-logs.sh`
- 网络异常时：页面上「运行日志 → 下载」会把 JSON 存到手机，可直接发出来

## 需要注意

- 页面必须 **HTTPS** 打开，`http://` 打不开摄像头是浏览器安全限制，不是 bug。
- 数码变焦只是把画面中心裁切放大，**不能**证明手机有 0.5x 超广角；要看 `zoom.result.native` 是否为 true。
- 部分鸿蒙版本会把「拍照」和「预览」用不同流，`getUserMedia` 拿到的可能已经是裁切后的画面，日志里的分辨率变化可以佐证。
