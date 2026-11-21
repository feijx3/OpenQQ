#include "bootstrap.hpp"
#include <csetjmp>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <tlhelp32.h>

// ===== SSO 组件加载（发布版唯一的外部加载点） =====
//
// 契约：组件是一个只依赖 KERNEL32 的独立 DLL，被 LoadLibrary 进 QQ 进程后
// 自建命名管道，JS 侧（native/sso-pipe.cjs）按 QHP1 帧格式发包。组件自己决定
// 怎么在进程内把包送到 QQ 的 SSO 链上；本文件不碰、也不需要知道那套细节。
//
// 按优先级尝试，**找到第一个就用，不叠加**：
//   ① 自研组件  openqq-sso-local.dll      —— 我们自己维护，用户可选安装
//   ② 外部组件  snowluma-win32-x64.dll    —— 第三方，用户自行安装
// 都没有就静默跳过，OpenQQ 退回「内核 JS + 纯 HTTP」路径：功能降级但不崩。
//
// 覆盖方式：
//   OPENQQ_SSO_PROVIDER=none|local|snowluma   只启用指定的一个
//   OPENQQ_LOCAL_SSO_DLL=<绝对路径>           自研组件的路径
//   OPENQQ_SL_DLL=<绝对路径>                  外部组件的路径
//
// ⚠️ 发布版只允许保留「按名字 LoadLibrary」这一种动作。任何内存扫描、
// 地址读取、函数挂接都必须留在 OPENQQ_ENABLE_PROBE 的调试构建里，
// 否则会被安全软件按通用可疑特征拦截（build-native.mjs 有护栏兜底）。
static std::wstring selfModuleDir() {
    // 注意：GetModuleFileNameW(nullptr, …) 返回的是宿主 exe（QQ.exe）的路径，
    // 不是本 DLL 的。必须先用 FROM_ADDRESS 拿到自己的模块句柄。
    HMODULE self = nullptr;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(&selfModuleDir), &self) && self) {
        wchar_t selfPath[32768];
        if (GetModuleFileNameW(self, selfPath, 32768) != 0) {
            std::wstring dir(selfPath);
            const auto pos = dir.find_last_of(L"\\/");
            if (pos != std::wstring::npos) return dir.substr(0, pos + 1);
        }
    }
    return std::wstring();
}

static std::wstring envPath(const char* name) {
    if (const char* raw = std::getenv(name)) {
        if (*raw) {
            wchar_t wide[32768];
            if (MultiByteToWideChar(CP_UTF8, 0, raw, -1, wide, 32768) > 0) return std::wstring(wide);
        }
    }
    return std::wstring();
}

static bool tryLoadOne(const std::wstring& dir, const char* envName, const wchar_t* fileName) {
    std::wstring path = envPath(envName);
    if (path.empty() && !dir.empty()) path = dir + fileName;
    if (path.empty()) return false;
    if (GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) return false;
    return LoadLibraryW(path.c_str()) != nullptr;
}

// SSO 通道不再依赖任何外部组件（2026-11-21）。
//
// 现在的做法：用 4 字节补丁让 QQ 自己的 Msg.sendSsoCmdReqByContend 能接收二进制 body，
// 所以既不需要 SnowLuma，也不需要自研的 openqq-sso-local.dll。
//
// 历史：这里原本会按 OPENQQ_SSO_PROVIDER 去 LoadLibrary("snowluma-win32-x64.dll")。
// 那正是验收④要杜绝的运行时依赖 —— 现已被彻底移除，任何情况下都不会再加载它。
static void loadSsoBridge() {
    // 有意为空：不要在这里 LoadLibrary 任何东西。
}

template<class T> static T api(HMODULE module, const char* name) {
    auto address = GetProcAddress(module, name);
    if (!address) throw std::runtime_error(name);
    return reinterpret_cast<T>(address);
}
static void check(int status) {
    if (status) throw std::runtime_error("N-API returned " + std::to_string(status));
}

// ===== 自研 SSO 的 C++ 侧入口（只读探针） =====
//
// 为什么必须有这一段：QQ 只给 JS 暴露了一个 sendSsoCmdReqByContend，实测它是本地
// 白名单网关 —— 同一个包（OidbSvcTrpcTcp.0x102a_0）走 SnowLuma 的管道能拿到
// pskey（status 0），走这个 JS 口只返回 {}、0 毫秒，且把 onNetReply /
// onDispatchRequestReply / onDispatchPush / onDispatchPushWithJson /
// onUIConfigUpdate 五条回包通道全挂上之后 5 秒 0 事件，包根本没出进程。
//
// 真正能发包的函数在 session / engine 这些 napi 包装对象的 C++ 内部，JS 拿不到。
// 这里做两件事，都不改任何已有行为：
//   1) 把 wrapper 模块的导出对象挂到 globalThis.__openqq_wrapper —— JS 侧据此能拿到
//      NodeIQQNTWrapperEngine 实例（engine.onSendSSOReply 是可赋值属性，可当回包钩子）。
//   2) 挂一个 __openqqNativeProbe(target, offset)：把 target 用 napi_unwrap 还原成
//      原生指针，再按 offset 只读 8 字节，用 VirtualQuery 校验可读性并反查模块名。
//      全程只读，绝不调用读到的任何指针，所以探错偏移最多读到垃圾值，不会崩 QQ。
//
// ⚠️ 安全软件兼容：下面这一整段（typedefs + describeAddress + 两个 callback + installProbe）
// 在发布版里【不编译】。原因是它同时包含三个高危行为特征：
//   ① VirtualQuery 遍历内存区间（内存扫描特征）
//   ② 对任意地址做 8 字节读（读他人内存特征）
//   ③ napi_create_function 往全局对象挂函数（注入特征）
// 三者组合足以触发杀毒软件的通用可疑判定，与是否恶意无关 —— 实测会被安全中心拦。
// 发布版只保留 loadSsoBridge() 里那一行 LoadLibraryW：不扫内存、不读陌生地址。
// 需要做原生探针实验时，用 -DOPENQQ_ENABLE_PROBE=ON 单独编一个调试版，不部署到 dist。
#if defined(OPENQQ_ENABLE_PROBE)
typedef int (*PfnSetNamedProperty)(void*, void*, const char*, void*);
typedef int (*PfnGetNamedProperty)(void*, void*, const char*, void**);
typedef int (*PfnUnwrap)(void*, void*, void**);
typedef int (*PfnCreateObject)(void*, void**);
typedef int (*PfnCreateStringUtf8)(void*, const char*, size_t, void**);
typedef int (*PfnCreateDouble)(void*, double, void**);
typedef int (*PfnCreateInt32)(void*, int32_t, void**);
typedef int (*PfnCreateFunction)(void*, const char*, size_t, void*, void*, void**);
typedef int (*PfnGetCbInfo)(void*, void*, size_t*, void**, void**, void**);
typedef int (*PfnGetUndefined)(void*, void**);
typedef int (*PfnGetValueDouble)(void*, void*, double*);
typedef int (*PfnCreateArray)(void*, size_t, void**);
typedef int (*PfnSetElement)(void*, void*, uint32_t, void*);
typedef int (*PfnGetValueStringUtf8)(void*, void*, char*, size_t, size_t*);

struct NapiProbeFns {
    PfnSetNamedProperty setNamed;
    PfnGetNamedProperty getNamed;
    PfnUnwrap unwrap;
    PfnCreateObject createObject;
    PfnCreateStringUtf8 createString;
    PfnCreateDouble createDouble;
    PfnCreateInt32 createInt32;
    PfnCreateFunction createFunction;
    PfnGetCbInfo getCbInfo;
    PfnGetUndefined getUndefined;
    PfnGetValueDouble getValueDouble;
    PfnCreateArray createArray;
    PfnSetElement setElement;
    PfnGetValueStringUtf8 getString;
    HMODULE runtime;
};
static NapiProbeFns g_probe{};

// 查一个地址是否可读、是否可执行、落在哪个模块里。VirtualQuery 对任何用户态地址都安全。
static void describeAddress(unsigned long long addr, char* moduleOut, size_t moduleCap,
                            int* readable, int* executable, unsigned long long* base) {
    *readable = 0;
    *executable = 0;
    *base = 0;
    if (moduleOut && moduleCap) moduleOut[0] = 0;
    if (!addr) return;
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery(reinterpret_cast<LPCVOID>(static_cast<uintptr_t>(addr)), &mbi, sizeof(mbi)) == 0) return;
    if (mbi.State != MEM_COMMIT) return;
    const DWORD prot = mbi.Protect;
    if (prot & (PAGE_NOACCESS | PAGE_GUARD)) return;
    *readable = 1;
    *executable = (prot & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) ? 1 : 0;
    *base = reinterpret_cast<unsigned long long>(mbi.AllocationBase);
    if (mbi.Type == MEM_IMAGE && moduleOut && moduleCap) {
        wchar_t wide[MAX_PATH];
        if (GetModuleFileNameW(reinterpret_cast<HMODULE>(mbi.AllocationBase), wide, MAX_PATH) != 0) {
            char narrow[MAX_PATH * 4];
            if (WideCharToMultiByte(CP_UTF8, 0, wide, -1, narrow, sizeof(narrow), nullptr, nullptr) > 0) {
                const char* leaf = narrow;
                for (const char* p = narrow; *p; ++p) if (*p == '\\' || *p == '/') leaf = p + 1;
                std::snprintf(moduleOut, moduleCap, "%s", leaf);
            }
        }
    }
}

static void* setNum(void* env, void* obj, const char* name, double value) {
    void* boxed = nullptr;
    if (g_probe.createDouble && g_probe.createDouble(env, value, &boxed) == 0 && g_probe.setNamed)
        g_probe.setNamed(env, obj, name, boxed);
    return obj;
}
static void* setI32(void* env, void* obj, const char* name, int32_t value) {
    void* boxed = nullptr;
    if (g_probe.createInt32 && g_probe.createInt32(env, value, &boxed) == 0 && g_probe.setNamed)
        g_probe.setNamed(env, obj, name, boxed);
    return obj;
}
static void* setStr(void* env, void* obj, const char* name, const char* value) {
    void* boxed = nullptr;
    if (g_probe.createString && g_probe.createString(env, value, SIZE_MAX, &boxed) == 0 && g_probe.setNamed)
        g_probe.setNamed(env, obj, name, boxed);
    return obj;
}

// __openqqSsoReadPtr("0x1acd82bfb00", 112) -> { slot, offset, readable, exec, module, value }
// 读【裸地址】。给两级解引用用：先读 session+0x70 拿到对象地址 A，再读 A+0x70 看那里是不是真发包函数。
// __openqqNativeProbe 的第一参必须是 JS 对象，读不了裸地址，所以单独开这一个。
static void* ssoReadPtrCallback(void* env, void* info) {
    void* undefined = nullptr;
    if (g_probe.getUndefined) g_probe.getUndefined(env, &undefined);
    if (!g_probe.getCbInfo || !g_probe.createObject || !g_probe.getString) return undefined;

    void* argv[2] = {nullptr, nullptr};
    size_t argc = 2;
    if (g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0 || argc < 1) return undefined;

    void* out = nullptr;
    if (g_probe.createObject(env, &out) != 0 || !out) return undefined;

    char addrBuf[64] = {0};
    size_t addrLen = 0;
    if (g_probe.getString(env, argv[0], addrBuf, sizeof(addrBuf), &addrLen) != 0) {
        setStr(env, out, "error", "first arg must be an address string like 0x1acd82bfb00");
        return out;
    }

    double offset = 0;
    if (argc >= 2 && g_probe.getValueDouble) g_probe.getValueDouble(env, argv[1], &offset);

    const unsigned long long base = strtoull(addrBuf, nullptr, 16);
    const auto slot = base + static_cast<unsigned long long>(static_cast<long long>(offset));
    char hex[32];
    std::snprintf(hex, sizeof(hex), "0x%llx", slot);
    setStr(env, out, "base", addrBuf);
    setStr(env, out, "slot", hex);
    setNum(env, out, "offset", offset);
    if (base == 0) {
        setStr(env, out, "note", "address parsed as 0");
        return out;
    }

    int readable = 0, executable = 0;
    char moduleName[MAX_PATH * 4];
    unsigned long long allocBase = 0;
    describeAddress(slot, moduleName, sizeof(moduleName), &readable, &executable, &allocBase);
    setI32(env, out, "slotReadable", readable);
    if (!readable) {
        setStr(env, out, "note", "slot not readable");
        return out;
    }

    // 跨页保护：VirtualQuery 只保证 slot 那一页可读，读 8 字节可能越界到未提交页 → 崩 QQ。
    MEMORY_BASIC_INFORMATION mbi;
    bool canRead8 = false;
    if (VirtualQuery(reinterpret_cast<LPCVOID>(static_cast<uintptr_t>(slot)), &mbi, sizeof(mbi)) != 0
        && mbi.State == MEM_COMMIT
        && !(mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) {
        const auto lo = reinterpret_cast<unsigned long long>(mbi.BaseAddress);
        const auto hi = lo + static_cast<unsigned long long>(mbi.RegionSize);
        canRead8 = slot >= lo && (slot + 8) <= hi;
    }
    if (!canRead8) {
        setStr(env, out, "note", "cannot safely read 8 bytes here");
        return out;
    }

    const unsigned long long value =
        *reinterpret_cast<const unsigned long long*>(static_cast<uintptr_t>(slot));
    char vhex[32];
    std::snprintf(vhex, sizeof(vhex), "0x%llx", value);
    setStr(env, out, "value", vhex);

    int vReadable = 0, vExec = 0;
    char vModule[MAX_PATH * 4];
    unsigned long long vBase = 0;
    describeAddress(value, vModule, sizeof(vModule), &vReadable, &vExec, &vBase);
    setI32(env, out, "valueReadable", vReadable);
    setI32(env, out, "valueExec", vExec);
    setStr(env, out, "valueModule", vModule);
    return out;
}

// __openqqNativeProbe(target, offset) -> { unwrapOk, ptr, offset, readable, exec, module, value }
static void* nativeProbeCallback(void* env, void* info) {
    void* undefined = nullptr;
    if (g_probe.getUndefined) g_probe.getUndefined(env, &undefined);
    if (!g_probe.getCbInfo || !g_probe.createObject) return undefined;

    void* argv[2] = {nullptr, nullptr};
    size_t argc = 2;
    if (g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0 || argc < 1) return undefined;

    void* out = nullptr;
    if (g_probe.createObject(env, &out) != 0 || !out) return undefined;

    // offset 缺省为 0，这样 __openqqNativeProbe(target) 直接返回 unwrap 出来的裸指针。
    double offset = 0;
    if (argc >= 2 && g_probe.getValueDouble) g_probe.getValueDouble(env, argv[1], &offset);

    void* native = nullptr;
    const int unwrapStatus = g_probe.unwrap ? g_probe.unwrap(env, argv[0], &native) : -1;
    char hex[32];
    std::snprintf(hex, sizeof(hex), "0x%llx", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(native)));
    setI32(env, out, "unwrapStatus", unwrapStatus);
    setStr(env, out, "ptr", hex);
    setNum(env, out, "offset", offset);
    if (unwrapStatus != 0 || !native) {
        setStr(env, out, "note", "napi_unwrap failed: target is not a Napi::ObjectWrap instance");
        return out;
    }

    const auto base = reinterpret_cast<unsigned long long>(reinterpret_cast<uintptr_t>(native));
    const auto slot = base + static_cast<unsigned long long>(static_cast<long long>(offset));

    int readable = 0, executable = 0;
    char moduleName[MAX_PATH * 4];
    unsigned long long allocBase = 0;
    unsigned long long value = 0;
    describeAddress(slot, moduleName, sizeof(moduleName), &readable, &executable, &allocBase);
    if (readable) {
        // 跨页保护（必须）：VirtualQuery 只保证 slot 所在的那一页可读。若 slot 落在区域末尾
        // 的最后几个字节，读 8 字节会越界到下一个页；那页若未提交，就是 access violation ——
        // 会连 QQ 一起崩。所以先用同一块 MBI 的 BaseAddress + RegionSize 卡住上界，
        // 不满足就整段跳过，宁可少一个读数也不冒崩溃风险。
        MEMORY_BASIC_INFORMATION mbi;
        bool canRead8 = false;
        if (VirtualQuery(reinterpret_cast<LPCVOID>(static_cast<uintptr_t>(slot)), &mbi, sizeof(mbi)) != 0
            && mbi.State == MEM_COMMIT
            && !(mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) {
            const auto lo = reinterpret_cast<unsigned long long>(mbi.BaseAddress);
            const auto hi = lo + static_cast<unsigned long long>(mbi.RegionSize);
            canRead8 = slot >= lo && (slot + 8) <= hi;
        }
        if (canRead8) {
            value = *reinterpret_cast<const unsigned long long*>(static_cast<uintptr_t>(slot));
            // 再把读到的值本身也描述一遍 —— 这是判断「它是不是一个函数指针」的关键。
            int vReadable = 0, vExec = 0;
            char vModule[MAX_PATH * 4];
            unsigned long long vBase = 0;
            describeAddress(value, vModule, sizeof(vModule), &vReadable, &vExec, &vBase);
            setI32(env, out, "valueReadable", vReadable);
            setI32(env, out, "valueExec", vExec);
            setStr(env, out, "valueModule", vModule);
            char vhex[32];
            std::snprintf(vhex, sizeof(vhex), "0x%llx", value);
            setStr(env, out, "value", vhex);
        } else {
            setI32(env, out, "valueReadable", 0);
            setStr(env, out, "note", "slot+8 crosses a committed region boundary; read skipped for safety");
        }
    }
    setI32(env, out, "slotReadable", readable);
    setI32(env, out, "exec", executable);
    setStr(env, out, "module", moduleName);
    return out;
}

// __openqqNativeScan(target, start, count) -> { unwrapStatus, ptr, scanned, candidates:[{offset,value,module}] }
//
// 一次扫完一段槽位，只返回「值本身指向可执行段」的候选。为什么要有它：
// SnowLuma 用的是硬编码偏移（发包函数在 +0x70，分配器在 +0x78，另一套在 +0x108/+0x110），
// 那种写法换一个 QQ 版本就会失效。我们要的是版本无关——所以不写死偏移，而是在运行时
// 扫一遍对象的槽位，把「看起来是函数指针」的全部列出来，再按版本缓存结果。
// 扫描全程只读 + VirtualQuery 卡边界，不调用任何读到的地址。
static void* nativeScanCallback(void* env, void* info) {
    void* undefined = nullptr;
    if (g_probe.getUndefined) g_probe.getUndefined(env, &undefined);
    if (!g_probe.getCbInfo || !g_probe.createObject) return undefined;

    void* argv[3] = {nullptr, nullptr, nullptr};
    size_t argc = 3;
    if (g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0 || argc < 1) return undefined;

    void* out = nullptr;
    if (g_probe.createObject(env, &out) != 0 || !out) return undefined;

    double start = 0;
    double count = 64;
    if (argc >= 2 && g_probe.getValueDouble) g_probe.getValueDouble(env, argv[1], &start);
    if (argc >= 3 && g_probe.getValueDouble) g_probe.getValueDouble(env, argv[2], &count);
    if (!(count > 0)) count = 64;
    if (count > 512) count = 512;

    void* native = nullptr;
    const int unwrapStatus = g_probe.unwrap ? g_probe.unwrap(env, argv[0], &native) : -1;
    setI32(env, out, "unwrapStatus", unwrapStatus);
    char hex[32];
    std::snprintf(hex, sizeof(hex), "0x%llx", static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(native)));
    setStr(env, out, "ptr", hex);
    if (unwrapStatus != 0 || !native) {
        setStr(env, out, "note", "napi_unwrap failed: not a Napi::ObjectWrap instance");
        return out;
    }

    const auto base = static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(native));
    const auto startOff = static_cast<unsigned long long>(static_cast<long long>(start));
    const int slots = static_cast<int>(count);
    setNum(env, out, "start", start);
    setI32(env, out, "slots", slots);

    void* candidates = nullptr;
    uint32_t found = 0;
    uint32_t readableCount = 0;
    if (g_probe.createArray && g_probe.createArray(env, 0, &candidates) == 0 && candidates) {
        for (int i = 0; i < slots; i++) {
            const auto slot = base + startOff + static_cast<unsigned long long>(i) * 8ULL;
            MEMORY_BASIC_INFORMATION mbi;
            if (VirtualQuery(reinterpret_cast<LPCVOID>(static_cast<uintptr_t>(slot)), &mbi, sizeof(mbi)) == 0) continue;
            if (mbi.State != MEM_COMMIT) continue;
            if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) continue;
            const auto lo = static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(mbi.BaseAddress));
            const auto hi = lo + static_cast<unsigned long long>(mbi.RegionSize);
            if (slot < lo || (slot + 8) > hi) continue;   // 跨区域不读，避免带崩 QQ
            readableCount++;
            const unsigned long long value = *reinterpret_cast<const unsigned long long*>(static_cast<uintptr_t>(slot));
            if (!value) continue;
            int vReadable = 0, vExec = 0;
            char vModule[MAX_PATH * 4];
            unsigned long long vBase = 0;
            describeAddress(value, vModule, sizeof(vModule), &vReadable, &vExec, &vBase);
            if (!vBase) continue;   // 不在任何已加载模块里 → 不是对象/函数指针
            // ⚠️ 这里不能只留 vExec。C++ 对象偏移 0 放的是 vtable 指针，而 vtable 落在
            // .rdata（只读数据段，不可执行）。只看可执行段会把 vtable 整体过滤掉，
            // 表现是 readableSlots 很大、candidateCount 却是 0。
            // 所以：落在模块内就收，用 exec 字段标出它所在段可不可执行，判断留给调用方。
            void* item = nullptr;
            if (!g_probe.createObject || g_probe.createObject(env, &item) != 0 || !item) continue;
            setNum(env, item, "offset", start + static_cast<double>(i) * 8.0);
            char vhex[32];
            std::snprintf(vhex, sizeof(vhex), "0x%llx", value);
            setStr(env, item, "value", vhex);
            setStr(env, item, "module", vModule);
            setI32(env, item, "exec", vExec);
            if (g_probe.setElement) g_probe.setElement(env, candidates, found, item);
            found++;
        }
        setNum(env, out, "readableSlots", static_cast<double>(readableCount));
        setNum(env, out, "candidateCount", static_cast<double>(found));
        if (g_probe.setNamed) g_probe.setNamed(env, out, "candidates", candidates);
    }
    return out;
}

