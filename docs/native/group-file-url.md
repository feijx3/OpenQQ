# 群文件下载直链的原生通道与 QQ 版本适配

本文说明 `get_group_file_url` 为什么需要原生通道、当前支持范围，以及如何为新的 QQ 版本补充适配。面向维护者和后续贡献者。

## 支持范围

| 平台 / QQ | `get_group_file_url`（无缓存 URL） | 其他功能 |
| --- | --- | --- |
| Windows x64，QQ `9.9.33-52230` | 支持，已实机验证 | 不受影响 |
| Windows x64，QQ `9.9.37-54395` | **未适配**，返回 `1500` | 不受影响 |
| Linux x64 / arm64，Docker | **未适配**，返回 `1500` | 不受影响 |

`src/qq.mjs` 的 `verifiedVersions` 表示“启动、登录、消息等主流程实机验证过”，**不表示每个 OneBot 动作都已验证**。本动作的支持范围以上表为准。

## 为什么需要原生通道

原来的实现等待 `RichMediaService.getGroupFileInfo()`：

```text
getGroupFileInfo(group, fileId)
→ info.fileInfo.downloadUrl / info.url
```

这个方法是元数据查询，不保证返回下载直链；在 `9.9.37-54395` 上它还会在动作的 15 秒总超时前不返回，最终表现为 `1501`。

群文件直链需要发送原始 OIDB 请求。QQ 对 `sendSsoCmdReqByContend` 的 JS 绑定会把参数转成 UTF-8 字符串，响应里的 `rsp` 也会经过 `napi_create_string_utf8`。OIDB 包包含 NUL 和任意非 UTF-8 字节，直接传 `Buffer` 会得到 `result=145`（请求包解析失败），响应也无法还原。

因此需要在 QQ 进程内替换这两处转换，但不改变 QQ 自身调用的行为。

## 协议

请求：

```text
OIDB command: 0x6D6
subcommand:   2
body.download:
  field 1: groupUin
  field 2: appId = 7
  field 3: busId（使用请求传入的 busid，默认 102）
  field 4: fileId
isReserved: 1
```

响应：

```text
download.field 5: downloadDns
download.field 6: downloadUrl（二进制，不是字符串）
URL = https://{downloadDns}/ftn_handler/{hex(downloadUrl)}/?fname=
```

协议实现见 [`native/group-file.cjs`](../../native/group-file.cjs)，结构已与 Lagrange.Core v1 的 `GroupFSDownloadService` / `OidbSvcTrpcTcp0x6D6_2Response` 交叉核对。不加载 NapCat 或 Lagrange 的运行时/原生文件。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| [`native/group-file.cjs`](../../native/group-file.cjs) | OIDB 编码/解析、URL 拼接、8 秒超时、错误诊断；不包含 QQ 内存地址 |
| [`native/packet.cpp`](../../native/packet.cpp) | 原生通道；`kPacketProfiles` 版本表；PE/签名/IAT 校验；安装 Hook；关联 `napi_deferred` |
| [`native/packet-native.cjs`](../../native/packet-native.cjs) | 首次真正需要下载地址时初始化；平台/版本门禁；失败后不重试 |
| [`native/extended.cjs`](../../native/extended.cjs) | `get_group_file_url`：缓存优先，再走原生通道 |

原生通道只在“缓存里没有 URL，且确实要发下载请求”时初始化；普通启动、登录和其他动作不会触发 Hook。

## 为新的 Windows x64 QQ 版本补充适配

### 1. 取得目标版本的 `wrapper.node`

路径通常是：

```text
<QQ 安装目录>\versions\<完整版本>\resources\app\wrapper.node
```

记录：

- SHA256；
- PE `TimeDateStamp`；
- PE `SizeOfImage`。

只作本地分析，不提交 QQ 文件。

### 2. 定位三处代码

使用 IDA / Ghidra / Binary Ninja：

1. **参数转换函数**（`stringConverter`）
   - 找 `napi_get_value_string_utf8` 的导入和 xref；
   - 定位把 JS 值写入 `std::string` 的函数；
   - 确认 `sendSsoCmdReqByContend` 的绑定在转换 `data` 参数时使用这个函数。
2. **响应回调**（`responseCallback`）
   - 找构造 `{ result, errMsg, rsp }` 的函数；
   - 它通常同时调用 `napi_create_object`、`napi_set_named_property`、`napi_resolve_deferred` 等；
   - 函数入口就是 Hook 点。
3. **响应字符串创建点**（`responseStringCall`）
   - 在响应回调内找到生成 `rsp` 的那条 `call qword ptr [rip+disp]`（机器码 `FF 15 xx xx xx xx`）；
   - 它必须指向 `napi_create_string_utf8` 的 IAT 槽；
   - 调用点地址和 6 字节机器码都要记录。

### 3. 核对对象布局

在响应回调里确认：

- 回调对象 `+0x10` 指向共享 context；
- context `+0x20` 是 `napi_deferred`（QQ 在结算后会清空）；
- 字符串是 24 字节 libc++ 布局：
  - bit 0 为 long flag；
  - 短字符串长度右移 1；
  - 长字符串长度在 `+8`；
  - 数据指针在 `+16`。

如果这些偏移或布局不同，现有引擎不能只靠改地址复用，需要先扩展实现。

### 4. 在版本表中增加条目

编辑 [`native/packet.cpp`](../../native/packet.cpp) 里的 `kPacketProfiles`：

