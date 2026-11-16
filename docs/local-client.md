# 原生挂接原理与客户端兼容性

本文档说明 OpenQQ 如何在不依赖 Electron `--inspect` 端口、不修改 QQ 客户端文件的前提下，对 Windows x64 与 Linux x64/arm64 QQ NT 客户端进行环境校验与原生会话接入。

## 安装目录与二进制兼容性检查

在配置校验、`npm run doctor` 以及启动前的 `inspectQQ()`（位于 `src/qq.mjs`）阶段，OpenQQ 会对目标安装目录执行只读检查：

### Windows x64

1. **目录与版本元数据**：安装根目录下要有 `QQ.exe` 和 `versions/config.json`；当前版本目录 `versions/<版本>/` 下要有 `QQNT.dll`、`resources/app/package.json` 和 `resources/app/wrapper.node`。`package.json` 里的版本必须与 `versions/config.json` 的 `curVersion` 一致，`eleArch` 必须是 `x64`。
2. **目录结构校验**：验证活动资源目录及入口指针均解析在 QQ 安装根目录以内，防止路径逃逸。
3. **x64 PE 导出表解析（`readPE64Info`）**：
   - 解析 `QQNT.dll` 的 PE32+ 头确认架构为 `x64`（`Machine === 0x8664`），并读取导出表验证包含关键符号：
     - `qq_magic_napi_register`
     - `napi_get_global`、`napi_set_named_property`、`napi_create_string_utf8`、`napi_run_script`
     - `napi_open_escapable_handle_scope`、`napi_close_escapable_handle_scope`、`napi_escape_handle`
     - `napi_is_exception_pending`、`napi_get_and_clear_last_exception`
   - 解析当前版本目录下的 `wrapper.node` 确认同样为有效的 `x64` 二进制文件。

### Linux x64 / arm64

1. **目录与版本元数据**：安装根目录（默认 `/opt/QQ`）下要有 `qq` 可执行文件、`resources/app/package.json` 和 `resources/app/wrapper.node`；若存在热更新目录（`$XDG_CONFIG_HOME/QQ/versions/` 或 `~/.config/QQ/versions/`）中的有效 `wrapper.node`，会在启动时优先匹配对应路径。
2. **目录结构校验**：通过 `realpathSync` 确认主程序、应用目录与 `wrapper.node` 均位于目标目录之内。
3. **ELF64 动态符号表解析（`readELF64Info`）**：
   - 解析 `qq` 的 ELF64 头与 `.dynsym` / `.dynstr` 确认架构为 `x64`（`EM_X86_64`）或 `arm64`（`EM_AARCH64`），并验证上述全部 `qq_magic_napi_register` 与 N-API 导出符号存在。
   - 解析 `wrapper.node` 确认其架构与主程序一致。
4. **Electron Fuses 只读状态**：两个平台均支持读取运行时二进制（`QQNT.dll` / `qq`）中的 `electron_fuses` 标志位，用于诊断客户端运行时安全选项，读取异常时降级为空而不中断正常启动探测。

### 版本兼容策略

- **已测试版本**：`9.9.33-52230`、`9.9.37-54395`（Windows x64，`targetMatch: true`）。
- **其他同平台 QQ NT 构建**：只要满足 `x64`（Windows / Linux）或 `arm64`（Linux）架构并包含上述所需 N-API 导出和 `qq_magic_napi_register`，即判定为 `supported: true` 允许启动，启动时会输出非基准版本提示，提醒结合运行诊断或 WebUI 核对事件收发情况。

## N-API 原生挂接机制

即使 QQ NT 启用 Electron Fuses 禁用调试参数，仍需通过 `QQNT.dll`（Windows）或 `qq`（Linux）导出的 `qq_magic_napi_register` 与 Node N-API 函数向原生插件 `wrapper.node` 注册与暴露核心业务对象。

### Windows（`launch.cpp` + `bootstrap.cpp`）