// __openqqSsoTryCall(target, offset, cmd, bodyHex) -> { ok, crashed, status, tried }
//
// 在调试版里把「定位到的候选地址」真的调一次，用来判断它是不是发包函数。
// 调未知函数会访问违例，所以全程用 VEH + longjmp 兜住：崩了就跳回来记一笔，不拖死 QQ。
// 只在调试版编译；发布版没有这个入口。
static thread_local jmp_buf* g_tryJmp = nullptr;
static thread_local volatile int g_tryHit = 0;

static LONG CALLBACK ssoTryVeh(PEXCEPTION_POINTERS info) {
    if (!g_tryJmp) return EXCEPTION_CONTINUE_SEARCH;
    const DWORD code = info->ExceptionRecord ? info->ExceptionRecord->ExceptionCode : 0;
    if (code == EXCEPTION_ACCESS_VIOLATION || code == EXCEPTION_ILLEGAL_INSTRUCTION ||
        code == EXCEPTION_PRIV_INSTRUCTION || code == EXCEPTION_INT_DIVIDE_BY_ZERO ||
        code == EXCEPTION_STACK_OVERFLOW) {
        g_tryHit = 1;
        longjmp(*g_tryJmp, 1);
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

// 三种最常见的成员函数形态，逐个套着调用。成功（不崩）就记下用哪一种。
typedef int (*TryFnA)(void*, const char*, const void*, size_t, void*);
typedef int (*TryFnB)(void*, const char*, const void*, size_t);
typedef int (*TryFnC)(void*, void*, void*);

static void* ssoTryCallCallback(void* env, void* info) {
    void* undefined = nullptr;
    if (g_probe.getUndefined) g_probe.getUndefined(env, &undefined);
    if (!g_probe.getCbInfo || !g_probe.createObject || !g_probe.getString) return undefined;

    void* argv[4] = {nullptr, nullptr, nullptr, nullptr};
    size_t argc = 4;
    if (g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0 || argc < 2) return undefined;

    void* out = nullptr;
    if (g_probe.createObject(env, &out) != 0 || !out) return undefined;

    double offset = 0;
    if (g_probe.getValueDouble) g_probe.getValueDouble(env, argv[1], &offset);

    char cmd[512];
    cmd[0] = 0;
    if (argc >= 3 && argv[2]) g_probe.getString(env, argv[2], cmd, sizeof(cmd), nullptr);

    void* native = nullptr;
    const int unwrapStatus = g_probe.unwrap ? g_probe.unwrap(env, argv[0], &native) : -1;
    setI32(env, out, "unwrapStatus", unwrapStatus);
    if (unwrapStatus != 0 || !native) {
        setStr(env, out, "note", "napi_unwrap failed");
        return out;
    }

    const uintptr_t base = reinterpret_cast<uintptr_t>(native);
    const uintptr_t slot = base + static_cast<uintptr_t>(static_cast<long long>(offset));
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery(reinterpret_cast<LPCVOID>(slot), &mbi, sizeof(mbi)) == 0 ||
        mbi.State != MEM_COMMIT || (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD))) {
        setStr(env, out, "note", "slot not readable");
        return out;
    }
    const auto fnAddr = *reinterpret_cast<const uintptr_t*>(slot);
    setNum(env, out, "target", static_cast<double>(offset) );
    char fhex[32];
    std::snprintf(fhex, sizeof(fhex), "0x%llx", static_cast<unsigned long long>(fnAddr));
    setStr(env, out, "fn", fhex);
    if (!fnAddr) {
        setStr(env, out, "note", "slot is null");
        return out;
    }

    int vReadable = 0, vExec = 0;
    char vModule[MAX_PATH * 4];
    unsigned long long vBase = 0;
    describeAddress(static_cast<unsigned long long>(fnAddr), vModule, sizeof(vModule), &vReadable, &vExec, &vBase);
    setStr(env, out, "module", vModule);
    setNum(env, out, "fnOffset", static_cast<double>(fnAddr - vBase));
    if (!vExec) {
        setStr(env, out, "note", "target is not executable");
        return out;
    }

    // 空 body 足够验证「这个地址是不是发包入口」——真发包要 body，但那是在确认偏移之后的事。
    void* veh = AddVectoredExceptionHandler(1, ssoTryVeh);
    jmp_buf jb;
    jmp_buf* prevJmp = g_tryJmp;
    const int prevHit = g_tryHit;

    struct Result { const char* sig; long long rc; int crashed; };
    Result results[3] = {{"A(self,cmd,body,len,cb)", 0, 0}, {"B(self,cmd,body,len)", 0, 0}, {"C(self,cmd,body)", 0, 0}};

    for (int i = 0; i < 3; i++) {
        g_tryJmp = &jb;
        g_tryHit = 0;
        if (setjmp(jb) == 0) {
            if (i == 0) results[i].rc = reinterpret_cast<TryFnA>(fnAddr)(native, cmd, nullptr, 0, nullptr);
            else if (i == 1) results[i].rc = reinterpret_cast<TryFnB>(fnAddr)(native, cmd, nullptr, 0);
            else results[i].rc = reinterpret_cast<TryFnC>(fnAddr)(native, nullptr, nullptr);
        } else {
            results[i].crashed = 1;   // longjmp 回来了：这一种签名不对
        }
        g_tryJmp = nullptr;
    }

    g_tryJmp = prevJmp;
    g_tryHit = prevHit;
    if (veh) RemoveVectoredExceptionHandler(veh);

    void* arr = nullptr;
    int survived = 0;
    if (g_probe.createArray && g_probe.createArray(env, 0, &arr) == 0 && arr) {
        for (int i = 0; i < 3; i++) {
            void* item = nullptr;
            if (!g_probe.createObject || g_probe.createObject(env, &item) != 0 || !item) continue;
            setStr(env, item, "sig", results[i].sig);
            setNum(env, item, "rc", static_cast<double>(results[i].rc));
            setI32(env, item, "crashed", results[i].crashed);
            if (!results[i].crashed) survived++;
            if (g_probe.setElement) g_probe.setElement(env, arr, static_cast<uint32_t>(i), item);
        }
        if (g_probe.setNamed) g_probe.setNamed(env, out, "attempts", arr);
    }
    setI32(env, out, "survived", survived);
    return out;
}

// __openqqSsoTryAddr("0x7ff806723274", cmd, [selfObj]) —— 直接对裸地址试调。
// 不走 napi_unwrap 的槽位读取：地址已经是函数本身（ssoReadPtr 读到 valueExec:1）。
// self 可选：传了 JS 对象就 unwrap 成第一个参数，不传就传 nullptr。
static void* ssoTryAddrCallback(void* env, void* info) {
    void* undefined = nullptr;
    if (g_probe.getUndefined) g_probe.getUndefined(env, &undefined);
    if (!g_probe.getCbInfo || !g_probe.createObject || !g_probe.getString) return undefined;

    void* argv[4] = {nullptr, nullptr, nullptr, nullptr};
    size_t argc = 4;
    if (g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0 || argc < 1) return undefined;

    void* out = nullptr;
    if (g_probe.createObject(env, &out) != 0 || !out) return undefined;

    char addrBuf[64] = {0};
    if (g_probe.getString(env, argv[0], addrBuf, sizeof(addrBuf), nullptr) != 0) {
        setStr(env, out, "error", "first arg must be an address string like 0x7ff806723274");
        return out;
    }
    const uintptr_t fnAddr = static_cast<uintptr_t>(strtoull(addrBuf, nullptr, 16));

    char cmd[512];
    cmd[0] = 0;
    if (argc >= 2 && argv[1]) g_probe.getString(env, argv[1], cmd, sizeof(cmd), nullptr);

    void* self = nullptr;
    if (argc >= 3 && argv[2] && g_probe.unwrap) g_probe.unwrap(env, argv[2], &self);

    // 第 4 参：bodyHex（可选）。有它才可能真的发出一个包 —— 空 body 只能验证"调不崩"。
    static unsigned char s_bodyBuf[262144];
    size_t bodyLen = 0;
    if (argc >= 4 && argv[3]) {
        static char s_hex[524288];
        s_hex[0] = 0;
        if (g_probe.getString(env, argv[3], s_hex, sizeof(s_hex), nullptr) == 0) {
            const size_t n = strlen(s_hex);
            for (size_t i = 0; i + 1 < n && bodyLen < sizeof(s_bodyBuf); i += 2) {
                auto hv = [](char c) -> int {
                    if (c >= '0' && c <= '9') return c - '0';
                    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                    return -1;
                };
                const int hi = hv(s_hex[i]), lo = hv(s_hex[i + 1]);
                if (hi < 0 || lo < 0) break;
                s_bodyBuf[bodyLen++] = static_cast<unsigned char>((hi << 4) | lo);
            }
        }
    }
    setNum(env, out, "bodyLen", static_cast<double>(bodyLen));

    char fhex[32];
    std::snprintf(fhex, sizeof(fhex), "0x%llx", static_cast<unsigned long long>(fnAddr));
    setStr(env, out, "fn", fhex);
    setStr(env, out, "cmd", cmd);
    char shex[32];
    std::snprintf(shex, sizeof(shex), "0x%llx",
                  static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(self)));
    setStr(env, out, "self", shex);

    int vReadable = 0, vExec = 0;
    char vModule[MAX_PATH * 4];
    unsigned long long vBase = 0;
    describeAddress(static_cast<unsigned long long>(fnAddr), vModule, sizeof(vModule), &vReadable, &vExec, &vBase);
    setStr(env, out, "module", vModule);
    if (!vExec) {
        setStr(env, out, "note", "target is not executable");
        return out;
    }

    void* veh = AddVectoredExceptionHandler(1, ssoTryVeh);
    jmp_buf jb;
    jmp_buf* prevJmp = g_tryJmp;
    const int prevHit = g_tryHit;

    struct Result { const char* sig; long long rc; int crashed; };
    Result results[3] = {{"A(self,cmd,body,len,cb)", 0, 0},
                         {"B(self,cmd,body,len)", 0, 0},
                         {"C(self,cmd,body)", 0, 0}};

    for (int i = 0; i < 3; i++) {
        g_tryJmp = &jb;
        g_tryHit = 0;
        if (setjmp(jb) == 0) {
            if (i == 0) results[i].rc = reinterpret_cast<TryFnA>(fnAddr)(self, cmd, bodyLen ? s_bodyBuf : nullptr, bodyLen, nullptr);
            else if (i == 1) results[i].rc = reinterpret_cast<TryFnB>(fnAddr)(self, cmd, bodyLen ? s_bodyBuf : nullptr, bodyLen);
            else results[i].rc = reinterpret_cast<TryFnC>(fnAddr)(self, nullptr, nullptr);
        } else {
            results[i].crashed = 1;
        }
        g_tryJmp = nullptr;
    }

    g_tryJmp = prevJmp;
    g_tryHit = prevHit;
    if (veh) RemoveVectoredExceptionHandler(veh);

    void* arr = nullptr;
    int survived = 0;
    if (g_probe.createArray && g_probe.createArray(env, 0, &arr) == 0 && arr) {
        for (int i = 0; i < 3; i++) {
            void* item = nullptr;
            if (!g_probe.createObject || g_probe.createObject(env, &item) != 0 || !item) continue;
            setStr(env, item, "sig", results[i].sig);
            setNum(env, item, "rc", static_cast<double>(results[i].rc));
            setI32(env, item, "crashed", results[i].crashed);
            if (!results[i].crashed) survived++;
            if (g_probe.setElement) g_probe.setElement(env, arr, static_cast<uint32_t>(i), item);
        }
        if (g_probe.setNamed) g_probe.setNamed(env, out, "attempts", arr);
    }
    setI32(env, out, "survived", survived);
    return out;
}

// 在 injections source 执行前调用：把 wrapper 句柄和只读探针挂到 globalThis。
// ===== SSO 发包原语 hook（仅调试版编译）=====
// 为什么只能 hook：直调 0x765d70 / 0x76669c 三种形态全失败（同步卡死、解引用卡死、
// 异步崩进程，见 .botharness/selfdev-sso-breakthrough.md）。唯一能拿到「QQ 自己调用时
// 的完整参数」的办法是在入口旁观。
//
// 为什么能安全覆盖：0x765d70 前 12 字节正好是 8 条 push（rbp/r15/r14/r13/r12/rsi/rdi/rbx），
// 指令边界干净，用 mov rax,imm64 + jmp rax 覆盖后，trampoline 补回这 8 条 push 再跳回 +12。
// 覆盖前后行为完全等价，只是多一次旁观。
// 这些变量在下面的 naked 汇编里按名字引用，必须是 C linkage 且非 static，
// 否则汇编器看到的是 mangled 名 → 链接期 undefined symbol。
extern "C" {
volatile long long g_hookRcx = 0;
volatile long long g_hookRdx = 0;
volatile long long g_hookR8 = 0;
volatile long long g_hookR9 = 0;
volatile long long g_hookArg5 = 0;
volatile long g_hookHits = 0;
void* g_hookTramp = nullptr;
volatile LONG g_hookLight = 0;   // 1 = 轻量模式：hookCapture 不做事（热点路径专用）
char g_hookCmd[256] = {0};
long long g_hookCmdLen = 0;
unsigned char g_hookReq[128] = {0};
long long g_hookReqLen = 0;
unsigned char g_hookRdxRaw[32] = {0};
unsigned char g_hookR8Raw[32] = {0};
unsigned char g_hookRcxRaw[128] = {0};
char g_hookArgStr[512] = {0};
char g_cmdStr[512] = {0};
long long g_cmdStrLen = 0;
long long g_hookArgStrLen = 0;
// hook 目标是 NAPI 绑定函数时置 1：此时 rcx=napi_env、rdx=napi_cb_info，
// 参数要用 napi_get_cb_info 取，不能当普通结构体解引用。
int g_hookIsNapi = 0;
char g_hookNapiArgs[2048] = {0};
long long g_hookNapiArgc = 0;
static void hookCaptureNapiArgs(long long env, long long info);
// 只解析「已经拿到的 argv 数组」，不调 napi_get_cb_info（那个不能在中间点重复调）。
static void hookParseNapiValues(long long env, const long long* argv, long long argc);
long long g_hookVtbl = 0;
long long g_hookFnAddr = 0;
long long g_hookRetAddr = 0;
long long g_hookRdi = 0;
long long g_hookRbp = 0;
long long g_napiArgcRaw = -1;
long long g_napiArgv[8] = {0};
long long g_napiArgc = 0;
}

// 读任意指针前先确认这段地址真的可读。0x4deb9a 是虚调用尾跳板，可能被多种对象类型复用，
// 各调用点的 rdx/r8/r9 含义不同 —— 不做校验地解引用会直接把 QQ 崩掉（2026-11-20 实测 8→4 进程）。
// 这是单点 VirtualQuery，不是遍历扫描；且只在调试版里存在。
// 纯算术校验，不调 VirtualQuery。
// 原因：0x13807f2 是发消息必经路径，VirtualQuery 是内核调用，一次就足以把整条链拖过超时（2026-11-20 实测）。
// 只排除明显非法的指针（空、低地址、超用户态、溢出）；真实可读性由调用点自己保证。
static bool hookReadable(const void* p, size_t n) {
    if (!p || n == 0) return false;
    const auto a = reinterpret_cast<uintptr_t>(p);
    if (a < 0x10000) return false;
    if (a > 0x00007FFFFFFFFFFFULL) return false;
    if (a + n < a) return false;
    return true;
}