```cpp
inline constexpr unsigned char kXXXXStringConverterPrologue[] = {
    /* 完整序言字节 */};
inline constexpr unsigned char kXXXXResponseCallbackPrologue[] = {
    /* 完整序言字节 */};
inline constexpr unsigned char kXXXXResponseStringCall[] = {
    0xff, 0x15, /* disp32 的 4 个字节 */};

inline constexpr PacketProfile kPacketProfiles[] = {
    // ... 现有 52230 条目 ...
    {
        "9.9.xx-xxxxx",   // 精确版本号，不做相邻版本兼容
        0x00000000,       // PE TimeDateStamp
        0x0000000,        // PE SizeOfImage
        {0x000000, kXXXXStringConverterPrologue, sizeof(kXXXXStringConverterPrologue)},
        {0x000000, kXXXXResponseCallbackPrologue, sizeof(kXXXXResponseCallbackPrologue)},
        {0x000000, kXXXXResponseStringCall, sizeof(kXXXXResponseStringCall)},
        16,               // 回调对象 -> context
        32,               // context -> napi_deferred
        {1, 1, 1, 8, 16}, // 字符串布局；布局不同时必须修改
    },
};
```

注意：

- RVA 是相对模块基址的地址，**不是文件偏移**。52230 的 `stringConverter` RVA 是 `0xBF2B5F`，对应文件偏移是 `0xBF1F5F`（`.text` 段相差 `0xC00`）。
- 被覆盖的序言必须由完整指令组成，且不能包含 RIP 相对寻址或跳转；当前跳板不做重定位。
- 精确匹配完整版本号，不要因为构建号相邻就复用地址。
- 只有调用约定、对象布局、字符串布局都一致时，才能只加表项；否则应扩展通道实现。

### 5. 构建与自动测试

```powershell
npm run build:native
node --test
```

`test/packet-fixture.cpp` 不加载真实 QQ，验证：

- 短/长字符串边界；
- NUL 和非 UTF-8 字节；
- `napi_deferred` 关联；
- 普通回调透传；
- 跳板执行/恢复；
- 签名不匹配时拒绝安装。

自动测试通过不能代替目标 QQ 构建的实机验证。

### 6. 实机验证

完全退出本次 OpenQQ 拉起的 QQ，然后：

```powershell
npm start
```

在 WebUI 或用 OneBot 客户端验证：

1. 未缓存的群文件：返回 `{ "url": "https://..." }`；
2. 用返回的 URL 调 `download_file`，确认文件大小和内容；
3. 错误 `file_id`：返回明确错误，不崩溃；
4. 连续/并发请求：互不串响应；
5. Hook 初始化前后，普通 QQ 收发消息正常；
6. 其他 OneBot 动作正常。

### 7. 常见失败

| 现象 | 可能原因 |
| --- | --- |
| `result=145`，请求包解析失败 | 参数转换 Hook 未命中，或绑定不是同一个函数 |
| `rsp` 不是 Buffer | 响应字符串调用点/Hook 不对，或 IAT 槽校验失败 |
| `rsp` 为空、`result` 非 0 | 原生调用本身失败（参数、登录状态、接口变化） |
| QQ 在初始化时崩溃 | 序言签名、对象偏移或线程暂停逻辑不匹配，立即停止适配 |
| `unsupported QQ packet profile` | 版本号或 PE 标识没有匹配到表项 |

## Linux / Docker 适配

当前 Linux 和 Docker 不支持这个动作；没有缓存 URL 时返回 `1500`。Linux 的构建、启动和其他动作不受影响，因为 `packet.cpp` 只在 Windows 编译，Linux 仍使用 `bootstrap_linux.cpp`。

不能把 Windows 的 profile 直接搬到 Linux：

- `packet.cpp` 使用 PE 头、IAT、`VirtualProtect`、`SuspendThread` 等 Windows 机制；
- Linux 需要 ELF 解析、`mprotect`、GOT/PLT 或 `dlopen` 拦截，以及不同的字符串 ABI；
- `bootstrap_linux.cpp` 已有 `dlopen` 拦截框架，但没有二进制 packet 通道。

适配 Linux 的大致工作：

1. 新增 `native/packet_linux.cpp`，编译进 `openqq-bootstrap.so`；
2. 在 `dlopen`/模块注册完成后定位 `wrapper.node` 的基址；
3. 用 ELF 符号和 GOT/PLT 找到 `napi_create_string_utf8` / `napi_get_value_string_utf8` 的调用点；
4. 实现同样的“只对 OpenQQ 原始请求生效”的参数/响应转换和 `napi_deferred` 关联；
5. 在 `packet-native.cjs` 增加 Linux 分支，或在独立模块中加载；
6. 增加 Linux fixture 和真实 Linux QQ 实机验证；
7. Docker 重新构建镜像即可，不需要改 `Dockerfile`；发布 tar 包需要包含新的 `.so`。

在完成实机验证前，不要把 Linux 或新版本加入 `verifiedVersions`，也不要在文档中声称支持。

## 安全与限制

- 这是二进制 Hook，和 QQ 构建强绑定；未适配版本会在安装 Hook 前失败，不会带病运行。
- 只替换 OpenQQ 自己发起的原始请求；QQ 自身的调用、响应 `errMsg` 和其他动作保持原路径。
- Hook 安装会先核对 PE 标识、完整指令签名和 IAT 槽；安装失败会回滚。
- 跳板和原始函数在 QQ 进程退出前保持有效；JS 超时只停止等待，不释放 QQ 仍持有的 deferred。
- 当前不支持 Windows ARM64、Linux、macOS；新增平台需要独立的通道实现。
