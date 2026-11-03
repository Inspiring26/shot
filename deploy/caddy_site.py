#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""管理 /opt/stream/Caddyfile 中 shot 测试站（仅为签 IP 证书）的配置块。

用法:
    caddy_site.py ensure   # 写入/更新配置块并 reload Caddy
    caddy_site.py remove   # 删除配置块并 reload Caddy
    caddy_site.py status   # 打印是否已配置
"""
import os
import re
import subprocess
import sys
import time

CADDYFILE = os.environ.get("CADDYFILE", "/opt/stream/Caddyfile")
CONTAINER = os.environ.get("CADDY_CONTAINER", "stream-caddy")
HOST_IP = "8.137.124.107"
BEGIN = "# >>> shot-cam-test BEGIN (managed by shot deploy scripts) >>>"
END = "# <<< shot-cam-test END <<<"

BLOCK = f"""
{BEGIN}
https://{HOST_IP} {{
\ttls {{
\t\tissuer acme {{
\t\t\tprofile shortlived
\t\t}}
\t}}
\trespond "shot-cam cert holder" 200
}}
{END}
"""


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_inplace(path, content):
    """原地覆盖写入，保持 inode 不变（docker 的 bind mount 依赖 inode）。"""
    with open(path, "r+", encoding="utf-8") as f:
        f.seek(0)
        f.write(content)
        f.truncate()


def strip_blocks(text):
    text = re.sub(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", "", text, flags=re.S)
    # 兼容没有标记的旧块：从 "https://8.137.124.107 {" 到下一个顶格 "}"
    text = re.sub(r"https://" + re.escape(HOST_IP) + r"\s*\{.*?\n\}\n?", "", text, flags=re.S)
    return text


def reload_caddy():
    if not os.path.exists("/var/run/docker.sock"):
        print("caddy_site: 未找到 docker，跳过 reload")
        return
    try:
        subprocess.run(
            ["docker", "exec", CONTAINER, "caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
            check=True, capture_output=True, text=True)
        print("caddy_site: caddy reloaded")
    except FileNotFoundError:
        print("caddy_site: 没有 docker 命令，跳过 reload")
    except subprocess.CalledProcessError as exc:
        print("caddy_site: caddy reload 失败:\n" + (exc.stderr or "") + (exc.stdout or ""), file=sys.stderr)
        raise


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if not os.path.exists(CADDYFILE):
        print(f"caddy_site: 找不到 {CADDYFILE}", file=sys.stderr)
        return 2

    text = read(CADDYFILE)
    has = BEGIN in text

    if action == "status":
        print("configured" if has else "absent")
        return 0

    if action == "ensure":
        if not has:
            backup = f"{CADDYFILE}.bak.shot.{time.strftime('%Y%m%d%H%M%S')}"
            with open(backup, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"caddy_site: 已备份到 {backup}")
        new = strip_blocks(text).rstrip("\n") + "\n" + BLOCK
        write_inplace(CADDYFILE, new)
        reload_caddy()
        print("caddy_site: 已写入测试站配置")
        return 0

    if action == "remove":
        new = strip_blocks(text)
        write_inplace(CADDYFILE, new)
        reload_caddy()
        print("caddy_site: 已移除测试站配置")
        return 0

    print(f"unknown action: {action}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