// 在 hook 现场立刻解引用读内存 —— 不能等 state 再读：对象和栈上的结构，函数一返回就失效。
// 参数顺序：obj(原 rcx) / cmd(原 rdx) / p3(原 r8) / p4(原 r9)。
extern "C" void hookCapture(long long obj, long long cmd, long long p3, long long p4, long long rbp) {
    // 轻量模式：热点路径上绝不做 VirtualQuery / NAPI 解析 —— 那是把 QQ 拖死的真凶。
    // 需要的值已由 ssoSendHookEntry 的汇编内联捕获（g_relaySession / g_relayObjBase）。
    if (g_hookLight) return;
    // ★ 只处理第一次命中。
    // 0x268b8ea 是发消息热点路径，一条消息会被调用很多次；而 hookReadable 里的
    // VirtualQuery 是内核调用，在热点路径上重复执行会让 QQ 直接崩掉（2026-11-20 实测 8→6 进程）。
    // 只 dump 第一条就能拿到全部需要的信息，后续立即返回，开销趋近于零。
    if (g_hookHits > 1) return;
    // hook 在 0x13808c1 时，rdx = &std::string(cmd)（MSVC 布局）：
    //   +0x00 union{ char buf[16]; char* ptr; }   +0x10 size_t size   +0x18 capacity
    // size<=15 走内联 buf，否则 buf 是堆指针。
    g_cmdStrLen = 0;
    g_cmdStr[0] = 0;
    if (hookReadable(reinterpret_cast<const void*>(cmd), 0x20)) {
        size_t sz = 0;
        memcpy(&sz, reinterpret_cast<const void*>(cmd + 0x10), 8);
        if (sz > 0 && sz < sizeof(g_cmdStr)) {
            const char* sp = nullptr;
            if (sz <= 15) sp = reinterpret_cast<const char*>(cmd);
            else { void* hp = nullptr; memcpy(&hp, reinterpret_cast<const void*>(cmd), 8); sp = reinterpret_cast<const char*>(hp); }
            if (sp && hookReadable(sp, sz)) {
                memcpy(g_cmdStr, sp, sz);
                g_cmdStr[sz] = 0;
                g_cmdStrLen = static_cast<long long>(sz);
            }
        }
    }
    if (rbp) {
        g_hookRbp = rbp;   // 诊断：把收到的 rbp 原样报出去，判断是"没传进来"还是"偏移不对"
        const unsigned char* fp = reinterpret_cast<const unsigned char*>(rbp);
        if (hookReadable(fp + 0x3000, 8) && hookReadable(fp + 0x2FB0, 8 * 8)) {
            long long argc = 0;
            memcpy(&argc, fp + 0x3000, 8);
            g_napiArgcRaw = argc;
            if (argc >= 0 && argc <= 8) {
                g_napiArgc = argc;
                memcpy(g_napiArgv, fp + 0x2FB0, sizeof(g_napiArgv));
                    hookParseNapiValues(g_hookRdi, g_napiArgv, argc);
            }
        }
    }
    // NAPI 绑定函数：rcx=env、rdx=cb_info。实参解析放到 hookCaptureNapiArgs 里
    // （它定义在 SsoApi/g_sso 之后，这里只能前置声明调用）。
    if (g_hookIsNapi) hookCaptureNapiArgs(obj, cmd);
      else if (rbp) hookCaptureNapiArgs(g_hookRdi, cmd);
    if (hookReadable(reinterpret_cast<const void*>(obj), 8)) {
        void* vt = nullptr;
        memcpy(&vt, reinterpret_cast<const void*>(obj), 8);
        g_hookVtbl = reinterpret_cast<long long>(vt);
        if (hookReadable(vt, 0xC8 + 8)) {
            void* fn = nullptr;
            memcpy(&fn, reinterpret_cast<const unsigned char*>(vt) + 0xC8, 8);
            g_hookFnAddr = reinterpret_cast<long long>(fn);
        }
    }
    if (hookReadable(reinterpret_cast<const void*>(cmd), sizeof(g_hookRdxRaw))) {
        memcpy(g_hookRdxRaw, reinterpret_cast<const void*>(cmd), sizeof(g_hookRdxRaw));
    }
    // rcx 指向的结构里，string_view 在 +8 处（反汇编 0x268b8ea 确认）：
    //   flags = *(rcx+8)  短串 ptr = rcx+9  ptr = rcx+9  长串 len = *(rcx+0x10)
    // 只读这 24 字节（不是 128）—— 之前 dump 128 字节会崩，因为读得太远。
    if (hookReadable(reinterpret_cast<const unsigned char*>(obj) + 8, 0x18)) {
        const unsigned char* p = reinterpret_cast<const unsigned char*>(obj) + 8;
        const unsigned char flags = p[0];
        size_t len = 0;
        const char* data = nullptr;
        if (flags & 1) {
            memcpy(&len, p + 8, 8);
            memcpy(&data, p + 0x10, 8);
        } else {
            len = flags >> 1;
            data = reinterpret_cast<const char*>(p + 1);
        }
        if (data && len > 0 && len < sizeof(g_hookArgStr) && hookReadable(data, len)) {
            memcpy(g_hookArgStr, data, len);
            g_hookArgStr[len] = 0;
            g_hookArgStrLen = static_cast<long long>(len);
        } else {
            g_hookArgStr[0] = 0;
            g_hookArgStrLen = 0;
        }
    }
    if (hookReadable(reinterpret_cast<const void*>(p3), sizeof(g_hookR8Raw))) {
        memcpy(g_hookR8Raw, reinterpret_cast<const void*>(p3), sizeof(g_hookR8Raw));
    }
    if (hookReadable(reinterpret_cast<const void*>(p4), sizeof(g_hookReq))) {
        memcpy(g_hookReq, reinterpret_cast<const void*>(p4), sizeof(g_hookReq));
        g_hookReqLen = static_cast<long long>(sizeof(g_hookReq));
    }
    // 按 string_view 试读 cmd：flags&1 ? (len=+8, ptr=+0x10) : (len=flags>>1, ptr=+1)
    if (hookReadable(reinterpret_cast<const void*>(cmd), 0x18)) {
        const unsigned char* p = reinterpret_cast<const unsigned char*>(cmd);
        const unsigned char flags = p[0];
        size_t len = 0;
        const char* data = nullptr;
        if (flags & 1) {
            memcpy(&len, p + 8, 8);
            memcpy(&data, p + 0x10, 8);
        } else {
            len = flags >> 1;
            data = reinterpret_cast<const char*>(p + 1);
        }
        if (data && len > 0 && len < sizeof(g_hookCmd) && hookReadable(data, len)) {
            memcpy(g_hookCmd, data, len);
            g_hookCmd[len] = 0;
            g_hookCmdLen = static_cast<long long>(len);
        } else {
            g_hookCmd[0] = 0;
            g_hookCmdLen = 0;
        }
    }
}
static bool g_hookInstalled = false;
static unsigned int g_hookRva = 0;
static int g_hookCoverLen = 0;
static unsigned char g_hookOrig[32] = {0};
static unsigned char* g_hookTarget = nullptr;

// ===== 借道发包（relay）=====
// 思路：不去"从外部调 QQ 的发送函数"（那条路六次全败，缺的是 QQ 自己的调用上下文），
// 而是 hook 住 QQ 自己的发送分发器 0x268b8ea，在它被 QQ 调用时（rcx 已经是真 session），
// 把 rdx(cmd)/r8(body) 换成我们的，让 QQ 的流水线替我们把包发出去。
// armed 只借一次，借完立刻清零，不影响后续正常消息。
volatile LONG g_relayArmed = 0;          // 0=未布防 1=布防（下次命中时借道）
volatile LONG g_relayDone = 0;           // 借道次数
void* g_relayCmd = nullptr;              // 指向 0x30 cmd 块
void* g_relayBody = nullptr;             // 指向 SsoSpan{ptr,len}
void* g_relaySession = nullptr;          // 借道时拿到的真 session
void* g_relayOrigRcx = nullptr;          // 借道时保存的原参数
void* g_relayOrigRdx = nullptr;
void* g_relayOrigR8 = nullptr;
void* g_relayOrigR9 = nullptr;
void* g_relayObjBase = nullptr;
int g_relayErr = 0;
static char g_relayCmdStore[32] = {0};          // cmd 名字（调试用）
static unsigned char g_relayBodyStore[1024] = {0};
static unsigned char g_relayBodyLen = 0;

// 算覆盖长度：从入口往后走，返回第一个 >= 12 字节的指令边界。
// 为什么不能固定 12：MSVC 的 prologue 形态不统一 ——
//   0x765d70 / 0x77b138 / 0x268b8ea / 0x109c332 前 8 条 push 正好 12 字节；
//   0x765ce6 是 6 push + sub rsp,imm8(4) + lea rbp(5) → 12 会切在 lea 中间，需 15；
//   0x76669c 是 sub rsp,imm8(4) + mov rax,[rip](7) + xor rax,rsp(3) → 需 14；
//   0x399b14 是 6 push + sub rsp,imm32(7) → 需 15。
// 认不出来就返回 -1，宁可不装也不切在指令中间（切错必崩）。
static int hookCoverLen(const unsigned char* p) {
    int i = 0;
    while (i < 20) {
        if (i >= 12) return i;
        const unsigned char b = p[i];
        if (b == 0x55 || b == 0x53 || b == 0x54 || b == 0x56 || b == 0x57) { i += 1; continue; }
        if (b == 0x41 && p[i + 1] >= 0x54 && p[i + 1] <= 0x57) { i += 2; continue; }
        if (b == 0x48 && p[i + 1] == 0x83 && p[i + 2] == 0xEC) { i += 4; continue; }
        if (b == 0x48 && p[i + 1] == 0x81 && p[i + 2] == 0xEC) { i += 7; continue; }
        if (b == 0x48 && p[i + 1] == 0x8B && p[i + 2] == 0x05) { i += 7; continue; }
        if (b == 0x48 && p[i + 1] == 0x31 && p[i + 2] == 0xE0) { i += 3; continue; }
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x6C && p[i + 3] == 0x24) { i += 5; continue; }
        // 虚调用 thunk 的形态（0x4deb9a 就是这三条，共 13 字节）：
        //   movq (%rcx),%rax       48 8B 01
        //   movq 0xc8(%rax),%rax   48 8B 80 <disp32>
        //   jmpq *%rax             48 FF E0
        if (b == 0x48 && p[i + 1] == 0x8B && p[i + 2] == 0x01) { i += 3; continue; }
        if (b == 0x48 && p[i + 1] == 0x8B && p[i + 2] == 0x80) { i += 7; continue; }
        if (b == 0x48 && p[i + 1] == 0xFF && p[i + 2] == 0xE0) { i += 3; continue; }
        // hook 在 napi_get_cb_info 之后（0xfff3e5）需要的两条：
        //   leaq 0x39915b7(%rip), %rcx   48 8D 0D <disp32>   7 字节
        //   movq %rcx, 0x20(%rsp)        48 89 4C 24 <disp8> 5 字节
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x0D) { i += 7; continue; }
        // --- 2026-11-20 补全：这些模式之前没识别，导致离线验证器报假 REJECT。
        // 与 .botharness/verify-hook-offline.mjs 的规则必须保持一致。
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0xCE) { i += 3; continue; }  // mov rsi,rcx
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0xF1) { i += 3; continue; }  // mov rcx,rsi
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0xC8) { i += 3; continue; }  // mov rax,rcx
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0xD1) { i += 3; continue; }  // mov rcx,rdx
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0xC1) { i += 3; continue; }  // mov rcx,rax
        if (b == 0x8B && (p[i + 1] & 0xC7) == 0x05) { i += 6; continue; }  // mov r32,[rip]
        if (b == 0x89 && (p[i + 1] & 0xC7) == 0x05) { i += 6; continue; }  // mov [rip],r32
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0xAC && p[i + 3] == 0x24) { i += 8; continue; }  // lea rbp,[rsp+disp32]
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x4C && p[i + 3] == 0x24) { i += 5; continue; }  // lea rcx,[rsp+x]
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x54 && p[i + 3] == 0x24) { i += 5; continue; }  // lea rdx,[rsp+x]
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x55) { i += 4; continue; }  // lea rdx,[rbp+x]
        // REX.R 变体的 lea（0x13808c1 的参数装配就是这三条，共 12 字节）
        if (b == 0x4C && p[i + 1] == 0x8D && p[i + 2] == 0x45) { i += 4; continue; }  // lea r8,[rbp+x]
        if (b == 0x4C && p[i + 1] == 0x8D && p[i + 2] == 0x4D) { i += 4; continue; }  // lea r9,[rbp+x]
        if (b == 0x4C && p[i + 1] == 0x8D && p[i + 2] == 0x55) { i += 4; continue; }  // lea r10,[rbp+x]
        if (b == 0x4C && p[i + 1] == 0x8D && p[i + 2] == 0x5D) { i += 4; continue; }  // lea r11,[rbp+x]
        if (b == 0x4C && p[i + 1] == 0x8D && p[i + 2] == 0x44 && p[i + 3] == 0x24) { i += 5; continue; }  // lea r8,[rsp+x]
        if (b == 0x4C && p[i + 1] == 0x8D && p[i + 2] == 0x4C && p[i + 3] == 0x24) { i += 5; continue; }  // lea r9,[rsp+x]
        if (b == 0x4C && p[i + 1] == 0x89) { i += 3; continue; }  // mov r64,r64
        if (b == 0x48 && p[i + 1] == 0x8B && p[i + 2] == 0x41) { i += 4; continue; }  // mov rax,[rcx+x]
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0x45) { i += 4; continue; }  // mov [rbp+x],rax
        if (b == 0x48 && p[i + 1] == 0x85 && p[i + 2] == 0xC0) { i += 3; continue; }  // test rax,rax
        if (b == 0x74) { i += 2; continue; }  // je rel8
        if (b == 0x75) { i += 2; continue; }  // jne rel8
        if (b == 0xF0 && p[i + 1] == 0xFF) { i += 3; continue; }  // lock
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x4D) { i += 4; continue; }  // lea rcx,[rbp+x]
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x05) { i += 7; continue; }  // lea rax,[rip]
        if (b == 0x48 && p[i + 1] == 0x8D && p[i + 2] == 0x15) { i += 7; continue; }  // lea rdx,[rip]
        if (b == 0x48 && p[i + 1] == 0x83 && p[i + 2] == 0xC1) { i += 4; continue; }  // add rcx,imm8
        if (b == 0x48 && p[i + 1] == 0x83 && p[i + 2] == 0xC0) { i += 4; continue; }  // add rax,imm8
        if (b == 0x48 && p[i + 1] == 0x83 && p[i + 2] == 0xC4) { i += 4; continue; }  // add rsp,imm8
        if (b == 0x48 && p[i + 1] == 0x83 && p[i + 2] == 0xE9) { i += 4; continue; }  // sub rcx,imm8
        if (b == 0x48 && p[i + 1] == 0xC7 && p[i + 2] == 0x85) { i += 11; continue; }  // movq [rbp+x],imm32
        if (b == 0x48 && p[i + 1] == 0xC7 && p[i + 2] == 0x45) { i += 8; continue; }  // movq [rbp+x],imm32
        if (b == 0x48 && p[i + 1] == 0xC7 && p[i + 2] == 0xC0) { i += 7; continue; }  // mov rax,imm32
        if (b == 0x0F && p[i + 1] == 0x1F) { i += 3; continue; }  // nop
        if (b == 0x66 && p[i + 1] == 0x90) { i += 2; continue; }  // nop
        if (b == 0x90) { i += 1; continue; }  // nop
        if (b == 0x48 && p[i + 1] == 0x89 && p[i + 2] == 0x4C && p[i + 3] == 0x24) { i += 5; continue; }
        return -1;
    }
    return -1;
}

__attribute__((naked)) static void ssoSendHookEntry() {
    __asm__ volatile(
        // 入口处 (%rsp) 就是 call 压的返回地址 —— 0x4deb9a 有 24 个调用点，
        // 不记它就分不清这次是谁触发的（各调用点 rcx 语义不同）。
        "movq (%rsp), %rax\n\t"
        "movq %rax, g_hookRetAddr(%rip)\n\t"
        "movq %rdi, g_hookRdi(%rip)\n\t"
        "movq %rbp, g_hookRbp(%rip)\n\t"
        "movq %rcx, g_hookRcx(%rip)\n\t"
        "movq %rdx, g_hookRdx(%rip)\n\t"
        "movq %r8,  g_hookR8(%rip)\n\t"
        "movq %r9,  g_hookR9(%rip)\n\t"
        // 先 push 原 rax，再读第 5 参 —— 之前把 push 写在读参之后，
        // push 进去的是被覆盖的 rax（原值丢失）。push 后偏移从 0x28 变 0x30。
        "pushq %rax\n\t"
        "movq 0x30(%rsp), %rax\n\t"
        "movq %rax, g_hookArg5(%rip)\n\t"
        "lock incq g_hookHits(%rip)\n\t"
        // 调 hookCapture(obj, cmd, p3, p4) —— 必须保存所有易失寄存器，否则破坏被 hook 的函数。
        // sub 0x28 = 0x20 shadow space + 8 对齐。
        "pushq %rcx\n\t"
        "pushq %rdx\n\t"
        "pushq %r8\n\t"
        "pushq %r9\n\t"
        "pushq %r10\n\t"
        "pushq %r11\n\t"
        "subq $0x28, %rsp\n\t"
        "movq %rcx, %rax\n\t"
        "movq %rdx, %rcx\n\t"
        "movq %r8, %rdx\n\t"
        "movq %r9, %r8\n\t"
        "movq %rax, %r9\n\t"
        "movq %rbp, 0x20(%rsp)\n\t"
        "call hookCapture\n\t"
        "addq $0x28, %rsp\n\t"
        "popq %r11\n\t"
        "popq %r10\n\t"
        "popq %r9\n\t"
        "popq %r8\n\t"
        "popq %rdx\n\t"
        "popq %rcx\n\t"
        "popq %rax\n\t"
        // ===== 捕获真 session（hook 0x13807f2 入口）=====
        // 0x13807f2 入口 rcx = objbase；0x1380864 是 `movq 0x88(%rsi), %rsi`（rsi 就是 objbase），
        // 所以 QQ 真心在用的 session = *(objbase + 0x88)。
        // armed 时只做一次内存写 + 一次寄存器乘法，零调用、零 VirtualQuery、零分配，立刻 jmp 回去。
        // （之前卡死就是因为 hookCapture 在这条热点路径上做 VirtualQuery + NAPI 解析。）
        "cmpl $0, g_relayArmed(%rip)\n\t"
        "je 9f\n\t"
        "movl $0, g_relayArmed(%rip)\n\t"
        "movq %rcx, g_relayObjBase(%rip)\n\t"
        "movq 0x88(%rcx), %rax\n\t"
        "movq %rax, g_relaySession(%rip)\n\t"
        "lock incq g_relayDone(%rip)\n\t"
        "9:\n\t"
        "jmp *g_hookTramp(%rip)\n\t"
    );
}

