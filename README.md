<p align="center"><img src="web/logo.svg" alt="OpenQQ" width="96" height="96"></p>

<h1 align="center">OpenQQ</h1>

<p align="center">
  <a href="https://github.com/feijx3/OpenQQ/actions/workflows/ci.yml"><img src="https://github.com/feijx3/OpenQQ/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
</p>

> [!WARNING]
> 非官方项目，与腾讯无关。挂接 QQ 客户端可能违反《QQ 软件许可及服务协议》，账号有被限制或封禁的风险。请只在自己的账号和设备上用于学习研究，风险自负。

Windows x64 与 Linux（x64 / arm64）QQ NT 的 OneBot v11 桥接，同时支持 Docker 容器化部署。通过 C++ 原生启动器在 QQ 注册原生模块的地方（`qq_magic_napi_register`）挂接会话，不开启 Electron 的 `--inspect` 端口，也不修改 QQ 安装目录中的文件。Windows 原生部分仅依赖系统自带的 UCRT；Linux 原生部分使用 `LD_PRELOAD` 预加载引导库并在加载目标 `wrapper.node` 时注入会话。OneBot、WebUI 和会话逻辑为 Node.js / JavaScript。

## 功能

- OneBot v11：正向 WebSocket 服务端（Bearer Header 或 `access_token` 查询参数鉴权，鉴权失败有限流），反向 WebSocket 客户端（最多 8 个目标，QQ 会话就绪时断线后每 3 秒重连一次）。心跳固定每 15 秒一次，目前不能配置。
- 启动前检查：Windows 扫描注册表和常见路径找到 QQ NT，解析 `QQNT.dll`、`wrapper.node` 的 x64 PE 导出表；Linux 探测 `/opt/QQ` 等路径并解析 `qq`、`wrapper.node` 的 ELF64 动态符号表，确认 `qq_magic_napi_register` 等 N-API 符号都在。
- 发送与管理：文本、CQ 码、@、表情、图片、语音、视频、文件、骰子、猜拳、引用回复；撤回、踢人、禁言、全员禁言、管理员、群名片、群名、退群、处理入群/好友申请、点赞，以及群和成员查询。详见 [docs/actions.md](docs/actions.md)。
- WebUI：默认只监听 `127.0.0.1`（容器内可通过 `--web-host 0.0.0.0` 配合本机端口映射），每次启动生成临时访问密钥。有配置向导（`/setup`）和控制台：概览（会话、吞吐、连接状态）、按会话收发消息、事件流、OneBot 动作调试、运行日志，以及账号、连接和设置管理。
- Docker：内置 [Dockerfile](Dockerfile) 与 [compose.yaml](compose.yaml)，通过 `Xvfb` + 可选 `noVNC` 支持无头扫码与滑块登录。
- 终端：交互模式支持命令补全、历史记录和 `/verbose`、`/clear`、`/quit`；接管道或加 `--json` 时输出 OneBot 的 JSON Lines。

## 界面预览

以下截图为模拟数据，非真实账号。

| 概览 | 消息 |
| --- | --- |
| ![概览](docs/images/overview.png) | ![消息](docs/images/messages.png) |
| **事件流** | **连接管理** |
| ![事件](docs/images/events.png) | ![连接](docs/images/connections.png) |

## 环境要求

- Windows 10 / 11 x64（QQ NT 9.x，已测试 `9.9.33-52230` 和 `9.9.37-54395`）或 Linux x64 / arm64（官方 Linux QQ NT，默认路径 `/opt/QQ`）或 Docker
- 其他带完整 N-API 导出的同平台 QQ NT 构建也能启动，但会提示该版本没有完整实机验证。
- Node.js >= 22
- 从源码构建需要本机已有 CMake 和 C++17 编译器（Windows 用 LLVM-MinGW / MinGW + Ninja 或 Visual Studio；Linux 用 `g++` / `clang++`，可选 `ninja`）。发布包里已有编译好的原生组件，不需要编译器。

## 快速开始

Docker 部署请直接看 [docs/docker.md](docs/docker.md)（`docker compose up -d --build`）。

源码克隆并构建：

```powershell
git clone https://github.com/feijx3/OpenQQ.git
cd OpenQQ
npm install
npm run build
```

检查本机环境。这条命令只读，输出 JSON：QQ 目录和版本、原生导出是否齐全、启动器状态、QQ 是否正在运行。

```powershell
npm run doctor
```

找不到 QQ 时，用环境变量指定目录：

```powershell
$env:OPENQQ_QQ_ROOT = "D:\Programs\QQNT"
npm run doctor
```

