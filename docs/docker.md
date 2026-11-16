# Linux 与 Docker 部署指南

除 Windows x64 外，OpenQQ 也支持在 **Linux（x64 / arm64）** 和 **Docker** 中运行官方 Linux QQ NT 客户端，依然不依赖 Electron `--inspect` 调试端口，也不修改 `/opt/QQ` 安装目录中的文件。

## 在 Linux 宿主机运行

### 环境要求

- Linux `x64`（x86_64）或 `arm64`（aarch64）
- 官方 Linux QQ NT（通常安装于 `/opt/QQ`）
- Node.js >= 22
- 从源码构建需要 `cmake`、`g++`（或 `clang++`）以及可选的 `ninja`
- 语音与视频转码建议安装 `ffmpeg`

### 安装与启动

```bash
git clone https://github.com/feijx3/OpenQQ.git
cd OpenQQ
npm install
npm run build
```

检查本机 QQ 与原生引导器：

```bash
npm run doctor
```

如果 QQ 不在 `/opt/QQ`，可通过环境变量指定：

```bash
export OPENQQ_QQ_ROOT="/path/to/QQ"
npm run doctor
```

确认桌面上已完全退出正在运行的 QQ，然后启动：

```bash
npm start
```

- 首次运行且没有 `config/openqq.json` 时，会进入浏览器配置向导（`http://127.0.0.1:17860/setup#token=...`）。
- 若在桌面环境遇到 Electron 沙盒限制，可附加 `-- --no-sandbox` 或设置 `OPENQQ_QQ_NO_SANDBOX=1`（容器及 root 环境会自动附加 `--no-sandbox`）。

## 在 Docker 中运行

仓库根目录提供了 [Dockerfile](../Dockerfile)、[compose.yaml](../compose.yaml) 与容器入口脚本 [docker/entrypoint.sh](../docker/entrypoint.sh)。

容器内会自动启动：
- `Xvfb` 虚拟显示器（默认 `:99`）
- `x11vnc` + `noVNC`（默认端口 `6080`，仅在 `compose.yaml` 中绑定到 `127.0.0.1`，用于在浏览器里扫码或完成滑块验证）
- `ffmpeg` 与中文字体，满足图片/语音/视频发送和登录界面显示

### 使用 Docker Compose（推荐）

```bash
docker compose up -d --build
docker compose logs -f
```

1. **配置向导**：如果尚未生成 `./docker-data/config/openqq.json`，从日志中复制 `http://127.0.0.1:17860/setup#token=...` 在浏览器完成配置并点击「启动 OpenQQ」。
2. **扫码登录 QQ**：打开 `http://127.0.0.1:6080/vnc.html?autoconnect=true`，在虚拟桌面里的 QQ 窗口扫码或输入密码登录。登录态保存在 `./docker-data/qq`，后续重启容器无需重新扫码。
3. **关闭 VNC（可选）**：完成登录并启用自动登录后，可在 `compose.yaml` 中设置 `OPENQQ_VNC: "0"` 后重建容器，减少后台进程占用。

### 自动初始化配置（无交互启动）

如果希望容器首次启动时自动生成配置并直接拉起 QQ，可以在 `compose.yaml` 中配置环境变量：

```yaml
environment:
  OPENQQ_AUTO_INIT: "1"
  OPENQQ_ACCESS_TOKEN: "replace-with-at-least-16-random-ascii-chars"
  OPENQQ_WS_HOST: "0.0.0.0"
  OPENQQ_WS_PORT: "3001"
  # 可选：同时配置反向 WS
  # OPENQQ_REVERSE_WS_URL: "ws://host.docker.internal:8080/onebot/v11/ws"
  # OPENQQ_REVERSE_WS_TOKEN: ""
```

### 指定 Linux QQ 下载地址或跳过内置安装

构建镜像时，[docker/install-qq.mjs](../docker/install-qq.mjs) 默认会自动从官方清单获取对应架构（`amd64` / `arm64`）的最新 `.deb` 包安装到 `/opt/QQ`。如果当前网络无法访问官方 CDN，可手动传入下载地址：

```bash
docker build --build-arg QQ_DEB_URL="https://example.com/linuxqq.deb" -t openqq:latest .
```

如果希望自行挂载宿主机的 `/opt/QQ`，也可跳过构建期下载：

```bash
docker build --build-arg INSTALL_QQ=0 -t openqq:noqq .
docker run --rm -v /opt/QQ:/opt/QQ:ro openqq:noqq doctor
```

### Docker 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENQQ_CONFIG` | `/app/config/openqq.json` | 配置文件路径 |
| `OPENQQ_QQ_ROOT` | `/opt/QQ` | 容器内 QQ 安装目录 |
| `OPENQQ_WEB_PORT` | `17860` | WebUI 端口 |
| `OPENQQ_WEB_HOST` | `0.0.0.0` | WebUI 容器内监听地址（宿主机侧建议仅映射 `127.0.0.1`） |
| `OPENQQ_WEB_ALLOW_HOSTS` | 空 | 逗号分隔的额外允许 `Host` 头（仅在远程反代/隧道访问 WebUI 时填写） |
| `OPENQQ_VNC` | `1` | 是否启动 `fluxbox` + `x11vnc` + `noVNC` |
| `OPENQQ_VNC_PASSWORD` | 空 | 为 VNC 设置访问密码（推荐对外暴露时配置） |
| `OPENQQ_NOVNC_PORT` | `6080` | noVNC Web 访问端口 |
| `OPENQQ_AUTO_INIT` | `0` | 设为 `1` 时，若配置文件不存在则按环境变量自动初始化 |
| `OPENQQ_ACCESS_TOKEN` | 随机 | 自动初始化时使用的 OneBot 访问令牌 |
| `OPENQQ_WS_HOST` | `0.0.0.0` | 自动初始化时正向 WS 监听地址 |
| `OPENQQ_WS_PORT` | `3001` | 自动初始化时正向 WS 端口 |
| `OPENQQ_REVERSE_WS_URL` | 空 | 自动初始化时附加的反向 WS 地址 |
| `OPENQQ_REVERSE_WS_TOKEN` | 空 | 反向 WS 令牌 |

> [!CAUTION]
> 请勿将未加认证的 `17860`（WebUI）或 `6080`（noVNC）端口直接暴露到公网；默认 `compose.yaml` 仅将其绑定到宿主机的 `127.0.0.1`。远程服务器推荐使用 SSH 端口转发（例如 `ssh -L 17860:127.0.0.1:17860 -L 6080:127.0.0.1:6080 user@server`）。