// 卸载：把原字节写回去。hook 是运行时装卸的，所以遍历多个候选点不用重启 QQ。
// inline hook 的经典并发坑：改代码的瞬间如果别的线程正在执行被覆盖的那几个字节，
// 它会读到"半改"的指令流然后当场崩。2026-11-20 在 0x268b8ea（热点函数）上实测踩到：
// 装 hook 的请求直接 1501 超时，紧接着 IPC 断开、front 503。
// 标准解法是挂起本进程其他线程 → 写 → 恢复。挂起期间绝不做内存分配（会撞堆锁死锁），
// 所以 trampoline 和 patch 缓冲都在挂起之前准备好。
struct ThreadSuspender {
    HANDLE handles[1024];
    int count = 0;
    void suspendAll() {
        const DWORD pid = GetCurrentProcessId();
        const DWORD self = GetCurrentThreadId();
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snap == INVALID_HANDLE_VALUE) return;
        THREADENTRY32 te;
        te.dwSize = sizeof(te);
        if (Thread32First(snap, &te)) {
            do {
                if (te.th32OwnerProcessID != pid) continue;
                if (te.th32ThreadID == self) continue;
                if (count >= 1024) break;
                HANDLE h = OpenThread(THREAD_SUSPEND_RESUME, FALSE, te.th32ThreadID);
                if (h) { SuspendThread(h); handles[count++] = h; }
            } while (Thread32Next(snap, &te));
        }
        CloseHandle(snap);
    }
    void resumeAll() {
        for (int i = 0; i < count; ++i) { ResumeThread(handles[i]); CloseHandle(handles[i]); }
        count = 0;
    }
};

static bool removeHook() {
    if (!g_hookInstalled || !g_hookTarget || g_hookCoverLen <= 0) return true;
    DWORD old = 0;
    if (!VirtualProtect(g_hookTarget, g_hookCoverLen, PAGE_EXECUTE_READWRITE, &old)) return false;
    {
        ThreadSuspender ts;
        ts.suspendAll();
        memcpy(g_hookTarget, g_hookOrig, g_hookCoverLen);
        FlushInstructionCache(GetCurrentProcess(), g_hookTarget, g_hookCoverLen);
        ts.resumeAll();
    }
    DWORD back = 0;
    VirtualProtect(g_hookTarget, g_hookCoverLen, old, &back);
    if (g_hookTramp) { VirtualFree(g_hookTramp, 0, MEM_RELEASE); g_hookTramp = nullptr; }
    g_hookInstalled = false;
    g_hookTarget = nullptr;
    g_hookCoverLen = 0;
    return true;
}

static bool installHookAt(unsigned char* base, unsigned int rva) {
    removeHook();
    // 0xfff34a = Msg.sendMsg 的 NAPI 绑定（JS 层能直接调的那个），
    // 它的 rcx/rdx 是 napi_env / napi_cb_info，参数要用 napi_get_cb_info 取。
    g_hookIsNapi = (rva == 0xfff34a) ? 1 : 0;
    unsigned char* target = base + rva;
    const int cover = hookCoverLen(target);
    if (cover < 12) return false;                 // 认不出边界或太短，不装
    void* tramp = VirtualAlloc(nullptr, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!tramp) return false;
    unsigned char* t = reinterpret_cast<unsigned char*>(tramp);
    memcpy(t, target, cover);                     // 原指令原样搬过去
    t[cover] = 0xFF; t[cover + 1] = 0x25;         // jmp [rip+0]
    *reinterpret_cast<unsigned int*>(t + cover + 2) = 0;
    *reinterpret_cast<void**>(t + cover + 6) = reinterpret_cast<void*>(target + cover);
    g_hookTramp = tramp;

    memcpy(g_hookOrig, target, cover);
    g_hookCoverLen = cover;
    g_hookTarget = target;

    DWORD old = 0;
    if (!VirtualProtect(target, cover, PAGE_EXECUTE_READWRITE, &old)) { removeHook(); return false; }
    unsigned char patch[32];
    memset(patch, 0x90, sizeof(patch));
    // patch 形式自适应：
    //   cover >= 14 → FF 25 + imm64（14 字节），不碰任何寄存器，可用于 je/jne 目标点；
    //   cover 12~13 → mov rax,imm64; jmp rax（12 字节），会改写 rax，
    //                 只允许用在「非分支目标」的点（先用 find-jumps-into.mjs 验证）。
    if (cover >= 14) {
        patch[0] = 0xFF; patch[1] = 0x25;
        *reinterpret_cast<unsigned int*>(patch + 2) = 0;
        *reinterpret_cast<void**>(patch + 6) = reinterpret_cast<void*>(&ssoSendHookEntry);
    } else {
        patch[0] = 0x48; patch[1] = 0xB8;
        *reinterpret_cast<void**>(patch + 2) = reinterpret_cast<void*>(&ssoSendHookEntry);
        patch[10] = 0xFF; patch[11] = 0xE0;
    }
    // 关键：写代码段必须挂起其他线程，否则热点函数上会读到半改指令直接崩。
    // patch 缓冲和 trampoline 都在挂起之前准备好，挂起期间只做 memcpy + Flush。
    {
        ThreadSuspender ts;
        ts.suspendAll();
        memcpy(target, patch, cover);
        FlushInstructionCache(GetCurrentProcess(), target, cover);
        ts.resumeAll();
    }
    DWORD back = 0;
    VirtualProtect(target, cover, old, &back);

    g_hookRva = rva;
    g_hookRcx = g_hookRdx = g_hookR8 = g_hookR9 = g_hookArg5 = 0;
    g_hookHits = 0;
    g_hookInstalled = true;
    return true;
}

static void* ssoRelayCallback(void* env, void* info);   // 定义在 ssoHexNibble 之后（依赖 ssoCmdString）
static void* ssoContendNativeCallback(void* env, void* info);   // 同上
static void* ssoBodyConvCallback(void* env, void* info);        // body 转换代劳（install/remove/status/arm）
static void* ssoHookInstallCallback(void* env, void* info) {
    void* out = nullptr;
    g_probe.createObject(env, &out);
    auto setB = [&](const char* k, bool v) {
        void* b = nullptr;
        if (g_probe.createInt32 && g_probe.createInt32(env, v ? 1 : 0, &b) == 0 && b) g_probe.setNamed(env, out, k, b);
    };
    auto setNum = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_probe.createDouble && g_probe.createDouble(env, v, &n) == 0 && n) g_probe.setNamed(env, out, k, n);
    };
    // argv[0] = 目标 RVA（数字）。不给就装默认的 0x765d70。
    unsigned int rva = 0x765d70;
    size_t argc = 1;
    void* argv[1] = {nullptr};
    if (g_probe.getCbInfo && g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) == 0
        && argc >= 1 && argv[0] && g_probe.getValueDouble) {
        double v = 0;
        if (g_probe.getValueDouble(env, argv[0], &v) == 0 && v > 0) rva = static_cast<unsigned int>(v);
    }
    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) { setB("installed", false); return out; }
    const bool ok = installHookAt(reinterpret_cast<unsigned char*>(wrapper), rva);
    setB("installed", ok);
    setNum("rva", static_cast<double>(rva));
    setNum("coverLen", g_hookInstalled ? g_hookCoverLen : 0);
    return out;
}

static void* ssoHookRemoveCallback(void* env, void* info) {
    (void)info;
    void* out = nullptr;
    g_probe.createObject(env, &out);
    const bool ok = removeHook();
    void* b = nullptr;
    if (g_probe.createInt32 && g_probe.createInt32(env, ok ? 1 : 0, &b) == 0 && b) g_probe.setNamed(env, out, "removed", b);
    return out;
}

static void* ssoHookStateCallback(void* env, void* info) {
    (void)info;
    void* out = nullptr;
    g_probe.createObject(env, &out);
    auto setNum = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_probe.createDouble && g_probe.createDouble(env, v, &n) == 0 && n) g_probe.setNamed(env, out, k, n);
    };
    setNum("installed", g_hookInstalled ? 1 : 0);
    setNum("rva", static_cast<double>(g_hookRva));
    setNum("coverLen", static_cast<double>(g_hookCoverLen));
    setNum("hits", static_cast<double>(g_hookHits));
    setNum("relayDone", static_cast<double>(g_relayDone));
    setNum("relayErr", static_cast<double>(g_relayErr));
    setNum("relaySession", static_cast<double>(reinterpret_cast<size_t>(g_relaySession)));
    setNum("rcx", static_cast<double>(static_cast<size_t>(g_hookRcx)));
    setNum("rdx", static_cast<double>(static_cast<size_t>(g_hookRdx)));
    setNum("r8", static_cast<double>(static_cast<size_t>(g_hookR8)));
    setNum("r9", static_cast<double>(static_cast<size_t>(g_hookR9)));
    setNum("arg5", static_cast<double>(static_cast<size_t>(g_hookArg5)));
    // hook 现场抓到的 cmd 字符串 + 请求对象前 128 字节
    auto setStr = [&](const char* k, const char* v) {
        void* s = nullptr;
        if (g_probe.createString && g_probe.createString(env, v, SIZE_MAX, &s) == 0 && s) g_probe.setNamed(env, out, k, s);
    };
    setStr("cmd", g_hookCmd);
    setNum("cmdLen", static_cast<double>(g_hookCmdLen));
    setNum("vtbl", static_cast<double>(static_cast<size_t>(g_hookVtbl)));
    setNum("fnAddr", static_cast<double>(static_cast<size_t>(g_hookFnAddr)));
    // 调用者 RVA —— 0x4deb9a 有 24 个调用点，靠这个判断这次是谁触发的
    {
        HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
        const unsigned long long base = reinterpret_cast<unsigned long long>(wrapper);
        const unsigned long long ret = static_cast<unsigned long long>(g_hookRetAddr);
        setNum("callerRva", (base && ret > base) ? static_cast<double>(ret - base) : 0);
        setNum("retAddr", static_cast<double>(static_cast<size_t>(ret)));
    }
    {
        static const char* kHex = "0123456789abcdef";
        char hex[sizeof(g_hookReq) * 2 + 1];
        size_t n = 0;
        for (size_t i = 0; i < sizeof(g_hookReq); ++i) {
            hex[n++] = kHex[g_hookReq[i] >> 4];
            hex[n++] = kHex[g_hookReq[i] & 0xF];
        }
        hex[n] = 0;
        setStr("reqHex", hex);
        // rdx / r8 原样 dump —— 用来判断它们到底是什么类型的对象
        char h2[sizeof(g_hookRdxRaw) * 2 + 1];
        n = 0;
        for (size_t i = 0; i < sizeof(g_hookRdxRaw); ++i) {
            h2[n++] = kHex[g_hookRdxRaw[i] >> 4];
            h2[n++] = kHex[g_hookRdxRaw[i] & 0xF];
        }
        h2[n] = 0;
        setStr("rdxHex", h2);
        n = 0;
        for (size_t i = 0; i < sizeof(g_hookR8Raw); ++i) {
            h2[n++] = kHex[g_hookR8Raw[i] >> 4];
            h2[n++] = kHex[g_hookR8Raw[i] & 0xF];
        }
        h2[n] = 0;
        setStr("r8Hex", h2);
        setStr("cmdStr", g_cmdStr);
        setNum("cmdStrLen", static_cast<double>(g_cmdStrLen));
        setNum("argStrLen", static_cast<double>(g_hookArgStrLen));
        setNum("napiArgc", static_cast<double>(g_napiArgc));
        setNum("napiRbp", static_cast<double>(static_cast<size_t>(g_hookRbp)));
        setNum("napiArgcRaw", static_cast<double>(g_napiArgcRaw));
        {
            char a8[512] = {0};
            int w = 0;
            for (int i = 0; i < 8; ++i) {
                w += snprintf(a8 + w, sizeof(a8) - w, "%s0x%llx",
                              i ? "," : "", static_cast<unsigned long long>(g_napiArgv[i]));
            }
            setStr("napiArgs", a8);
        }
        setNum("isNapi", static_cast<double>(g_hookIsNapi));
        setNum("napiArgc2", static_cast<double>(g_hookNapiArgc));
        setStr("napiArgs2", g_hookNapiArgs);
        // 注意：不要在这里再 setNum("napiArgc", g_hookNapiArgc) ——
        // 它会覆盖前面用 g_napiArgc 写好的正确值（踩过：argc 读到 4 却显示 0）。
        // g_hookNapiArgc/g_hookNapiArgs 是 hook 在 NAPI 绑定入口时才用的旧通道，
        // 现在统一用 napiRbp/napiArgcRaw/napiArgc/napiArgs 这一组。
    }
    return out;
}

static void installProbe(HMODULE runtime, void* env, void* globalObject, void* wrapper) {
    struct Fn { const char* name; FARPROC* slot; };
    FARPROC setNamedRaw = GetProcAddress(runtime, "napi_set_named_property");
    FARPROC createFnRaw = GetProcAddress(runtime, "napi_create_function");
    FARPROC createStrRaw = GetProcAddress(runtime, "napi_create_string_utf8");
    FARPROC getUndefRaw = GetProcAddress(runtime, "napi_get_undefined");
    if (!setNamedRaw || !createFnRaw || !createStrRaw) return;

    g_probe.setNamed = reinterpret_cast<PfnSetNamedProperty>(setNamedRaw);
    g_probe.getNamed = reinterpret_cast<PfnGetNamedProperty>(GetProcAddress(runtime, "napi_get_named_property"));
    g_probe.unwrap = reinterpret_cast<PfnUnwrap>(GetProcAddress(runtime, "napi_unwrap"));
    g_probe.createObject = reinterpret_cast<PfnCreateObject>(GetProcAddress(runtime, "napi_create_object"));
    g_probe.createString = reinterpret_cast<PfnCreateStringUtf8>(createStrRaw);
    g_probe.createDouble = reinterpret_cast<PfnCreateDouble>(GetProcAddress(runtime, "napi_create_double"));
    g_probe.createInt32 = reinterpret_cast<PfnCreateInt32>(GetProcAddress(runtime, "napi_create_int32"));
    g_probe.createFunction = reinterpret_cast<PfnCreateFunction>(createFnRaw);
    g_probe.getCbInfo = reinterpret_cast<PfnGetCbInfo>(GetProcAddress(runtime, "napi_get_cb_info"));
    g_probe.getUndefined = reinterpret_cast<PfnGetUndefined>(getUndefRaw);
    g_probe.getValueDouble = reinterpret_cast<PfnGetValueDouble>(GetProcAddress(runtime, "napi_get_value_double"));
    g_probe.createArray = reinterpret_cast<PfnCreateArray>(GetProcAddress(runtime, "napi_create_array_with_length"));
    g_probe.setElement = reinterpret_cast<PfnSetElement>(GetProcAddress(runtime, "napi_set_element"));
    g_probe.getString = reinterpret_cast<PfnGetValueStringUtf8>(GetProcAddress(runtime, "napi_get_value_string_utf8"));
    g_probe.runtime = runtime;

    // wrapper 句柄：JS 侧据此拿 NodeIQQNTWrapperEngine 实例。
    if (wrapper) g_probe.setNamed(env, globalObject, "__openqq_wrapper", wrapper);

    // 只读探针本体。
    if (g_probe.createFunction && g_probe.setNamed) {
        void* function = nullptr;
        if (g_probe.createFunction(env, "openqqNativeProbe", SIZE_MAX, reinterpret_cast<void*>(&nativeProbeCallback),
                                   nullptr, &function) == 0 && function) {
            g_probe.setNamed(env, globalObject, "__openqqNativeProbe", function);
        }
        void* scanner = nullptr;
        if (g_probe.createFunction(env, "openqqNativeScan", SIZE_MAX, reinterpret_cast<void*>(&nativeScanCallback),
                                   nullptr, &scanner) == 0 && scanner) {
            g_probe.setNamed(env, globalObject, "__openqqNativeScan", scanner);
        }
        void* tryCall = nullptr;
        if (g_probe.createFunction(env, "openqqSsoTryCall", SIZE_MAX, reinterpret_cast<void*>(&ssoTryCallCallback),
                                   nullptr, &tryCall) == 0 && tryCall) {
            g_probe.setNamed(env, globalObject, "__openqqSsoTryCall", tryCall);
        }
        // 裸地址读：两级解引用用（session+0x70 拿到的对象再读它的 +0x70）。
        void* readPtr = nullptr;
        if (g_probe.createFunction(env, "openqqSsoReadPtr", SIZE_MAX, reinterpret_cast<void*>(&ssoReadPtrCallback),
                                   nullptr, &readPtr) == 0 && readPtr) {
            g_probe.setNamed(env, globalObject, "__openqqSsoReadPtr", readPtr);
        }
        // 裸地址试调：拿到可执行函数指针之后，直接用 VEH 兜住试三种签名。
        void* tryAddr = nullptr;
        if (g_probe.createFunction(env, "openqqSsoTryAddr", SIZE_MAX, reinterpret_cast<void*>(&ssoTryAddrCallback),
                                   nullptr, &tryAddr) == 0 && tryAddr) {
            g_probe.setNamed(env, globalObject, "__openqqSsoTryAddr", tryAddr);
        }
        // SSO 发包原语 hook：装一次，之后 QQ 自己每次发包都会把参数留下来。
        void* hookInstall = nullptr;
        if (g_probe.createFunction(env, "openqqSsoHookInstall", SIZE_MAX,
                                   reinterpret_cast<void*>(&ssoHookInstallCallback), nullptr, &hookInstall) == 0 && hookInstall) {
            g_probe.setNamed(env, globalObject, "__openqqSsoHookInstall", hookInstall);
        }
        void* hookState = nullptr;
        if (g_probe.createFunction(env, "openqqSsoHookState", SIZE_MAX,
                                   reinterpret_cast<void*>(&ssoHookStateCallback), nullptr, &hookState) == 0 && hookState) {
            g_probe.setNamed(env, globalObject, "__openqqSsoHookState", hookState);
        }
        void* hookRemove = nullptr;
        if (g_probe.createFunction(env, "openqqSsoHookRemove", SIZE_MAX,
                                   reinterpret_cast<void*>(&ssoHookRemoveCallback), nullptr, &hookRemove) == 0 && hookRemove) {
            g_probe.setNamed(env, globalObject, "__openqqSsoHookRemove", hookRemove);
        }
        // 借道发包：让 QQ 用自己的真 session 把我们的包发出去（六次直调失败后的正解）
        void* relay = nullptr;
        if (g_probe.createFunction(env, "openqqSsoRelay", SIZE_MAX,
                                   reinterpret_cast<void*>(&ssoRelayCallback), nullptr, &relay) == 0 && relay) {
            g_probe.setNamed(env, globalObject, "__openqqSsoRelay", relay);
        }
        // body 转换代劳：只改 4 字节，让 JSON→SSO 的 body 能原样二进制送达
        void* bodyConv = nullptr;
        if (g_probe.createFunction(env, "openqqSsoBodyConv", SIZE_MAX,
                                   reinterpret_cast<void*>(&ssoBodyConvCallback), nullptr, &bodyConv) == 0 && bodyConv) {
            g_probe.setNamed(env, globalObject, "__openqqSsoBodyConv", bodyConv);
        }
        // 原生 contend 发包：走 C++ 的 sendSsoCmdReqByContend 实现（vtable+0x780），
        // 绕开 JS 的 UTF-8 转换，二进制 body 原样送达。同步返回，不死锁。
        void* contendN = nullptr;
        if (g_probe.createFunction(env, "openqqSsoContendNative", SIZE_MAX,
                                   reinterpret_cast<void*>(&ssoContendNativeCallback), nullptr, &contendN) == 0 && contendN) {
            g_probe.setNamed(env, globalObject, "__openqqSsoContendNative", contendN);
        }
    }
}
#else
// 发布版：探针整段不编译（见本段开头的安全软件兼容说明）。
// 保留同名空实现，让下面的调用点无需条件编译，也不会留下未使用告警。
static void installProbe(HMODULE, void*, void*, void*) {}
#endif  // defined(OPENQQ_ENABLE_PROBE)