1. **标准输入传参**：Node 主进程创建命名管道（`src/ipc.mjs`）及一次性随机会话令牌，将 QQ、wrapper、自有 DLL 路径和脚本作为四行 UTF-8 数据传给 `native/bin/openqq-launch.exe`。脚本中的路径与令牌经过 JSON 转义，凭据不进入命令行或临时文件。
2. **加载前拦截**：`native/launch.cpp` 使用 `CreateProcessW(DEBUG_ONLY_THIS_PROCESS)` 拉起 QQ，在 DLL 加载事件中解析 `QQNT.dll` 的导出，并为各线程设置一次性的硬件执行断点。根据初始化回调所属模块的规范化文件路径，只选择配置指定的 wrapper。
3. **无调试端口会话接入**：在 wrapper 初始化回调入口，启动器暂挂该线程，通过系统 `LoadLibraryW` 加载 `openqq-bootstrap.dll`，随后将回调入口转交 DLL。DLL 先调用原始初始化函数，再使用 QQ 自身的 N-API 执行 `native/session.cjs`；脚本绑定原生服务的调用与事件回调，导出对象通过 escapable handle scope 安全返回。原始初始化异常保留，桥接脚本新增的异常会清理并上报。
4. **脱离与清理**：启动器清除硬件断点并脱离调试。超时、取消和初始化失败也执行清理并恢复暂挂线程。自有 DLL 与少量配置内存保留到 QQ 退出；无需持续运行调试器。

### Linux（`launch_linux.cpp` + `bootstrap_linux.cpp`）

1. **匿名管道与 `LD_PRELOAD`**：Node 主进程在 `0700` 权限临时目录下创建 Unix Domain Socket（`0600`）与一次性随机会话令牌，经标准输入传给 `native/bin/openqq-launch`。启动器校验目标文件的 ELF64 结构后，创建仅供该直系子进程读取的配置管道与状态管道，通过 `LD_PRELOAD` 预加载 `native/bin/openqq-bootstrap.so` 并拉起 `qq`。
2. **启动器构造清理**：`openqq-bootstrap.so` 在进入 QQ 的 `main()` 前于构造函数内读取并关闭配置管道，立即清理 `OPENQQ_BOOTSTRAP_FD`、`OPENQQ_STATUS_FD` 并从 `LD_PRELOAD` 移除自身，同时通过 `FD_CLOEXEC` 与 `pthread_atfork` 保证 Chromium 派生出的子进程（GPU / 渲染 / Zygote）不继承状态描述符或触发挂接。
3. **非侵入式拦截 `wrapper.node`**：当主进程 `dlopen` 加载目标 `wrapper.node` 时，`openqq-bootstrap.so` 通过拦截 `dlopen` 与 `qq_magic_napi_register`（在 `qq_magic_napi_register` 由主程序导出时配合单指令 `SIGTRAP` 捕获模块注册并立即还原指令字节，兼容 `x86_64` 与 `aarch64`），包装目标模块初始化函数并执行 `native/session.cjs`。不依赖 `CAP_SYS_PTRACE`，可在默认权限的 Docker 容器中直接运行。
4. **脱离与清理**：脚本返回并完成 `bootstrapped` 上报后，状态管道关闭，启动器以 `0` 退出并让 QQ 继续独立运行。
5. **结构化事件桥接**：两个平台均通过 `src/ipc.mjs` 接收内部事件帧，由 `src/onebot.mjs` 统一校验、映射消息 ID 并按 OneBot v11 协议格式分发至终端、WebUI 和 WebSocket 连接。

## 环境自动探测逻辑

`src/env.mjs` 提供跨环境自动查找能力：

- **QQ NT 查找**：Windows 依次检查 `OPENQQ_QQ_ROOT`、注册表卸载与安装键及常见盘符目录；Linux 检查 `OPENQQ_QQ_ROOT`、`/opt/QQ`、`/usr/lib/qq`、`/usr/share/qq` 等常见路径及 `PATH` 中的符号链接目标。
- **进程检测**：Windows 使用 `tasklist.exe`；Linux 只读扫描 `/proc/<pid>/exe`、`comm` 与 `cmdline` 判断是否有 `qq` 进程在运行，不依赖外部命令。
- **原生组件检查**：Windows 检查 `native/bin/openqq-launch.exe` 与 `openqq-bootstrap.dll`；Linux 检查 `native/bin/openqq-launch` 与 `openqq-bootstrap.so`。未找到组件时提示运行 `npm run build:native`。