启动前先完全退出 QQ，然后：

```powershell
npm start
```

没有 `config/openqq.json` 时会进入浏览器里的配置向导（也可以随时用 `npm run webui` 打开）。终端会打印一个一次性的本机地址，形如 `http://127.0.0.1:17860/setup#token=...`。在向导里确认 QQ 目录、正向/反向 WebSocket 和密钥，保存后 OpenQQ 会拉起 QQ。

不想用向导的话：

```powershell
npm run init                                              # 在终端里交互生成配置
npm start -- --qq-root "C:\Program Files\Tencent\QQNT"    # 临时指定 QQ 目录
```

也可以把 `config/openqq.example.json` 复制成 `config/openqq.json` 再改。

在 QQ 窗口里正常登录，终端和控制台出现「QQ 会话就绪」后，机器人框架就能连上来了。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run doctor` | 检查 QQ NT、原生启动器和路径兼容性 |
| `npm run init` | 在终端里交互生成 `config/openqq.json` |
| `npm run webui` | 只启动配置向导（预览模式） |
| `npm start` | 启动 OpenQQ、WebUI 和 OneBot WebSocket，并挂接 QQ |
| `npm run bot` | 运行示例机器人（需要 `ONEBOT_TOKEN`） |
| `npm run build` | 编译原生组件并打包 WebUI（`start`、`webui`、`test` 会自动执行） |
| `npm run build:native` | 用本机工具链编译启动器、DLL 和模拟宿主 |
| `npm run test:native` | 编译并测试原生挂接链路 |
| `npm test` | 运行 Node.js 单元测试和集成测试 |

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/` | Node 主进程：配置、环境探测、OneBot 网络层、终端和 WebUI 服务 |
| `native/` | C++ 启动器和 DLL，以及在 QQ 里运行的 JavaScript（会话、事件、动作） |
| `ui/` | WebUI 源码（React + TypeScript、Tailwind CSS、Radix UI），构建产物输出到 `web/` |
| `web/` | WebUI 静态入口页和构建产物 |
| `config/` | 配置示例；本地的 `openqq.json` 不进版本控制 |
| `docs/` | 接入、动作、事件和原生挂接的文档 |
| `examples/` | OneBot 机器人示例 |
| `test/` | Node 测试和原生模拟宿主 |

## 安全相关

- WebUI 默认只绑定 `127.0.0.1`。访问密钥用 `timingSafeEqual` 比较；页面加载后立刻用 `history.replaceState` 清掉 URL 片段里的密钥，之后只放在当前标签页的 `sessionStorage`。
- 路径和会话脚本通过标准输入交给原生启动器（`openqq-launch.exe` / `openqq-launch`），包括管道/Unix Socket 路径和一次性令牌，所以它们不会出现在进程命令行里；Linux 端通过仅父子可见的匿名管道将配置传入 `openqq-bootstrap.so` 后立即关闭描述符并清理环境变量，不进入环境变量或子进程。
- 配置文件拒绝 UNC 路径和控制字符。启动器只从项目目录加载，并通过文件句柄或 `realpath` 确认 QQ、wrapper 和原生模块的真实路径；IPC Unix Socket 置于 `0700` 权限临时目录内且仅对当前用户可读写（`0600`）。
- OneBot 正向 WebSocket 服务端会限制单个 IP 的连续鉴权失败：60 秒内超过 20 次返回 429。WebUI 的访问密钥是每次启动随机生成的 256 位值，没有单独的失败限流，只限制同时执行的动作数。以 `//` 开头的请求地址会被两个服务拒绝，反向连接不跟随重定向。

## 测试

```powershell
npm test
```

`npm test` 会先编译原生组件，其中包含用模拟宿主跑的挂接测试，不会启动本机安装的 QQ。只跑原生部分：

```powershell
npm run test:native
```

## 文档

- [Linux 与 Docker 部署指南](docs/docker.md)
- [机器人接入与示例配置](docs/connect.md)
- [支持的 OneBot 动作与终端交互](docs/actions.md)
- [事件格式、扩展字段与已知限制](docs/events.md)
- [原生挂接原理与客户端兼容性检查](docs/local-client.md)

## 参与贡献

欢迎提 Issue 和 Pull Request，提交前请看 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[GNU Affero General Public License v3.0 或更高版本](LICENSE)。基于本项目修改并通过网络提供服务时，须向用户提供对应源代码。

## 参考

- [OneBot v11 协议规范](https://github.com/botuniverse/onebot-11)
- [Node-API (N-API) 头文件声明](https://github.com/nodejs/node/blob/v22.16.0/src/node_api.h)