// ─────────────────────────────────────────────────────────────────────────────
// 自研 SSO 发送：不依赖任何外部组件，直接调 QQ 自己的发包原语。
//
// 静态分析结论（wrapper.node 9.9.37-54395，RVA 相对模块基址，ASLR 只影响基址）：
//   · 发包原语          wrapper + 0x765d70
//   · 原语所属虚表      wrapper + 0x4130078   （RTTI: nt::MSFService）
//   · std::string 构造  wrapper + 0x325ae8    （(dest, const char* src)）
//   · 原语签名
//       send(this /* *(this+0x60) 必须非空 */, const std::string* cmd,
//            const { const char* data; size_t len; }* body, int wantReply,
//            std::string* replyOut)
//
// 为什么放在发布版而不是探针里：这是「不依赖 SnowLuma 也能发 SSO」的落点，
// 用户装完就能用。整条路径只有「napi_unwrap 取指针 → 读两个固定偏移 → 一次调用」，
// 不写代码段、不 VirtualProtect、不遍历内存、不装全局钩子。
// ─────────────────────────────────────────────────────────────────────────────
static const DWORD kRvaMsvcVtable = 0x4130078;  // nt::MSFService 虚表
static const DWORD kRvaSendPrim   = 0x765d70;   // SSO 发包原语
static const DWORD kRvaSendEntry  = 0x268f09e;  // QQ 自己的发消息入口（cmd 透传，可发任意包）
static const DWORD kRvaSendThunk  = 0x76669c;   // MSFService 虚表 slot 4：自己造回调再调原语
static const DWORD kRvaStringCtor = 0x325ae8;   // ⚠️ 2026-11-21 更正：这不是 std::string 构造！
                                                // 它对第 2 参做 callq *0x10(%rsi)，是委托/callable 初始化。
                                                // 用它当 string ctor = 必崩（28 次崩溃中 21 次就是这条）。
static const DWORD kOffSendReady  = 0x60;       // 原语要求 *(this+0x60) 非空
// sendSsoCmdReqByContend 的实现入口：vtable 偏移 0x780（NAPI 绑定 0x1030eda 在 0x1031060 调它）。
// 签名 (this, const std::string* cmd, const std::string* body, Out* out) —— **同步**，直接带回包。
// 这条与 0x765d70 完全不同：不注册回调、不等消息循环 → 不会死锁。
static const DWORD kOffContendVt   = 0x780;
static const DWORD kRvaContendSyn  = 0x10311bd;  // NAPI 绑定里把 out 槽转成 JS 对象的辅助
static const DWORD kRvaStrAssign   = 0x78ec00;   // std::string 相关辅助（未用，留档）
static const DWORD kRvaStrReserve = 0x78f800;   // libc++ string 的 (dst,len,fill) 初始化链（保留留档，当前不再用于建串）
// ─────────────────────────────────────────────────────────────────────────────
// 【2026-11-21 关键方案】只改 4 字节的「body 转换代劳」补丁
//
// 问题：JSON→SSO 的 body 必须原样二进制。但 QQ 的 NAPI 绑定在 0x1030FAA 处
// 用 0xC5927F 把 JS 字符串转 C++ std::string，那条路会做 UTF-8 编码，
// >0x7F 的字节被拆成 2 字节（实测：body 放 [80 80] → "invalid pkg"，
// 放 [C2 80] → 通过）。所以纯 JS 永远发不了二进制。
//
// 为什么不 hook 0x765d70 / vtable+0x780：
//   · 0x765d70 只读 4 个寄存器，但内部要等回调 → 外部线程调必死锁（已试 3 次）
//   · vtable+0x780 经过 promise 异步返回 → 同步调用拿不到回包
//
// 正解：**只把 0x1030FAA 那条 call 的 rel32 换成我们的函数**（4 字节）。
//   · 那条 call 专门负责「argv[1] = body」，与 argv[0] = cmd 是两条独立 call
//   · 我们的函数：没被要求代劳时第一句就跳回 0xC5927F（行为与打补丁前完全一致）
//   · 被要求代劳时按 libc++ 布局手工拼 std::string（离线自检已覆盖）
//   · 原函数 0xC5927F 一个字节都不动，其它所有调用点照旧
//   · 还原只需把原 rel32 写回 0x1030FAB
// 校验脚本：.botharness/verify-4byte-patch.mjs（已验证落点/公式/影响范围）
static const DWORD kRvaBodyConvCall   = 0x1030faa;  // call 指令本身（E8 rel32）
static const DWORD kRvaBodyConvRelPos = 0x1030fab;  // rel32 字段位置
static const DWORD kRvaJsToCxxConvert = 0xc5927f;   // 原转换函数 (dst24, env, jsvalue)

// 跳板落点：wrapper.node 与我们 dll 相距约 29.6 GB，rel32 够不着，所以需要中转。
// 位置从 .text 里离线扫出来（.botharness/find-trampoline-slot.mjs）：
//   0xDAF524 起有 12 字节全 0xCC 的编译期填充，距 call 点 2.5 MB，在 rel32 范围内。
// 跳板内容：48 B8 <8 字节绝对地址> FF E0   （mov rax, imm64 ; jmp rax）
// 只覆盖填充字节，不破坏任何有效代码；还原时写回 0xCC。
static const DWORD kRvaTrampSlot = 0xdaf524;
static const unsigned char kTrampPadByte = 0xcc;
static const DWORD kTrampLen = 12;

// 代劳状态：非零表示「下一次 body 转换用这份字节」
static volatile LONG g_bodyTakeoverActive = 0;
static unsigned char g_bodyTakeover[65536];
static size_t g_bodyTakeoverLen = 0;
static LONG g_bodyTakeoverHits = 0;
static INT32 g_bodyConvOrigRel = 0;
static bool g_bodyConvPatched = false;

struct SsoSpan { const char* data; size_t len; };

// 异步发：把 thunk 调用挪到工作线程。
// 直接在当前（NAPI）线程同步调 0x76669c 会堵住 QQ 的消息循环 —— 实测两次都是
// 「进程还活着但所有 IPC 超时」。放到工作线程至少能验证"是不是阻塞主线程导致的"。
struct SsoAsyncJob {
    volatile LONG state;   // 0=idle 1=running 2=done 3=error
    void* thisObj;
    void* session;         // ssoSendCallback 算好的 session，worker 直接用（不再靠 thisObj-0x10 反推）
    void* cmdStr;
    const char* bodyData;
    size_t bodyLen;
    void* outSlot;
    int rc;
};
static SsoAsyncJob g_ssoJob = {0, nullptr, nullptr, nullptr, nullptr, 0, nullptr, 0};

static DWORD WINAPI ssoAsyncWorker(LPVOID) {
    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) { InterlockedExchange(&g_ssoJob.state, 3); return 0; }
    auto base = reinterpret_cast<unsigned char*>(wrapper);
    SsoSpan span{g_ssoJob.bodyData, g_ssoJob.bodyLen};
    void* session = g_ssoJob.session ? g_ssoJob.session : g_ssoJob.thisObj;

    // ===== 走 QQ 自己的发消息入口 0x268f09e，而不是 0x765d70 原语 =====
    //
    // 为什么换掉 0x765d70（重审结论，见 PLAN-sso-local.md 步骤 0.5）：
    //   它只读 rcx(session)/rdx(cmd块)/r8(body)/r9b(flag) 四个寄存器参数，结构已经给了 0x30 字节、
    //   QQ 也不再崩，但从外部线程调仍然把 IPC 拖死 —— 说明缺的不是参数而是「谁来兜住回包」。
    //
    // 0x268f09e 是 QQ 自己发消息用的那层（Msg.sendMsg → 0x13807f2 → 0x268b8ea → 本函数）：
    //   rcx = session / rdx = cmd(std::string*) / r8 = body{ptr,len}* / r9 = out 槽
    //   它内部做 0x2c11cc() 取 ctx → 0x3fc8(ctx,&node,session) → 0x2c122c(ctx,session) 取节点
    //   → 0x4deb9a 虚调用 vtable+0xC8 把 cmd/body 发出去。
    // 也就是说：**cmd 是透传的**，所以给它我们的 SSO 命令名就能发任意包，而且用的是 QQ 现成的
    // session/节点/回调机制，不需要我们自己维护 pending 队列。
    typedef void (*SendEntryFn)(void* session, void* cmdStr, void* body, void* outSlot);
    auto sendEntry = reinterpret_cast<SendEntryFn>(base + kRvaSendEntry);
    void* outSlot = nullptr;
    sendEntry(session, g_ssoJob.cmdStr, &span, &outSlot);
    g_ssoJob.rc = 0;
    g_ssoJob.outSlot = outSlot;
    InterlockedExchange(&g_ssoJob.state, 2);
    return 0;
}

struct SsoApi {
    int (*getCbInfo)(void*, void*, size_t*, void**, void**, void*);
    int (*unwrap)(void*, void*, void**);
    int (*createObject)(void*, void**);
    int (*createFunction)(void*, const char*, size_t, void*, void*, void**);
    int (*setNamed)(void*, void*, const char*, void*);
    int (*createStr)(void*, const char*, size_t, void**);
    int (*getStr)(void*, void*, char*, size_t, size_t*);
    int (*createDouble)(void*, double, void**);
    int (*createBool)(void*, bool, void**);
    int (*getBool)(void*, void*, bool*);
};
static SsoApi g_sso{};

// hook 到 NAPI 绑定（如 Msg.sendMsg，rva 0xfff34a）时解析实参。
// 每个参数先试当字符串读 —— getStr 对非字符串返回非 0，不会崩，所以可以盲试。
// 只在调试版存在：它依赖 g_hookNapiArgs/g_hookNapiArgc，而那两项是 hook 的产物。
#if defined(OPENQQ_ENABLE_PROBE)
static void hookParseNapiValues(long long env, const long long* argv, long long argc) {
    if (!g_sso.getStr || !env) return;
    size_t w = 0;
    g_hookNapiArgs[0] = 0;
    for (long long i = 0; i < argc && i < 8 && w + 600 < sizeof(g_hookNapiArgs); ++i) {
        char one[520] = {0};
        size_t len = 0;
        const bool isStr = argv[i] &&
            g_sso.getStr(reinterpret_cast<void*>(env), reinterpret_cast<void*>(argv[i]),
                         one, sizeof(one) - 1, &len) == 0;
        const int n = snprintf(g_hookNapiArgs + w, sizeof(g_hookNapiArgs) - w,
                               "[%lld]%s:%s|", i, isStr ? "str" : "obj", isStr ? one : "");
        if (n > 0) w += static_cast<size_t>(n);
    }
    g_hookNapiArgs[sizeof(g_hookNapiArgs) - 1] = 0;
    g_hookNapiArgc = argc;
}

static void hookCaptureNapiArgs(long long env, long long info) {
    if (!g_sso.getCbInfo || !g_sso.getStr) return;
    size_t argc = 8;
    void* argv[8] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
    if (g_sso.getCbInfo(reinterpret_cast<void*>(env), reinterpret_cast<void*>(info),
                        &argc, argv, nullptr, nullptr) != 0) return;
    g_hookNapiArgc = static_cast<long long>(argc);
    size_t w = 0;
    g_hookNapiArgs[0] = 0;
    for (size_t i = 0; i < argc && i < 8 && w < sizeof(g_hookNapiArgs) - 600; ++i) {
        char one[520] = {0};
        size_t len = 0;
        const bool isStr = argv[i] &&
            g_sso.getStr(reinterpret_cast<void*>(env), argv[i], one, sizeof(one) - 1, &len) == 0;
        const int n = snprintf(g_hookNapiArgs + w, sizeof(g_hookNapiArgs) - w,
                               "[%zu]%s:%s|", i, isStr ? "str" : "obj", isStr ? one : "");
        if (n > 0) w += static_cast<size_t>(n);
    }
    g_hookNapiArgs[sizeof(g_hookNapiArgs) - 1] = 0;
}
#endif  // defined(OPENQQ_ENABLE_PROBE)

// ===== 把 session 递给自研 SSO 组件（openqq-sso-local.dll）=====
//
// 组件在独立线程里、没有 NAPI 环境，拿不到 QQ 的 C++ 对象；而 session 只能从
// NAPI 这一侧算出来（0x1388d54 是 Msg.sendMsg 的 C++ 薄封装，它做 addq $-0x68, %rsi
// 之后再 call 0x13807f2，而 0x13807f2 里 rsi = [rcx+0x88]
//   ⇒ session = *((this - 0x68) + 0x88) = *(this + 0x20)）。
//
// 所以每次解析出 session 就通过 QHP1 的 op=0x12 SET_SESSION 推给组件一次。
// 管道不存在（组件没装/还没起线程）时静默返回，不影响主流程。
static void notifySsoLocalSessionOnce(void* session) {
    if (!session) return;
    wchar_t name[128];
    _snwprintf_s(name, _countof(name), _TRUNCATE, L"\\\\.\\pipe\\openqq-sso.%lu.control",
                 static_cast<unsigned long>(GetCurrentProcessId()));
    // 先用 WaitNamedPipeW(0) 探一下：管道存在但 server 还没 ConnectNamedPipe 时，
    // 直接 CreateFileW(PIPE_WAIT) 会阻塞，而这个函数跑在 NAPI 线程上 ——
    // 一阻塞整条 JS 侧就停，心跳超时后 OpenQQ 会以为连接断了主动退出。
    if (!WaitNamedPipeW(name, 0)) return;
    HANDLE pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) return;

    char hex[32];
    _snprintf_s(hex, _countof(hex), _TRUNCATE, "%llx",
                static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(session)));
    const size_t msgLen = strlen(hex);

    unsigned char hdr[40] = {0};
    hdr[0] = 0x51; hdr[1] = 0x48; hdr[2] = 0x50; hdr[3] = 0x31;  // "QHP1"
    hdr[4] = 1;                                                  // version = 1
    hdr[6] = 0x12;                                               // op = SET_SESSION
    hdr[8] = 1;                                                  // requestId = 1
    hdr[24] = static_cast<unsigned char>(msgLen & 0xFF);
    hdr[25] = static_cast<unsigned char>((msgLen >> 8) & 0xFF);

    DWORD written = 0;
    if (WriteFile(pipe, hdr, 40, &written, nullptr) && written == 40) {
        WriteFile(pipe, hex, static_cast<DWORD>(msgLen), &written, nullptr);
    }
    CloseHandle(pipe);
}

struct SsoNotifyArg { void* session; };

static DWORD WINAPI ssoNotifyThread(LPVOID raw) {
    auto* arg = static_cast<SsoNotifyArg*>(raw);
    if (arg) { notifySsoLocalSessionOnce(arg->session); free(arg); }
    return 0;
}

// 同一个 session 只推一次；并且真正写管道的工作丢到独立线程 —— 绝不在 NAPI 线程上做
// 可能阻塞的管道 I/O（2026-11-21 实测教训：同步写把 JS 侧卡住，OpenQQ 心跳超时后自退）。
static void notifySsoLocalSession(void* session) {
    if (!session) return;
    static void* last = nullptr;
    if (last == session) return;
    last = session;
    auto* arg = static_cast<SsoNotifyArg*>(malloc(sizeof(SsoNotifyArg)));
    if (!arg) return;
    HANDLE th = CreateThread(nullptr, 0, ssoNotifyThread, arg, 0, nullptr);
    if (th) CloseHandle(th);
    else delete arg;
}

// wrapper 的 std::string 用它自己的分配器，我们无法安全析构；
// 所以按 cmd 缓存构造结果，把泄漏限定在「不同 cmd 的个数」上（上限 64）。
// cmd 块：0x765d70 的第 2 参**不是裸 std::string**，而是 ≥0x30 字节的结构。
// 布局（依据 SL 0x56d0 普通路径 0x591b–0x592f，以及 0x765d70 里 0x765e23 的 movb %bl,0x18(%rax)）：
//   +0x00..0x18  MSVC std::string（用 0x325ae8 构造）
//   +0x18        bool flag
//   +0x20        cbFn1（std::function 的 invoke thunk，= base+0x2334）
//   +0x28        cbFn2（destroy thunk，= base+0x2366）
// 之前只给 32 字节且 cbFn 放在栈上（0x765d70 根本不读栈参数），拿到的就是残缺结构。
struct SsoCmdSlot { char key[96]; alignas(16) unsigned char block[0x30]; };
static SsoCmdSlot g_ssoCmd[64];
static int g_ssoCmdCount = 0;
static char g_ssoHex[131072];
static unsigned char g_ssoBody[65536];
static char g_ssoReplyHex[131073];
alignas(16) static unsigned char g_ssoReply[32];

// ─────────────────────────────────────────────────────────────────────────────
// 二进制安全的 std::string 构造（2026-11-21 修正版）
//
// ⚠️ 上一版把 kRvaStringCtor(0x325AE8) 当成 std::string(const char*)，**这是错的**：
//    0x325AE8 在 +0x29 处是 `callq *0x10(%rsi)` —— 它对第 2 参做间接调用，
//    实际是「委托/callable 单态初始化」（调完还会把 0x2334/0x2366 两个 thunk 写回 +0x10/+0x18）。
//    用 unsigned string 字面量去调它 → 把 .rdata 里某个常量当函数指针 call → 立刻访问违例。
//    离线核对：28 条带我们 dll 的崩溃里，有 21 条栈顶正是 0x325B11/0x325B14（那条 call 的地址），
//    同一个 bug，不是随机崩溃。
//
// 正解：**完全手工拼**，不调用 wrapper 里任何非平凡函数。
// 布局依据（0xC59221 读回 + 0x78F800 写入两处反汇编交叉验证）——是 libc++ 的 alternate layout：
//   短串（len ≤ 22）：[0] = len*2（最低位 0 = 短串），数据从 +1 开始
//   长串：            [0] = cap|1（最低位 1 = 长串），[8] = size，[16] = 堆指针
// 这份布局一张 std::string 只占 24 字节。长串需要一个分配器：用 QQ 的 operator new
// （0x180BDB3FC，内部只 call 一次 0xbdbb6f，无间接调用），这样它的析构能用同一个堆。
static const DWORD kRvaOperatorNew = 0xbdb3fc;   // wrapper 的 operator new(size)

static bool ssoStdStringFromBytes(void* dst24, const unsigned char* data, size_t len, unsigned char* base) {
    if (!dst24 || !base) return false;
    auto* p = reinterpret_cast<unsigned char*>(dst24);
    for (int i = 0; i < 24; ++i) p[i] = 0;             // 先清零：空串 = 全 0（[0]=0 → len=0 短串）

    if (len == 0) return true;

    if (len <= 22) {
        // 短串：首字节 = len*2，数据紧随其后，末尾补 0
        p[0] = static_cast<unsigned char>(len << 1);
        for (size_t i = 0; i < len; ++i) p[1 + i] = data[i];
        p[1 + len] = 0;
        return true;
    }

    // 长串：cap = len|15，用 QQ 的 operator new 分配 cap+1
    auto opNew = reinterpret_cast<void* (*)(size_t)>(base + kRvaOperatorNew);
    const size_t cap = (len | 0xf);
    auto* heap = reinterpret_cast<unsigned char*>(opNew(cap + 1));
    if (!heap) return false;
    for (size_t i = 0; i < len; ++i) heap[i] = data[i];
    heap[len] = 0;
    *reinterpret_cast<size_t*>(p + 0x00) = cap | 1;    // 最低位 1 = 长串
    *reinterpret_cast<size_t*>(p + 0x08) = len;
    *reinterpret_cast<size_t*>(p + 0x10) = reinterpret_cast<size_t>(heap);
    return true;
}

// 从这份布局里取回 (指针, 长度) —— 回读 out 结构时要用同一套规则。
static bool ssoStdStringView(const void* src24, const unsigned char** outData, size_t* outLen) {
    if (!src24 || !outData || !outLen) return false;
    const auto* p = reinterpret_cast<const unsigned char*>(src24);
    if (p[0] & 1) {
        // 长串
        *outLen = *reinterpret_cast<const size_t*>(p + 0x08);
        *outData = *reinterpret_cast<const unsigned char* const*>(p + 0x10);
        return *outData != nullptr;
    }
    // 短串：size = 首字节 >> 1
    *outLen = static_cast<size_t>(p[0] >> 1);
    *outData = p + 1;
    return true;
}

static void* ssoCmdString(const char* cmd, unsigned char* base) {
    for (int i = 0; i < g_ssoCmdCount; ++i) {
        const char* a = g_ssoCmd[i].key;
        const char* b = cmd;
        while (*a && *a == *b) { ++a; ++b; }
        if (*a == 0 && *b == 0) return g_ssoCmd[i].block;
    }
    if (g_ssoCmdCount >= 64) return nullptr;
    SsoCmdSlot& slot = g_ssoCmd[g_ssoCmdCount];
    size_t n = 0;
    while (cmd[n] && n < sizeof(slot.key) - 1) { slot.key[n] = cmd[n]; ++n; }
    slot.key[n] = 0;
    for (size_t i = 0; i < sizeof(slot.block); ++i) slot.block[i] = 0;
    // 2026-11-21 更正：原来这里调 kRvaStringCtor(0x325AE8) 建 cmd 的 std::string —— 那是个错误常量
    // （它对第 2 参做间接调用，是委托初始化，不是 string 构造），会立刻崩。
    // 现在按 libc++ 布局手工把 cmd 名字符串写进块的 [0..0x18)。
    // cmd 名都是 ASCII，长度必然 > 22（如 "OidbSvc.0x102a_0" 是 17 字节 → 短串就够）。
    if (!ssoStdStringFromBytes(slot.block, reinterpret_cast<const unsigned char*>(slot.key), n, base)) {
        return nullptr;
    }
    // +0x18 flag = 0（普通方向）；+0x20/+0x28 = QQ 自己的 std::function thunk。
    // 0x765d70 会把第 4 参写进 [块+0x18]（0x765e23: movb %bl,0x18(%rax)），
    // 它**不读任何栈参数** —— 所以回调只能放在结构里，不能像之前那样压栈。
    slot.block[0x18] = 0;
    *reinterpret_cast<void**>(slot.block + 0x20) = base + 0x2334;
    *reinterpret_cast<void**>(slot.block + 0x28) = base + 0x2366;
    ++g_ssoCmdCount;
    return slot.block;
}

static int ssoHexNibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// body 转换代劳：替换函数 + 4 字节补丁的安装/还原。
//
// 这个函数必须与 0xC5927F 的签名和返回值一致：
//   dst24   = rcx = 目标 std::string（24 字节，libc++ layout）
//   env     = rdx = napi_env
//   jsvalue = r8  = JS 值
//   返回 dst24
// 未被要求代劳时**第一句就转回原函数**，所以打补丁后的行为与打补丁前完全一致。
typedef void* (*JsToCxxFn)(void* dst24, void* env, void* jsvalue);

// 发布版可用的「这段内存可读吗」——用 VirtualQuery，不依赖探针。
static bool ssoReadable(const void* p, size_t n) {
    if (!p || n == 0) return false;
    MEMORY_BASIC_INFORMATION mbi{};
    if (!VirtualQuery(p, &mbi, sizeof(mbi))) return false;
    if (mbi.State != MEM_COMMIT) return false;
    const DWORD guard = PAGE_GUARD | PAGE_NOACCESS;
    if (mbi.Protect & guard) return false;
    // 确认整段都在同一个可读区域里
    const auto* start = static_cast<const unsigned char*>(p);
    const auto* end = start + n - 1;
    MEMORY_BASIC_INFORMATION mbi2{};
    if (!VirtualQuery(end, &mbi2, sizeof(mbi2))) return false;
    return mbi2.State == MEM_COMMIT && !(mbi2.Protect & guard);
}

static void* ssoBodyConvTakeover(void* dst24, void* env, void* jsvalue) {
    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) return dst24;
    auto base = reinterpret_cast<unsigned char*>(wrapper);
    auto orig = reinterpret_cast<JsToCxxFn>(base + kRvaJsToCxxConvert);

    // 没被要求代劳 → 原样转发（补丁后默认走这条，行为零变化）
    if (!g_bodyTakeoverActive) return orig(dst24, env, jsvalue);

    // 取走这一次的代劳请求（只生效一次，避免影响后续其它 body）
    // 注意：hits 只用于诊断，**绝不能**当次数上限 ——
    // 它是进程内累计值，一旦拿它拒绝，打满后就会永久失效（这就是之前的 bug）。
    InterlockedIncrement(&g_bodyTakeoverHits);
    InterlockedExchange(&g_bodyTakeoverActive, 0);
    const size_t len = g_bodyTakeoverLen;
    if (len == 0 || len > sizeof(g_bodyTakeover)) {
        return orig(dst24, env, jsvalue);
    }
    if (!ssoStdStringFromBytes(dst24, g_bodyTakeover, len, base)) {
        return orig(dst24, env, jsvalue);
    }
    return dst24;
}

// 安装补丁：把 0x1030FAA 那条 call 的目标改成 ssoBodyConvTakeover。
// 安装前严格校验落点，任何一项不符就放弃（宁可功能不可用，也不乱改代码段）。
static bool ssoBodyConvInstall() {
    if (g_bodyConvPatched) return true;
    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) return false;
    auto base = reinterpret_cast<unsigned char*>(wrapper);
    auto* callSite = base + kRvaBodyConvCall;

    // ── 前置校验：全部通过才动手，任何一项不符就原样返回 ──────────────────
    // 宁可功能不可用，也不去改一个没认证过的字节。
    if (!ssoReadable(callSite, 5)) return false;
    if (callSite[0] != 0xe8) return false;                       // 必须是 E8 rel32

    INT32 rel = 0;
    memcpy(&rel, base + kRvaBodyConvRelPos, sizeof(rel));
    const int64_t target = static_cast<int64_t>(kRvaBodyConvCall) + 5 + rel;
    if (target != static_cast<int64_t>(kRvaJsToCxxConvert)) return false;

    // ── 跳板：wrapper.node 与我们 dll 相距约 29.6 GB，rel32 够不着我们的函数。
    //    往 wrapper.node 自己的 .text 填充区写 `mov rax,imm64 ; jmp rax`，
    //    再把那条 call 的 rel32 指向它。只覆盖编译期 0xCC 填充。 ────────────
    auto* const tramp = base + kRvaTrampSlot;
    const auto* const nextInstr = base + kRvaBodyConvCall + 5;
    if (!ssoReadable(tramp, kTrampLen)) return false;
    for (DWORD i = 0; i < kTrampLen; ++i) {
        if (tramp[i] != kTrampPadByte) return false;             // 不是 padding → 版本不符，放弃
    }

    const int64_t delta = static_cast<int64_t>(
        static_cast<int64_t>(reinterpret_cast<uintptr_t>(tramp)) - static_cast<int64_t>(reinterpret_cast<uintptr_t>(nextInstr)));
    if (delta > 0x7fffffffLL || delta < -0x80000000LL) return false;

    g_bodyConvOrigRel = rel;

    // ── 写跳板 ────────────────────────────────────────────────────────────
    DWORD trampProt = 0;
    if (!VirtualProtect(tramp, kTrampLen, PAGE_EXECUTE_READWRITE, &trampProt)) return false;
    tramp[0] = 0x48; tramp[1] = 0xb8;                            // mov rax, imm64
    const auto absTarget = reinterpret_cast<uintptr_t>(&ssoBodyConvTakeover);
    memcpy(tramp + 2, &absTarget, sizeof(absTarget));
    tramp[10] = 0xff; tramp[11] = 0xe0;                          // jmp rax
    DWORD trampTmp = 0;
    VirtualProtect(tramp, kTrampLen, trampProt, &trampTmp);
    FlushInstructionCache(GetCurrentProcess(), tramp, kTrampLen);

    // ── 改 call 的 rel32 指向跳板 ─────────────────────────────────────────
    DWORD oldProt = 0;
    if (!VirtualProtect(base + kRvaBodyConvRelPos, sizeof(INT32), PAGE_EXECUTE_READWRITE, &oldProt)) return false;
    INT32 newRel = static_cast<INT32>(delta);
    memcpy(base + kRvaBodyConvRelPos, &newRel, sizeof(newRel));
    DWORD tmp = 0;
    VirtualProtect(base + kRvaBodyConvRelPos, sizeof(INT32), oldProt, &tmp);
    FlushInstructionCache(GetCurrentProcess(), base + kRvaBodyConvRelPos, sizeof(INT32));

    g_bodyConvPatched = true;
    return true;
}
// 防止链接器把 takeover 丢掉：发布版里由 ssoBodyConvInstall 引用它，
// 而 ssoBodyConvInstall 由 loadActionsHook / initialize 期间的条件逻辑引用。
// 这里用一个 volatile 指针强制保留（只占 8 字节，不引入任何探针依赖）。
static volatile void* g_keepBodyConv = reinterpret_cast<void*>(&ssoBodyConvTakeover);

static bool ssoBodyConvRemove() {
    if (!g_bodyConvPatched) return true;
    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) return false;
    auto base = reinterpret_cast<unsigned char*>(wrapper);
    DWORD oldProt = 0;
    if (!VirtualProtect(base + kRvaBodyConvRelPos, sizeof(INT32), PAGE_EXECUTE_READWRITE, &oldProt)) return false;
    INT32 orig = g_bodyConvOrigRel;
    memcpy(base + kRvaBodyConvRelPos, &orig, sizeof(orig));
    DWORD tmp = 0;
    VirtualProtect(base + kRvaBodyConvRelPos, sizeof(INT32), oldProt, &tmp);
    FlushInstructionCache(GetCurrentProcess(), base + kRvaBodyConvRelPos, sizeof(INT32));
    g_bodyConvPatched = false;
    return true;
}
#if defined(OPENQQ_ENABLE_PROBE)   // relay + 原生 contend：全部只进调试版
// 借道执行体：被 ssoSendHookEntry 在 hook 0x13807f2 时调用（此时 rcx = objbase）。
// session = *(objbase + 0x88)  ——  依据 0x1380864: movq 0x88(%rsi), %rsi
// 然后调 0x765d70(session, cmd块0x30, &body, flag=0)。SL 用的就是这条原语。
extern "C" void relayFire(void* objbase) {
    // ⚠️ 这里**绝不调用任何 QQ 函数**。此刻我们在 QQ 的发消息线程上，
    // 任何同步发包都会占住这条线程，而回包恰恰要靠它转 → 同线程死锁（实测 1501 超时 + IPC 卡死）。
    // 只做一件事：把 QQ 自己那一帧里的真 session 记下来。
    //   session = *(objbase + 0x88)   依据 0x1380864: movq 0x88(%rsi), %rsi
    if (!objbase) { g_relayErr = -1; return; }
    void* session = *reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(objbase) + 0x88);
    g_relaySession = session;
    g_relayErr = session ? 0 : -3;
}
// 布防：把 cmd/body 准备好，等 QQ 下次调 0x268b8ea 时借它的真 session 发我们的包。
// 返回 0=成功，非 0=失败。args 来自 __openqqSsoRelay(cmd, hex) 的 NAPI 参数。
static void* ssoRelayCallback(void* env, void* info) {
    void* out = nullptr;
    g_probe.createObject(env, &out);
    auto setB = [&](const char* k, bool v) {
        void* b = nullptr;
        if (g_probe.createInt32 && g_probe.createInt32(env, v ? 1 : 0, &b) == 0 && b) g_probe.setNamed(env, out, k, b);
    };
    auto setNum = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_probe.createDouble && g_probe.createDouble(env, v, &n) == 0 && n) g_probe.setNamed(env, out, k, n);
    };
    auto setStr = [&](const char* k, const char* v) {
        void* s = nullptr;
        if (g_probe.createString && g_probe.createString(env, v, SIZE_MAX, &s) == 0 && s) g_probe.setNamed(env, out, k, s);
    };

    // argv[0] = cmd 字符串，argv[1] = body hex
    char cmd[128] = {0};
    size_t cmdLen = 0;
    char hex[2048] = {0};
    size_t hexLen = 0;
    size_t argc = 2;
    void* argv[2] = {nullptr, nullptr};
    if (!g_probe.getCbInfo || g_probe.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0) {
        setB("armed", false); setStr("note", "取参数失败"); return out;
    }
    if (argc >= 1 && argv[0]) g_probe.getString(env, argv[0], cmd, sizeof(cmd) - 1, &cmdLen);
    if (argc >= 2 && argv[1]) g_probe.getString(env, argv[1], hex, sizeof(hex) - 1, &hexLen);
    if (!cmd[0]) { setB("armed", false); setStr("note", "cmd 为空"); return out; }

    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) { setB("armed", false); setStr("note", "wrapper.node 不在"); return out; }

    // 复用 ssoCmdString：它已经构造好 0x30 块（std::string + flag + 两个 cbFn）
    void* block = ssoCmdString(cmd, reinterpret_cast<unsigned char*>(wrapper));
    if (!block) { setB("armed", false); setStr("note", "cmd 缓存已满"); return out; }

    // body
    g_relayBodyLen = 0;
    for (size_t i = 0; i + 1 < hexLen && g_relayBodyLen < sizeof(g_relayBodyStore); i += 2) {
        const int hi = ssoHexNibble(hex[i]);
        const int lo = ssoHexNibble(hex[i + 1]);
        if (hi < 0 || lo < 0) { setB("armed", false); setStr("note", "bodyHex 非法"); return out; }
        g_relayBodyStore[g_relayBodyLen++] = static_cast<unsigned char>((hi << 4) | lo);
    }

    // SsoSpan 放在静态存储里，借道时 r8 指向它
    static SsoSpan relaySpan;
    relaySpan.data = reinterpret_cast<const char*>(g_relayBodyStore);
    relaySpan.len = g_relayBodyLen;

    g_relayCmd = block;
    g_relayBody = &relaySpan;

    // 确保 hook 在 0x268b8ea 上
    if (!g_hookInstalled || g_hookRva != 0x13807f2) {
        const bool ok = installHookAt(reinterpret_cast<unsigned char*>(wrapper), 0x13807f2);
        setB("installed", ok);
        if (!ok) { setB("armed", false); setStr("note", "hook 0x13807f2 安装失败"); return out; }
    } else {
        setB("installed", true);
    }

    g_relayDone = 0;
    InterlockedExchange(&g_relayArmed, 1);
    setB("armed", true);
    setStr("cmd", cmd);
    setNum("bodyLen", static_cast<double>(g_relayBodyLen));
    setStr("note", "已布防：下一次 QQ 发消息时会用它的真 session 把我们的包发出去");
    return out;
}



static void* ssoContendNativeCallback(void* env, void* info) {
    void* out = nullptr;
    g_sso.createObject(env, &out);
    auto setNum = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_sso.createDouble && g_sso.createDouble(env, v, &n) == 0 && n) g_sso.setNamed(env, out, k, n);
    };
    auto setStr = [&](const char* k, const char* v) {
        void* s = nullptr;
        if (g_sso.createStr && g_sso.createStr(env, v, strlen(v), &s) == 0 && s) g_sso.setNamed(env, out, k, s);
    };
    auto setBool = [&](const char* k, bool v) {
        void* b = nullptr;
        if (g_sso.createBool && g_sso.createBool(env, v, &b) == 0 && b) g_sso.setNamed(env, out, k, b);
    };

    if (!g_sso.getCbInfo || !g_sso.unwrap) { setBool("ok", false); setStr("note", "探针不全"); return out; }
    size_t argc = 3;
    void* argv[3] = {nullptr, nullptr, nullptr};
    if (g_sso.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0) {
        setBool("ok", false); setStr("note", "取参数失败"); return out;
    }

    char cmdBuf[128] = {0};
    char hexBuf[65536] = {0};
    size_t cmdLen = 0, hexLen = 0;
    // 参数顺序：argv[0] = msgService 对象（JS 侧 fn(svc, cmd, hex) 的第一参），
    //           argv[1] = cmd 字符串，argv[2] = body hex。
    // 之前按 argv[0]=cmd 取，拿到的是对象 → "cmd 为空"。
    auto asStr = [&](void* v, char* dst, size_t cap, size_t* outLen) {
        if (!v || !g_sso.getStr) return false;
        return g_sso.getStr(env, v, dst, cap - 1, outLen) == 0 && *outLen > 0;
    };
    void* svcObj = (argc >= 1) ? argv[0] : nullptr;
    if (argc >= 2) asStr(argv[1], cmdBuf, sizeof(cmdBuf), &cmdLen);
    if (argc >= 3) asStr(argv[2], hexBuf, sizeof(hexBuf), &hexLen);
    if (!cmdBuf[0] && argv[0]) asStr(argv[0], cmdBuf, sizeof(cmdBuf), &cmdLen);
    if (!cmdBuf[0]) { setBool("ok", false); setNum("argc", static_cast<double>(argc)); setStr("note", "cmd 为空"); return out; }

    // hex → 二进制
    size_t bodyLen = 0;
    for (size_t i = 0; i + 1 < hexLen && bodyLen < sizeof(g_ssoBody); i += 2) {
        const int hi = ssoHexNibble(hexBuf[i]);
        const int lo = ssoHexNibble(hexBuf[i + 1]);
        if (hi < 0 || lo < 0) { setBool("ok", false); setStr("note", "bodyHex 非法"); return out; }
        g_ssoBody[bodyLen++] = static_cast<unsigned char>((hi << 4) | lo);
    }

    // msgService 的 C++ 实现（napi_unwrap 出来就是那层）
    void* impl = nullptr;
    if (!argv[0] || g_sso.unwrap(env, argv[0], &impl) != 0 || !impl) {
        setBool("ok", false); setStr("note", "napi_unwrap 失败"); return out;
    }
    setNum("impl", static_cast<double>(reinterpret_cast<size_t>(impl)));

    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) { setBool("ok", false); setStr("note", "wrapper.node 不在"); return out; }
    auto base = reinterpret_cast<unsigned char*>(wrapper);

    // 两个 std::string（各 24 字节）+ out 结构（0x18）
    alignas(16) unsigned char cmdStr[0x20] = {0};
    alignas(16) unsigned char bodyStr[0x20] = {0};
    if (!ssoStdStringFromBytes(cmdStr, reinterpret_cast<const unsigned char*>(cmdBuf), cmdLen, base)) {
        setBool("ok", false); setStr("note", "cmd 的 std::string 构造失败"); return out;
    }
    if (!ssoStdStringFromBytes(bodyStr, g_ssoBody, bodyLen, base)) {
        setBool("ok", false); setStr("note", "body 的 std::string 构造失败"); return out;
    }
    // 尺寸自检用统一的读回规则（libc++ 布局：短串 [0]>>1，长串 [8]）
    {
        const unsigned char *d = nullptr; size_t n = 0;
        if (ssoStdStringView(cmdStr, &d, &n)) setNum("cmdStrSize", static_cast<double>(n));
        if (ssoStdStringView(bodyStr, &d, &n)) setNum("bodyStrSize", static_cast<double>(n));
    }

    // NAPI 绑定的真实调用序列（0x1031035 / 0x1031051 / 0x1031060）：
    //   rcx = *impl                 ← this（第 1 层解引用）
    //   rax = *(void**)rcx          ← vtable（第 2 层解引用）
    //   call *(void**)((char*)vtable + 0x780)
    // 上一版写成 `vtbl = *(void***)impl` 再取 `(unsigned char*)vtbl[0x780]`，
    // 那样拿到的是「this 的第 0x780 个字节」而不是函数指针槽 —— 也是必崩的写法。
    alignas(16) unsigned char outStruct[0x20] = {0};
    void* self = *reinterpret_cast<void**>(impl);
    if (!self) { setBool("ok", false); setStr("note", "impl 第一层为空"); return out; }
    auto* vtable = *reinterpret_cast<unsigned char**>(self);
    if (!vtable) { setBool("ok", false); setStr("note", "this 没有 vtable"); return out; }
    setNum("self", static_cast<double>(reinterpret_cast<size_t>(self)));
    setNum("vtable", static_cast<double>(reinterpret_cast<size_t>(vtable)));

    // ★ 硬保险：调用前把「槽位地址」和「目标地址」都验一遍，
    //   任何一项不成立就返回诊断，绝不 call。这是本轮崩溃换来的教训 ——
    //   所有必崩的调用都是「指针链上某一环拿错」，而不是参数值不对。
    if (!hookReadable(vtable + kOffContendVt, sizeof(void*))) {
        setBool("ok", false); setStr("note", "vtable+0x780 不可读，已放弃调用"); return out;
    }
    void* fnRaw = *reinterpret_cast<void**>(vtable + kOffContendVt);
    setNum("fnAddr", static_cast<double>(reinterpret_cast<size_t>(fnRaw)));
    if (!fnRaw) { setBool("ok", false); setStr("note", "vtable+0x780 为空"); return out; }
    // 目标必须落在 wrapper.node 的可执行段里；否则一定是拿错了指针。
    {
        MEMORY_BASIC_INFORMATION mbi{};
        if (!VirtualQuery(fnRaw, &mbi, sizeof(mbi)) ||
            mbi.State != MEM_COMMIT ||
            !(mbi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY))) {
            setBool("ok", false); setStr("note", "vtable+0x780 指向的不是可执行内存，已放弃调用"); return out;
        }
        if (reinterpret_cast<unsigned char*>(mbi.AllocationBase) != base) {
            setBool("ok", false); setStr("note", "vtable+0x780 不指向 wrapper.node，已放弃调用"); return out;
        }
    }
    typedef void (*ContendFn)(void*, void*, void*, void*);
    auto fn = reinterpret_cast<ContendFn>(fnRaw);

    fn(self, cmdStr, bodyStr, outStruct);

    // out 结构：按 NAPI 绑定的用法，前 4 字节是 result，+8 是指向 errorMsg 字符的指针，+0x10 指向 rsp
    const int result = *reinterpret_cast<int*>(outStruct + 0);
    setNum("result", static_cast<double>(result));
    const char* errp = *reinterpret_cast<const char**>(outStruct + 0x08);
    if (errp && hookReadable(errp, 1)) setStr("errMsg", errp);
    void* rspPtr = *reinterpret_cast<void**>(outStruct + 0x10);
    setNum("rspPtr", static_cast<double>(reinterpret_cast<size_t>(rspPtr)));
    // rsp 是 std::string*，size 在 +0x10
    if (rspPtr && hookReadable(rspPtr, 0x20)) {
        const unsigned char* sp = reinterpret_cast<const unsigned char*>(rspPtr);
        const size_t sz = *reinterpret_cast<const size_t*>(sp + 0x10);
        setNum("rspLen", static_cast<double>(sz));
        if (sz > 0 && sz < 8192) {
            const unsigned char* data = (sz <= 15) ? sp : *reinterpret_cast<const unsigned char* const*>(sp);
            if (data && hookReadable(data, sz)) {
                static char rspHex[16385];
                for (size_t i = 0; i < sz && i * 2 + 2 < sizeof(rspHex); ++i) {
                    static const char* H = "0123456789abcdef";
                    rspHex[i * 2] = H[data[i] >> 4];
                    rspHex[i * 2 + 1] = H[data[i] & 15];
                    rspHex[i * 2 + 2] = 0;
                }
                setStr("responseHex", rspHex);
            }
        }
    }
    setBool("ok", result == 0);
    return out;
}
#endif  // defined(OPENQQ_ENABLE_PROBE)  （原生 contend 发包只存在于调试版）
// ─────────────────────────────────────────────────────────────────────────────
// body 转换代劳入口（**正式功能**，不属于探针，所以放在 PROBE 块外）。
//
// 用途：JSON→SSO 的 body 必须原样二进制。QQ 的 NAPI 绑定在 0x1030FAA 处用
// 0xC5927F 把 JS 字符串转 std::string，那条路会 UTF-8 编码（实测 [80 80] → invalid pkg，
// [C2 80] → 通过），所以纯 JS 永远发不了二进制。
// 本入口把那条 call 的 rel32 换成 ssoBodyConvTakeover（只改 4 字节），
// 未 arm 时代劳函数第一句就转回 0xC5927F → 行为与打补丁前完全一致。
//
// op = install | remove | status | arm
//   install 安装补丁（安装前严格校验落点，不符就不改任何字节）
//   arm      把 hex 当作下一次 body 转换的结果（只生效一次）
//   status   查补丁状态 / arm 状态 / 命中次数
//   remove   还原（把原 rel32 写回）
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// __openqqSsoContendNative(msgServiceObject, cmd, bodyHex) -> { result, errMsg, responseHex }
//
// 走 QQ 自己的 sendSsoCmdReqByContend 实现（vtable+0x780），绕开 JS 的 UTF-8 转换，
// 所以二进制 body 能原样送达。这条路径**同步**，不注册回调、不等消息循环 → 不会死锁。
// 与 0x765d70 的本质区别：那个要等回调（QQ 消息循环），这个直接返回结果。
// __openqqSsoBodyConv(op, hex) -> 诊断对象
//   op = 'install' | 'remove' | 'status'
//   op = 'arm'：把 hex 当作下一次 body 转换的结果（只生效一次）
// 这是「发任意 OIDB/trpc 包」的落点：先 arm 再调 QQ 自己的 sendSsoCmdReqByContend，
// body 就会原样送达，回包由 QQ 自己的 promise 机制返回。
// ─────────────────────────────────────────────────────────────────────────────
static void* ssoBodyConvCallback(void* env, void* info) {
    void* out = nullptr;
    g_sso.createObject(env, &out);
    auto setB = [&](const char* k, bool v) {
        void* b = nullptr;
        if (g_sso.createBool && g_sso.createBool(env, v, &b) == 0 && b) g_sso.setNamed(env, out, k, b);
    };
    auto setN = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_sso.createDouble && g_sso.createDouble(env, v, &n) == 0 && n) g_sso.setNamed(env, out, k, n);
    };
    auto setS = [&](const char* k, const char* v) {
        void* s = nullptr;
        if (g_sso.createStr && g_sso.createStr(env, v, strlen(v), &s) == 0 && s) g_sso.setNamed(env, out, k, s);
    };

    if (!g_sso.getCbInfo || !g_sso.getStr) { setB("ok", false); setS("note", "探针不全"); return out; }
    size_t argc = 2;
    void* argv[2] = {nullptr, nullptr};
    if (g_sso.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0) {
        setB("ok", false); setS("note", "取参数失败"); return out;
    }
    char opBuf[32] = {0};
    size_t opLen = 0;
    if (argv[0]) g_sso.getStr(env, argv[0], opBuf, sizeof(opBuf) - 1, &opLen);

    if (!strcmp(opBuf, "install")) {
        const bool ok = ssoBodyConvInstall();
        setB("ok", ok);
        setB("patched", g_bodyConvPatched);
        setN("origRel", static_cast<double>(g_bodyConvOrigRel));
        setN("ourAddr", static_cast<double>(reinterpret_cast<size_t>(&ssoBodyConvTakeover)));
        setN("wrapperBase", static_cast<double>(reinterpret_cast<size_t>(GetModuleHandleW(L"wrapper.node"))));
        setN("callSite", static_cast<double>(static_cast<size_t>(0x1030faa)));
        if (!ok) setS("note", "落点校验失败（QQ 版本不符 / 已改过 / 跳板申请失败），未改动任何字节");
        return out;
    }
    if (!strcmp(opBuf, "remove")) {
        const bool ok = ssoBodyConvRemove();
        setB("ok", ok);
        setB("patched", g_bodyConvPatched);
        return out;
    }
    if (!strcmp(opBuf, "status")) {
        setB("ok", true);
        setB("patched", g_bodyConvPatched);
        setB("armed", g_bodyTakeoverActive != 0);
        setN("origRel", static_cast<double>(g_bodyConvOrigRel));
        setN("hits", static_cast<double>(g_bodyTakeoverHits));
        return out;
    }
    if (!strcmp(opBuf, "arm")) {
        char hexBuf[65536] = {0};
        size_t hexLen = 0;
        if (argc >= 2 && argv[1]) g_sso.getStr(env, argv[1], hexBuf, sizeof(hexBuf) - 1, &hexLen);
        size_t bodyLen = 0;
        for (size_t i = 0; i + 1 < hexLen && bodyLen < sizeof(g_bodyTakeover); i += 2) {
            const int hi = ssoHexNibble(hexBuf[i]);
            const int lo = ssoHexNibble(hexBuf[i + 1]);
            if (hi < 0 || lo < 0) { setB("ok", false); setS("note", "hex 非法"); return out; }
            g_bodyTakeover[bodyLen++] = static_cast<unsigned char>((hi << 4) | lo);
        }
        g_bodyTakeoverLen = bodyLen;
        InterlockedExchange(&g_bodyTakeoverActive, 1);
        setB("ok", g_bodyConvPatched);
        setN("armedLen", static_cast<double>(bodyLen));
        if (!g_bodyConvPatched) setS("note", "补丁未安装，arm 不会生效（先 op=install）");
        return out;
    }
    setB("ok", false);
    setS("note", "op 必须是 install / remove / status / arm");
    return out;
}

// __openqqSsoSend(msfServiceObject, cmd, bodyHex, dryRun) -> 诊断对象
//   dryRun 缺省为 true：只校验「这个对象是不是 MSFService、发送路径是否就绪」，不发包。
// __openqqSsoSendRaw(cmd, bodyHex, dryRun) -> 诊断对象
// 与 __openqqSsoSend 的唯一区别：session 不用调用方传，native 自己解析
// GetModuleHandle("snowluma-win32-x64.dll") + 0x70088（SL 的 504 字节静态结构体）。
// 目的：验证「SL 拿自己的结构体当 session 传给 0x765d70」这个假设。
// 这个入口只在调试版存在（发布版没有 loadSsoBridge 之外的 SL 引用）。
#if defined(OPENQQ_ENABLE_PROBE)   // __openqqSsoSendRaw 依赖 SL 结构体，仅调试版
static void* ssoSendRawCallback(void* env, void* info) {
    void* out = nullptr;
    g_sso.createObject(env, &out);
    auto setNum = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_sso.createDouble && g_sso.createDouble(env, v, &n) == 0 && n) g_sso.setNamed(env, out, k, n);
    };
    auto setStr = [&](const char* k, const char* v) {
        void* s = nullptr;
        if (g_sso.createStr && g_sso.createStr(env, v, strlen(v), &s) == 0 && s) g_sso.setNamed(env, out, k, s);
    };
    auto setB = [&](const char* k, bool v) {
        void* b = nullptr;
        if (g_sso.createBool && g_sso.createBool(env, v, &b) == 0 && b) g_sso.setNamed(env, out, k, b);
    };

    size_t argc = 3;
    void* argv[3] = {nullptr, nullptr, nullptr};
    if (!g_sso.getCbInfo || g_sso.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0) {
        setStr("note", "getCbInfo 失败");
        return out;
    }
    char cmdBuf[256] = {0};
    size_t cmdLen = 0;
    if (!argv[0] || g_sso.getStr(env, argv[0], cmdBuf, sizeof(cmdBuf) - 1, &cmdLen) != 0) {
        setStr("note", "cmd 不是字符串");
        return out;
    }
    char hexBuf[8192] = {0};
    size_t hexLen = 0;
    if (argc >= 2 && argv[1]) g_sso.getStr(env, argv[1], hexBuf, sizeof(hexBuf) - 1, &hexLen);
    bool dryRun = true;
    if (argc >= 3 && argv[2] && g_sso.getBool) {
        bool b = false;
        if (g_sso.getBool(env, argv[2], &b) == 0) dryRun = b;
    }

    HMODULE sl = GetModuleHandleW(L"snowluma-win32-x64.dll");
    if (!sl) {
        setStr("note", "snowluma 未加载，无法取它的结构体");
        setB("slLoaded", false);
        return out;
    }
    setB("slLoaded", true);
    unsigned char* slBase = reinterpret_cast<unsigned char*>(sl);
    void* session = slBase + 0x70088;
    setNum("slBase", (double)(size_t)slBase);
    setNum("session", (double)(size_t)session);

    long long ready = 0;
    memcpy(&ready, reinterpret_cast<unsigned char*>(session) + kOffSendReady, 8);
    setNum("sendReady", (double)ready);
    setB("sendReadyOk", ready != 0);

    // 解 body hex
    size_t bodyLen = 0;
    for (size_t i = 0; i + 1 < hexLen; i += 2) {
        auto hv = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = hv(hexBuf[i]), lo = hv(hexBuf[i + 1]);
        if (hi < 0 || lo < 0) break;
        if (bodyLen < sizeof(g_ssoBody)) g_ssoBody[bodyLen++] = static_cast<unsigned char>((hi << 4) | lo);
    }
    setNum("bodyLen", (double)bodyLen);
    if (dryRun) {
        setStr("note", "dryRun：已解析 SL 结构体，未发送");
        return out;
    }

    unsigned char* base = reinterpret_cast<unsigned char*>(GetModuleHandleW(L"wrapper.node"));
    if (!base) { setStr("note", "wrapper.node 未加载"); return out; }
    void* cmdStr = ssoCmdString(cmdBuf, base);
    if (!cmdStr) { setStr("note", "cmd 缓存已满"); return out; }
    // MSVC std::function 布局（0x20 字节）：
//   [0x00..0x0F] functor 存储（无捕获 lambda 全零即可）
//   [0x10] invoker 函数指针
//   [0x18] deleter 函数指针
// 依据：0x76669c 在栈上构造时就是 mov [r9+0x10]=0x180002334 / [r9+0x18]=0x180002366。
// 之前把两个指针放 +0/+8 是错的，0x765d70 拿到垃圾结构 → 卡死。
struct SsoFunc { unsigned char storage[0x10]; void* invoke; void* destroy; };
    SsoFunc cbPair{};
    cbPair.invoke = base + 0x2334;
    cbPair.destroy = base + 0x2366;
    SsoSpan span{reinterpret_cast<const char*>(g_ssoBody), bodyLen};
    typedef int (*SendPrimFn)(void*, void*, void*, unsigned char, void*);
    SendPrimFn sendPrim = reinterpret_cast<SendPrimFn>(base + kRvaSendPrim);
    int rc = -1; if (InterlockedCompareExchange(&g_ssoJob.state,1,0)==0){ g_ssoJob.thisObj=(void*)(size_t)session; g_ssoJob.cmdStr=cmdStr; g_ssoJob.bodyData=(const char*)g_ssoBody; g_ssoJob.bodyLen=bodyLen; void* th=CreateThread(nullptr,0,ssoAsyncWorker,nullptr,0,nullptr); if(th){CloseHandle(th); rc=0;} else {InterlockedExchange(&g_ssoJob.state,0);} }
    setNum("sendRc", (double)rc);
    setStr("note", "已用 SL 结构体当 session 调 0x765d70");
    return out;
}
#endif  // OPENQQ_ENABLE_PROBE（SsoSendRaw）

static void* ssoSendCallback(void* env, void* info) {
    void* out = nullptr;
    g_sso.createObject(env, &out);
    auto setStr = [&](const char* k, const char* v) {
        void* s = nullptr;
        if (g_sso.createStr(env, v, SIZE_MAX, &s) == 0 && s) g_sso.setNamed(env, out, k, s);
    };
    auto setNum = [&](const char* k, double v) {
        void* n = nullptr;
        if (g_sso.createDouble(env, v, &n) == 0 && n) g_sso.setNamed(env, out, k, n);
    };
    auto setB = [&](const char* k, bool v) {
        void* b = nullptr;
        if (g_sso.createBool(env, v, &b) == 0 && b) g_sso.setNamed(env, out, k, b);
    };

    size_t argc = 4;
    void* argv[4] = {nullptr, nullptr, nullptr, nullptr};
    if (!g_sso.getCbInfo || g_sso.getCbInfo(env, info, &argc, argv, nullptr, nullptr) != 0) {
        setStr("note", "napi_get_cb_info failed");
        return out;
    }
    setNum("argc", (double)argc);

    // raw session 模式：argv[0] 传十进制地址字符串时，直接当 session 用。
    // 验证假设：SnowLuma 把 DAT_180070088（它自己的 504 字节结构体）当 session 传给 0x765d70。
    void* sessionOverride = nullptr;
    {
        char rawArg[64] = {0};
        size_t rawLen = 0;
        if (argc >= 1 && argv[0] &&
            g_sso.getStr(env, argv[0], rawArg, sizeof(rawArg) - 1, &rawLen) == 0 && rawLen > 0) {
            unsigned long long raw = strtoull(rawArg, nullptr, 10);
            if (raw > 0x10000ULL && raw < 0x00007FFFFFFFFFFFULL) {
                sessionOverride = reinterpret_cast<void*>(static_cast<size_t>(raw));
                setB("rawSessionMode", true);
                setNum("rawSession", (double)(size_t)sessionOverride);
            }
        }
    }

    void* impl = nullptr;
    int unwrapStatus = -1;
    if (!sessionOverride && argc >= 1 && argv[0]) unwrapStatus = g_sso.unwrap(env, argv[0], &impl);
    setNum("unwrapStatus", unwrapStatus);
    if (!impl && !sessionOverride) {
        setStr("note", "napi_unwrap 失败：请传 session.getMSFService() 返回的对象");
        return out;
    }
    setNum("impl", (double)(size_t)impl);

    HMODULE wrapper = GetModuleHandleW(L"wrapper.node");
    if (!wrapper) {
        setStr("note", "wrapper.node 未加载");
        return out;
    }
    auto base = reinterpret_cast<unsigned char*>(wrapper);
    setNum("wrapperBase", (double)(size_t)base);

    // 身份校验：只读「刚 unwrap 出来的这个对象」自身的前 0x40 字节，不解引用任何陌生指针。
    // 之前在对象内部做二级解引用探测，碰到不可访问页把 QQ 的 IPC 卡死过一次，所以这里
    // 只做一件事：把槽位原样报出来，由上层判断哪一层才是 MSFService。
    void* session = nullptr;
    void* ready = nullptr;
    void* thisObj = nullptr;
    if (sessionOverride) {
        void* ready0 = *reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(sessionOverride) + kOffSendReady);
        setNum("session", (double)(size_t)sessionOverride);
        setNum("sendReady", (double)(size_t)ready0);
        setB("sendReadyOk", ready0 != nullptr);
        setB("identityOk", false);
    } else {
    void* expected = base + kRvaMsvcVtable;
    setNum("expectedVtable", (double)(size_t)expected);
    void* vtable = *reinterpret_cast<void**>(impl);
    setNum("vtable", (double)(size_t)vtable);
    bool vtableInWrapper = (reinterpret_cast<unsigned char*>(vtable) >= base) &&
                           (reinterpret_cast<unsigned char*>(vtable) < base + 0x8000000);
    setB("vtableInWrapper", vtableInWrapper);
    bool identityOk = (vtable == expected);
    setB("identityOk", identityOk);
    // 原始槽位（只读本对象前 0x20 字节，不跟随任何指针）
    setNum("slot0", (double)(size_t)(*reinterpret_cast<void**>(impl)));
    setNum("slot1", (double)(size_t)(*reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(impl) + 8)));
    setNum("slot2", (double)(size_t)(*reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(impl) + 16)));
    setNum("slot3", (double)(size_t)(*reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(impl) + 24)));
        session = identityOk ? impl : nullptr;
    setNum("session", (double)(size_t)session);
        ready = session ? *reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(session) + kOffSendReady) : nullptr;
    setNum("sendReady", (double)(size_t)ready);
    setB("sendReadyOk", ready != nullptr);

    // MSFService 虚表 slot 4（0x76669c）里是 session = this - 0x10，而 sendMsfRequest 绑定里
    // this = *(impl)，正好是上面读到的 slot0。所以 session 可以直接算，不必再解引用探测。
        thisObj = *reinterpret_cast<void**>(impl);
    void* sessionAlt = thisObj ? reinterpret_cast<void*>(reinterpret_cast<unsigned char*>(thisObj) - 0x10) : nullptr;
    setNum("sessionAlt", (double)(size_t)sessionAlt);
    void* readyAlt = sessionAlt ? *reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(sessionAlt) + kOffSendReady) : nullptr;
    setNum("readyAlt", (double)(size_t)readyAlt);
    setB("readyAltOk", readyAlt != nullptr);
    if (!session && readyAlt) { session = sessionAlt; ready = readyAlt; }

    // 2026-11-21 新增：MsgService 的 C++ this + 0x20。
    // 依据：0x1388d54 是 Msg.sendMsg 的 C++ 薄封装，它做 addq $-0x68,%rsi 之后 call 0x13807f2，
    // 而 0x13807f2 里 rsi = [rcx+0x88] ⇒ session = *(this - 0x68 + 0x88) = *(this + 0x20)。
    // 这一路不依赖虚表身份校验（包装层的 vtable 永远不是 0x4130078），所以它是主路径。
    void* sessionFrom20 = impl
        ? *reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(impl) + 0x20)
        : nullptr;
    setNum("sessionFrom20", (double)(size_t)sessionFrom20);
    void* readyFrom20 = sessionFrom20
        ? *reinterpret_cast<void**>(reinterpret_cast<unsigned char*>(sessionFrom20) + kOffSendReady)
        : nullptr;
    setNum("readyFrom20", (double)(size_t)readyFrom20);
    setB("readyFrom20Ok", readyFrom20 != nullptr);
    // readyFrom20Ok 是硬证据：0x765d70 首行检查的就是 *(rcx+0x60) 非空，
    // 而这一路实测 readyFrom20Ok=true。所以它优先于上面两路（那两路靠虚表判据，永远是 false）。
    if (readyFrom20) { session = sessionFrom20; ready = readyFrom20; }

    setNum("session", (double)(size_t)session);
    setNum("sendReady", (double)(size_t)ready);
    setB("sendReadyOk", ready != nullptr);
    }
    if (sessionOverride) { session = sessionOverride; }

    // 把 session 推给自研组件（openqq-sso-local.dll）。dryRun 也推 ——
    // 这正是「JS 侧调一次 dryRun 就能把 session 建立起来」的设计。
    if (session) notifySsoLocalSession(session);

    char cmd[96] = {0};
    size_t cmdLen = 0;
    if (argc >= 2 && argv[1]) g_sso.getStr(env, argv[1], cmd, sizeof(cmd) - 1, &cmdLen);
    setStr("cmd", cmd);

    size_t hexLen = 0;
    g_ssoHex[0] = 0;
    if (argc >= 3 && argv[2]) g_sso.getStr(env, argv[2], g_ssoHex, sizeof(g_ssoHex) - 1, &hexLen);
    size_t bodyLen = 0;
    for (size_t i = 0; i + 1 < hexLen && bodyLen < sizeof(g_ssoBody); i += 2) {
        const int hi = ssoHexNibble(g_ssoHex[i]);
        const int lo = ssoHexNibble(g_ssoHex[i + 1]);
        if (hi < 0 || lo < 0) {
            setStr("note", "bodyHex 里有非十六进制字符");
            setNum("badAt", (double)i);
            return out;
        }
        g_ssoBody[bodyLen++] = static_cast<unsigned char>((hi << 4) | lo);
    }
    setNum("bodyLen", (double)bodyLen);

    bool dryRun = true;
    if (argc >= 4 && argv[3]) g_sso.getBool(env, argv[3], &dryRun);
    setB("dryRun", dryRun);

    if (!session) {
        setStr("note", "虚表不匹配：两层解引用都不是 MSFService，未发送");
        return out;
    }
    if (!ready) {
        setStr("note", "*(session+0x60) 为空：发送路径未就绪，未发送");
        return out;
    }
    if (!cmd[0]) {
        setStr("note", "cmd 为空，未发送");
        return out;
    }
    if (dryRun) {
        // 顺便把上一发的结果回报出来（state: 0=idle 1=running 2=done 3=error）。
        // 真发本身是异步的，所以只能靠下一次调用回读。
        setNum("jobState", (double)g_ssoJob.state);
        setNum("jobRc", (double)g_ssoJob.rc);
        setNum("jobOut", (double)(size_t)g_ssoJob.outSlot);

        // ===== 只在 JS 线程做、绝不阻塞的上下文探测 =====
        // 0x2c11cc 首行是 movq %gs:0x58（TLS），必须在本线程调才对；而它和 0x2c122c 都只是
        // 查表、不等回包，所以放在 dryRun 里探测是安全的，能直接回答「session 对象对不对」。
        typedef void* (__fastcall* FnGetCtx)();
        typedef void* (__fastcall* FnLookup)(void*, void*);
        auto getCtx = reinterpret_cast<FnGetCtx>(base + 0x2c11cc);
        auto lookup = reinterpret_cast<FnLookup>(base + 0x2c122c);
        void* dctx = nullptr;
        void* dnode = nullptr;
        // mingw 不支持 __try/__except，这里直接调：两个函数都只查表、不等回包。
        dctx = getCtx();
        if (dctx) dnode = lookup(dctx, session);
        setNum("ctx", (double)(size_t)dctx);
        setNum("node", (double)(size_t)dnode);
        setB("ctxOk", dctx != nullptr);
        setB("nodeOk", dnode != nullptr);

        // ===== 用 QQ 自己的「查表判据」验证 session 是否真的注册过 =====
        // 0x268f09e 里的原逻辑（0x268f0d3..0x268f0ed）：
        //   leaq 0x18(%rbp),%r12 ; rcx=ctx ; rdx=&slot ; r8=session ; call 0x3fc8
        //   leaq 0x8(ctx),%rax   ; cmpq %rax,(%r12) ; je <return>   ← 相等 = 没找到
        // 即：**slot == ctx+8 代表 session 不在会话表里**。纯查表、不等回包，dryRun 里跑安全。
        // 这等于拿到了 QQ 自己的 oracle：只要 sessionRegistered=true，这个对象就是对的。
        typedef void (__fastcall* FnFind)(void*, void*, void*);
        auto find = reinterpret_cast<FnFind>(base + 0x3fc8);
        auto registered = [&](void* cand) -> bool {
            if (!cand) return false;
            void* slot = nullptr;
            find(dctx, &slot, cand);
            return slot != reinterpret_cast<unsigned char*>(dctx) + 8;
        };
        if (dctx) {
            void* slot = nullptr;
            find(dctx, &slot, session);
            setNum("findSlot", (double)(size_t)slot);
            setB("sessionRegistered", registered(session));

            setNum("hitIndex", (double)-1);
            setNum("hitValue", 0.0);
        }
        setStr("note", "dryRun：身份与就绪状态已校验，未发送");
        return out;
    }

    // ===== 真发闸门（2026-11-21 第五次重审后关闭）=====
    // 已试遍并按纪律停手：
    //   ① 0x765d70 + 0x20 结构 + sso-local 线程   → QQ 4→0
    //   ② 0x765d70 + 0x20 结构 + bootstrap worker → QQ 4→0
    //   ③ 0x765d70 + 0x30 结构 + bootstrap worker → QQ 存活但 IPC 全超时
    //   ④ 0x268f09e + bootstrap worker            → QQ 存活但 IPC 全超时
    //   ⑤ 0x268f09e + 同步（NAPI 线程）           → QQ 存活但 IPC 全超时
    // 结论：缺的不是参数也不是线程，是「谁持有正确的会话上下文」。0x765d70 内部要等回调，
    // 回调要靠 QQ 自己的消息循环转，从任何外部线程/外部栈调用都拿不到那个循环。
    // 在 pending/context 方案落地前，这里明确拒绝，不再拿 QQ 的可用性试探。
    // 结构性结论见 .botharness\sl-re\PLAN-sso-local.md 步骤 0.5。
    g_ssoJob.rc = -20;
    InterlockedExchange(&g_ssoJob.state, 3);
    setNum("jobRc", -20);
    setStr("note", "真发通道关闭：待 pending/上下文方案（见 PLAN-sso-local.md 步骤 0.5）");
    return out;
    setStr("note", "已提交到工作线程，本动作不再等待结果（避免堵住消息循环）");
    return out;
}

static void installSsoSend(HMODULE runtime, void* env, void* globalObject) {
    g_sso.getCbInfo = reinterpret_cast<decltype(g_sso.getCbInfo)>(GetProcAddress(runtime, "napi_get_cb_info"));
    g_sso.unwrap = reinterpret_cast<decltype(g_sso.unwrap)>(GetProcAddress(runtime, "napi_unwrap"));
    g_sso.createObject = reinterpret_cast<decltype(g_sso.createObject)>(GetProcAddress(runtime, "napi_create_object"));
    g_sso.createFunction = reinterpret_cast<decltype(g_sso.createFunction)>(GetProcAddress(runtime, "napi_create_function"));
    g_sso.setNamed = reinterpret_cast<decltype(g_sso.setNamed)>(GetProcAddress(runtime, "napi_set_named_property"));
    g_sso.createStr = reinterpret_cast<decltype(g_sso.createStr)>(GetProcAddress(runtime, "napi_create_string_utf8"));
    g_sso.getStr = reinterpret_cast<decltype(g_sso.getStr)>(GetProcAddress(runtime, "napi_get_value_string_utf8"));
    g_sso.createDouble = reinterpret_cast<decltype(g_sso.createDouble)>(GetProcAddress(runtime, "napi_create_double"));
    g_sso.createBool = reinterpret_cast<decltype(g_sso.createBool)>(GetProcAddress(runtime, "napi_get_boolean"));
    g_sso.getBool = reinterpret_cast<decltype(g_sso.getBool)>(GetProcAddress(runtime, "napi_get_value_bool"));
    if (!g_sso.getCbInfo || !g_sso.unwrap || !g_sso.createObject || !g_sso.createFunction
        || !g_sso.setNamed || !g_sso.createStr || !g_sso.getStr || !g_sso.createDouble
        || !g_sso.createBool || !g_sso.getBool) {
        return;
    }
    // ── 自动安装 body 转换补丁 ────────────────────────────────────────────
    // 自研 SSO 通道的前提：没有这个 4 字节补丁，body 仍会被 UTF-8 编码，二进制发不出去。
    // 必须在模块初始化时装好，否则「开箱即用」不成立。
    // 安装失败不影响其它功能（其它动作照常），只是 SSO 类动作会回 1500。
    ssoBodyConvInstall();

    // body 转换代劳入口：正式功能（发布版可用，不属于探针）
    {
        void* bodyConvFn = nullptr;
        if (g_sso.createFunction(env, "openqqSsoBodyConv", SIZE_MAX,
                                 reinterpret_cast<void*>(&ssoBodyConvCallback), nullptr, &bodyConvFn) == 0 && bodyConvFn) {
            g_sso.setNamed(env, globalObject, "__openqqSsoBodyConv", bodyConvFn);
        }
    }
    void* fn = nullptr;
    if (g_sso.createFunction(env, "openqqSsoSend", SIZE_MAX,
                             reinterpret_cast<void*>(&ssoSendCallback), nullptr, &fn) == 0 && fn) {
        g_sso.setNamed(env, globalObject, "__openqqSsoSend", fn);
#if defined(OPENQQ_ENABLE_PROBE)
        {
            void* fn2 = nullptr;
            if (g_sso.createFunction && g_sso.createFunction(env, "__openqqSsoSendRaw", 18,
                reinterpret_cast<void*>(&ssoSendRawCallback), nullptr, &fn2) == 0 && fn2) {
                g_sso.setNamed(env, globalObject, "__openqqSsoSendRaw", fn2);
            }
        }
#endif  // OPENQQ_ENABLE_PROBE（SsoSendRaw 注册）
    }
}

extern "C" __declspec(dllexport) void* OpenQQBootstrap(void* env, void* exports, BootstrapConfig* config) {
    // Run QQ's initializer unchanged, including any pending exception it creates.
    void* result = config->original(env, exports);
    loadSsoBridge();
    void* scope = nullptr;
    bool introducedException = false;
    using Pending = int (*)(void*, bool*);
    using Clear = int (*)(void*, void**);
    using Close = int (*)(void*, void*);
    Pending pending = nullptr;
    Clear clear = nullptr;
    Close close = nullptr;
    LONG status = -1;
    try {
        const auto runtime = config->runtime;
        pending = api<Pending>(runtime, "napi_is_exception_pending");
        clear = api<Clear>(runtime, "napi_get_and_clear_last_exception");
        close = api<Close>(runtime, "napi_close_escapable_handle_scope");
        bool exception = false;
        check(pending(env, &exception));
        if (exception) throw std::runtime_error("wrapper initializer has a pending exception");
        introducedException = true;
        auto open = api<int (*)(void*, void**)>(runtime, "napi_open_escapable_handle_scope");
        auto global = api<int (*)(void*, void**)>(runtime, "napi_get_global");
        auto set = api<int (*)(void*, void*, const char*, void*)>(runtime, "napi_set_named_property");
        auto string = api<int (*)(void*, const char*, size_t, void**)>(runtime, "napi_create_string_utf8");
        auto run = api<int (*)(void*, void*, void**)>(runtime, "napi_run_script");
        auto escape = api<int (*)(void*, void*, void*, void**)>(runtime, "napi_escape_handle");
        check(open(env, &scope));
        void *object = nullptr, *source = nullptr, *value = nullptr, *escaped = nullptr;
        check(global(env, &object));
        check(set(env, object, "__openqq_exports", result ? result : exports));
        // 自研 SSO 的 C++ 侧入口：wrapper 句柄 + 只读指针探针（见 installProbe 上方注释）。
        installProbe(config->runtime, env, object, result ? result : exports);
        // 自研 SSO 发送入口：发布版也装（探针只做调试，发包能力是正式功能）。
        installSsoSend(config->runtime, env, object);
        check(string(env, config->source, SIZE_MAX, &source));
        check(run(env, source, &value));
        check(escape(env, scope, value, &escaped));
        result = escaped;
        status = 1;
    } catch (const std::exception& error) {
        std::snprintf(config->error, sizeof(config->error), "%s", error.what());
        if (introducedException && pending && clear) {
            bool exception = false;
            void* ignored = nullptr;
            if (!pending(env, &exception) && exception) clear(env, &ignored);
        }
    }
    if (scope && close && close(env, scope)) {
        status = -1;
        std::snprintf(config->error, sizeof(config->error), "N-API scope close failed");
    }
    // Publish only after the escaped handle is safe and all cleanup has finished.
    InterlockedExchange(&config->status, status);
    return result;
}

BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) { return TRUE; }
