// OpenQQ's Windows x64 binary packet bridge.
//
// QQ's normal JS binding converts both requests and replies through UTF-8 text;
// arbitrary protobuf bytes cannot survive that conversion. For explicit OpenQQ
// sends only, keep the request bytes in QQ's native string and return rsp as a
// Buffer. The wire protocol itself lives in group-file.cjs, not in these hooks.
//
// The profile table below supplies exact instruction sites and ABI layouts for
// each verified wrapper.node build. Unknown builds fail before patching. No
// third-party native addon is loaded.
#include "packet.hpp"
#include <windows.h>
#include <tlhelp32.h>
#ifdef _MSC_VER
#include <intrin.h>
#endif
#include <cwchar>
#include <array>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

namespace {
// ---------------------------------------------------------------------------
// Verified wrapper.node profiles.
//
// Add one entry per exact QQ build, after confirming the same call convention,
// object layout and instruction semantics. RVAs are relative to the module base,
// never absolute addresses, and every prologue is checked byte-for-byte before a
// hook is written. An adjacent build number is not compatible by default.
// ---------------------------------------------------------------------------
struct PacketInstructionSite {
    uintptr_t rva;
    const unsigned char *bytes;
    size_t size;
};

struct PacketStringLayout {
    unsigned char longFlagMask;
    unsigned char shortLengthShift;
    size_t inlineDataOffset;
    size_t longLengthOffset;
    size_t longDataOffset;
};

struct PacketProfile {
    const char *version;
    uint32_t peTimestamp;
    uint32_t imageSize;
    PacketInstructionSite stringConverter;
    PacketInstructionSite responseCallback;
    PacketInstructionSite responseStringCall;
    size_t callbackContextOffset;
    size_t contextDeferredOffset;
    PacketStringLayout stringLayout;
};

// Disassembled from the official Windows x64 9.9.33-52230 wrapper.node.
// SHA256: 63112ab9161e127f5f7e17998a7196e143808923fb54cbbf7b4e21426187a5f0
// Both overwritten prologues contain only register pushes and stack/frame setup.
// A future profile with RIP-relative instructions needs a relocation-aware
// engine; changing its RVAs/signatures alone is not sufficient.
inline constexpr unsigned char k52230StringConverterPrologue[] = {
    0x55, 0x41, 0x56, 0x56, 0x57, 0x53, 0x48, 0x83, 0xec, 0x60, 0x48, 0x8d, 0x6c, 0x24, 0x60};
inline constexpr unsigned char k52230ResponseCallbackPrologue[] = {
    0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x55, 0x41, 0x54, 0x56, 0x57, 0x53, 0x48, 0x83, 0xec, 0x68};
inline constexpr unsigned char k52230ResponseStringCall[] = {0xff, 0x15, 0xa7, 0x3a, 0x55, 0x02};

inline constexpr PacketProfile kPacketProfiles[] = {
    {
        "9.9.33-52230",
        0x6a7479f9,
        0x7419000,
        {0xBF2B5F, k52230StringConverterPrologue, sizeof(k52230StringConverterPrologue)},
        {0x23BB4DD, k52230ResponseCallbackPrologue, sizeof(k52230ResponseCallbackPrologue)},
        {0x23BB633, k52230ResponseStringCall, sizeof(k52230ResponseStringCall)},
        16,               // Callback object -> shared callback context.
        32,               // Callback context -> napi_deferred; QQ clears it after settlement.
        {1, 1, 1, 8, 16}, // 24-byte libc++ default string layout, little-endian.
    },
};

using Value = void *;
using Env = void *;
using Callback = Value (*)(Env, void *);
using Convert = void *(*)(void *, Env, Value);
using Receive = void (*)(void *);
using CreatePromise = int (*)(Env, void **, Value *);
using CreateString = int (*)(Env, const char *, size_t, Value *);
constexpr size_t kMaxPacketBytes = 1024 * 1024;
constexpr size_t kAbsoluteJumpBytes = 14;
constexpr size_t kMaxPendingRequests = 256;
constexpr int kNapiGenericFailure = 9;
constexpr int kNapiPendingException = 10;
const PacketProfile *activeProfile = nullptr;

const PacketProfile *findPacketProfile(const std::string &version) {
    for (const auto &profile : kPacketProfiles) {
        if (version == profile.version)
            return &profile;
    }
    return nullptr;
}
std::string supportedVersionList() {
    std::string list;
    for (const auto &profile : kPacketProfiles) {
        if (!list.empty())
            list += ", ";
        list += profile.version;
    }
    return list;
}
// Resolve stable N-API entry points from QQNT.dll instead of linking to the host
// Node installation. The external Node version must not select the embedded ABI.
struct Api {
    int (*getArgs)(Env, void *, size_t *, Value *, Value *, void **);
    int (*getString)(Env, Value, char *, size_t, size_t *);
    int (*isBuffer)(Env, Value, bool *);
    int (*getBuffer)(Env, Value, void **, size_t *);
    int (*createBuffer)(Env, size_t, const void *, void **, Value *);
    int (*createObject)(Env, Value *);
    int (*createFunction)(Env, const char *, size_t, Callback, void *, Value *);
    int (*set)(Env, Value, const char *, Value);
    int (*get)(Env, Value, const char *, Value *);
    int (*call)(Env, Value, Value, size_t, const Value *, Value *);
    int (*boolean)(Env, bool, Value *);
    int (*throwError)(Env, const char *, const char *);
} api{};
uintptr_t wrapperBase = 0;
uintptr_t responseStringReturnAddress() {
    return wrapperBase + activeProfile->responseStringCall.rva + activeProfile->responseStringCall.size;
}
Convert originalStringConverter = nullptr;
Receive originalResponseCallback = nullptr;
CreatePromise originalCreatePromise = nullptr;
CreateString originalCreateString = nullptr;
// Request scope is synchronous (napi_call_function). Responses arrive later, so
// tracking the exact napi_deferred reconnects them to that scope. Thread-local
// flags are restored on nested callbacks; ordinary QQ API calls pass through.
thread_local bool isRawRequest = false, isRawResponse = false;
std::mutex pendingDeferredsMutex, initializationMutex;
std::unordered_set<void *> pendingDeferreds;
bool bridgeInstalled = false;
std::string initializationError;

template <class T> T resolve(HMODULE runtime, const char *name) {
    auto address = GetProcAddress(runtime, name);
    if (!address)
        throw std::runtime_error(std::string("missing N-API export: ") + name);
    return reinterpret_cast<T>(address);
}
void check(int status, const char *operation) {
    if (status)
        throw std::runtime_error(std::string(operation) + ": N-API " + std::to_string(status));
}
std::string stringArg(Env env, Value value) {
    size_t size = 0;
    check(api.getString(env, value, nullptr, 0, &size), "read version length");
    if (size > 64)
        throw std::runtime_error("version too long");
    std::string result(size + 1, '\0');
    check(api.getString(env, value, result.data(), result.size(), &size), "read version");
    result.resize(size);
    return result;
}
struct ScopedFlag {
    bool &flag;
    bool old;
    ScopedFlag(bool &value, bool next) : flag(value), old(value) {
        flag = next;
    }
    ~ScopedFlag() {
        flag = old;
    }
};
// Do not reinterpret output as this compiler's std::string: MSVC and QQ's
// libc++ have different layouts and allocators. Ask the original converter to
// allocate an equally-sized ASCII string, then overwrite its data, keeping its
// allocation, length and trailing NUL intact. This preserves embedded NUL/non-UTF8
// bytes without ever freeing QQ memory through OpenQQ's C++ runtime.
void *convertPacketArgument(void *output, Env env, Value value) {
    bool isBuffer = false;
    if (!isRawRequest || api.isBuffer(env, value, &isBuffer) || !isBuffer)
        return originalStringConverter(output, env, value);
    void *data = nullptr;
    size_t size = 0;
    if (api.getBuffer(env, value, &data, &size) || size > kMaxPacketBytes)
        return originalStringConverter(output, env, value);
    std::string placeholder(size, 'x');
    Value text = nullptr;
    if (originalCreateString(env, placeholder.data(), placeholder.size(), &text))
        return originalStringConverter(output, env, value);
    auto result = originalStringConverter(output, env, text);
    auto storage = static_cast<unsigned char *>(output);
    size_t length = 0;
    char *destination = nullptr;
    if (storage[0] & activeProfile->stringLayout.longFlagMask) {
        std::memcpy(&length, storage + activeProfile->stringLayout.longLengthOffset, sizeof(length));
        std::memcpy(&destination, storage + activeProfile->stringLayout.longDataOffset, sizeof(destination));
    } else {
        length = storage[0] >> activeProfile->stringLayout.shortLengthShift;
        destination = reinterpret_cast<char *>(storage + activeProfile->stringLayout.inlineDataOffset);
    }
    if (length == size && destination && size)
        std::memcpy(destination, data, size);
    return result;
}
// Intercept only wrapper.node's import slot, not the runtime-wide N-API export.
// Promise handles remain QQ-owned; the set stores identity, never ownership.
int trackCreatedPromise(Env env, void **deferred, Value *promise) {
    int status = originalCreatePromise(env, deferred, promise);
    if (!status && isRawRequest && deferred && *deferred) {
        std::lock_guard<std::mutex> lock(pendingDeferredsMutex);
        pendingDeferreds.insert(*deferred);
    }
    return status;
}
// Both checks are necessary: errMsg is also serialized as UTF-8 in this callback.
// Change only the rsp call site for a deferred belonging to an explicit raw send.
// Keep QQ's existing property name and result/error handling unchanged.
int createResponseValue(Env env, const char *text, size_t length, Value *result, uintptr_t caller) {
    if (isRawResponse && caller == responseStringReturnAddress()) {
        if (length > kMaxPacketBytes)
            return kNapiGenericFailure;
        return api.createBuffer(env, length, text, nullptr, result);
    }
    return originalCreateString(env, text, length, result);
}
int createStringOrPacketBuffer(Env env, const char *text, size_t length, Value *result) {
#ifdef _MSC_VER
    const auto caller = reinterpret_cast<uintptr_t>(_ReturnAddress());
#else
    const auto caller = reinterpret_cast<uintptr_t>(__builtin_return_address(0));
#endif
    return createResponseValue(env, text, length, result, caller);
}
void completePacketResponse(void *object) {
    // These are private ABI fields, described by the selected verified profile.
    // QQ clears the deferred after resolving it; only then forget its identity.
    // Do not cancel/free it on JS timeout: QQ may still complete the request.
    auto context = *reinterpret_cast<unsigned char **>(static_cast<unsigned char *>(object) +
                                                       activeProfile->callbackContextOffset);
    void *deferred =
        context ? *reinterpret_cast<void **>(context + activeProfile->contextDeferredOffset) : nullptr;
    bool ours = false;
    if (deferred) {
        std::lock_guard<std::mutex> lock(pendingDeferredsMutex);
        ours = pendingDeferreds.count(deferred) != 0;
    }
    ScopedFlag scope(isRawResponse, ours);
    originalResponseCallback(object);
    if (ours && !*reinterpret_cast<void **>(context + activeProfile->contextDeferredOffset)) {
        std::lock_guard<std::mutex> lock(pendingDeferredsMutex);
        pendingDeferreds.erase(deferred);
    }
}
// Locate this module's IAT entry by symbol name. The response call instruction is
// separately checked to reference the same slot, preventing an incorrect site
// from redirecting unrelated text creation.
void **findImportSlot(uintptr_t image, const char *wanted) {
    auto dos = reinterpret_cast<IMAGE_DOS_HEADER *>(image);
    auto nt = reinterpret_cast<IMAGE_NT_HEADERS64 *>(image + dos->e_lfanew);
    const auto directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!directory.VirtualAddress)
        throw std::runtime_error("wrapper has no import table");
    auto descriptor = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR *>(image + directory.VirtualAddress);
    for (; descriptor->Name; ++descriptor) {
        if (!descriptor->OriginalFirstThunk)
            continue;
        auto names = reinterpret_cast<IMAGE_THUNK_DATA64 *>(image + descriptor->OriginalFirstThunk);
        auto slots = reinterpret_cast<IMAGE_THUNK_DATA64 *>(image + descriptor->FirstThunk);
        for (; names->u1.AddressOfData; ++names, ++slots) {
            if (IMAGE_SNAP_BY_ORDINAL64(names->u1.Ordinal))
                continue;
            auto name = reinterpret_cast<IMAGE_IMPORT_BY_NAME *>(image + names->u1.AddressOfData);
            if (!std::strcmp(reinterpret_cast<const char *>(name->Name), wanted))
                return reinterpret_cast<void **>(&slots->u1.Function);
        }
    }
    throw std::runtime_error(std::string("wrapper import missing: ") + wanted);
}
void writeAbsoluteJump(unsigned char *at, const void *target) {
    // jmp qword ptr [rip+0]; absolute target. No register is clobbered.
    const unsigned char code[] = {0xff, 0x25, 0, 0, 0, 0};
    std::memcpy(at, code, sizeof(code));
    std::memcpy(at + 6, &target, sizeof(target));
}
// A deliberately narrow trampoline: profiles must identify whole instructions
// with no RIP-relative operands or branches in the overwritten prologue. This is
// not a general disassembler/relocator. Trampolines stay mapped until QQ exits;
// callbacks may still reach them after OpenQQ disconnects.
struct EntryDetour {
    unsigned char *target;
    size_t size;
    unsigned char *trampoline;
    std::array<unsigned char, 32> before{}, after{};
    EntryDetour(uintptr_t address, const unsigned char *signature, size_t length, void *hook)
        : target(reinterpret_cast<unsigned char *>(address)), size(length), trampoline(nullptr) {
        if (length < kAbsoluteJumpBytes || length > before.size() || std::memcmp(target, signature, length))
            throw std::runtime_error("wrapper instruction signature mismatch; hook not bridgeInstalled");
        std::memcpy(before.data(), target, size);
        after.fill(0x90);
        writeAbsoluteJump(after.data(), hook);
        trampoline = static_cast<unsigned char *>(
            VirtualAlloc(nullptr, size + kAbsoluteJumpBytes, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE));
        if (!trampoline)
            throw std::runtime_error("allocate trampoline failed");
        // Both verified prologues consist only of pushes and stack setup: no relocation.
        std::memcpy(trampoline, target, size);
        writeAbsoluteJump(trampoline + size, target + size);
        DWORD old = 0;
        if (!VirtualProtect(trampoline, size + kAbsoluteJumpBytes, PAGE_EXECUTE_READ, &old))
            throw std::runtime_error("protect trampoline failed");
        FlushInstructionCache(GetCurrentProcess(), trampoline, size + kAbsoluteJumpBytes);
    }
};
// Discover thread handles before suspension; do not allocate/log while threads
// are paused, since one could own the allocator lock. Refuse installation when
// a captured RIP is in either overwritten prologue instead of moving that RIP.
// This covers the snapshot's threads, not arbitrary future thread creation.
struct PausedThreads {
    std::vector<HANDLE> handles;
    size_t paused = 0;
    PausedThreads() {
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
            throw std::runtime_error("thread snapshot failed");
        THREADENTRY32 entry{};
        entry.dwSize = sizeof(entry);
        bool ok = true;
        if (Thread32First(snapshot, &entry))
            do {
                if (entry.th32OwnerProcessID != GetCurrentProcessId() ||
                    entry.th32ThreadID == GetCurrentThreadId())
                    continue;
                HANDLE handle =
                    OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE,
                               entry.th32ThreadID);
                if (!handle) {
                    ok = false;
                    break;
                }
                handles.push_back(handle);
            } while (Thread32Next(snapshot, &entry));
        CloseHandle(snapshot);
        if (!ok) {
            for (auto h : handles)
                CloseHandle(h);
            handles.clear();
            throw std::runtime_error("open QQ threads failed");
        }
    }
    bool pause(const EntryDetour &a, const EntryDetour &b) {
        for (auto handle : handles) {
            if (SuspendThread(handle) == DWORD(-1))
                return false;
            ++paused;
            CONTEXT context{};
            context.ContextFlags = CONTEXT_CONTROL;
            if (!GetThreadContext(handle, &context))
                return false;
            for (const EntryDetour *patch : {&a, &b}) {
                auto start = reinterpret_cast<uintptr_t>(patch->target);
                if (context.Rip >= start && context.Rip < start + patch->size)
                    return false;
            }
        }
        return true;
    }
    void resume() {
        while (paused)
            ResumeThread(handles[--paused]);
    }
    ~PausedThreads() {
        resume();
        for (auto handle : handles)
            CloseHandle(handle);
    }
};
bool writeEntryDetour(EntryDetour &patch, bool restore) {
    DWORD old = 0;
    if (!VirtualProtect(patch.target, patch.size, PAGE_EXECUTE_READWRITE, &old))
        return false;
    std::memcpy(patch.target, restore ? patch.before.data() : patch.after.data(), patch.size);
    FlushInstructionCache(GetCurrentProcess(), patch.target, patch.size);
    DWORD unused = 0;
    return VirtualProtect(patch.target, patch.size, old, &unused) != 0;
}
bool writeImportSlot(void **slot, void *target) {
    DWORD old = 0;
    if (!VirtualProtect(slot, sizeof(void *), PAGE_READWRITE, &old))
        return false;
    InterlockedExchangePointer(reinterpret_cast<void *volatile *>(slot), target);
    DWORD unused = 0;
    return VirtualProtect(slot, sizeof(void *), old, &unused) != 0;
}
void initialize(const std::string &version) {
    std::lock_guard<std::mutex> lock(initializationMutex);
    if (bridgeInstalled) {
        if (!activeProfile || version != activeProfile->version)
            throw std::runtime_error("packet profile cannot change within one QQ process");
        return;
    }
    if (!initializationError.empty())
        throw std::runtime_error(initializationError);
    try {
        const auto profile = findPacketProfile(version);
        if (!profile)
            throw std::runtime_error("unsupported QQ packet profile: " + version + " (verified: " +
                                     supportedVersionList() + ")");
        auto dos = reinterpret_cast<IMAGE_DOS_HEADER *>(wrapperBase);
        auto nt = reinterpret_cast<IMAGE_NT_HEADERS64 *>(wrapperBase + dos->e_lfanew);
        if (nt->FileHeader.TimeDateStamp != profile->peTimestamp ||
            nt->OptionalHeader.SizeOfImage != profile->imageSize)
            throw std::runtime_error("wrapper PE identity mismatch");
        // Validate image identity, instruction bytes and IAT relationship before
        // publishing any hook. A version string alone is not a sufficient guard.
        const auto &responseCall = profile->responseStringCall;
        if (responseCall.size != 6 || std::memcmp(reinterpret_cast<void *>(wrapperBase + responseCall.rva),
                                                  responseCall.bytes, responseCall.size))
            throw std::runtime_error("response conversion signature mismatch");
        auto promiseSlot = findImportSlot(wrapperBase, "napi_create_promise");
        auto stringSlot = findImportSlot(wrapperBase, "napi_create_string_utf8");
        originalCreatePromise = reinterpret_cast<CreatePromise>(*promiseSlot);
        originalCreateString = reinterpret_cast<CreateString>(*stringSlot);
        const auto displacement = *reinterpret_cast<const int32_t *>(wrapperBase + responseCall.rva + 2);
        auto actualSlot =
            reinterpret_cast<void **>(wrapperBase + responseCall.rva + responseCall.size + displacement);
        if (actualSlot != stringSlot)
            throw std::runtime_error("response string IAT mismatch");
        EntryDetour send(wrapperBase + profile->stringConverter.rva, profile->stringConverter.bytes,
                         profile->stringConverter.size, reinterpret_cast<void *>(convertPacketArgument));
        EntryDetour recv(wrapperBase + profile->responseCallback.rva, profile->responseCallback.bytes,
                         profile->responseCallback.size, reinterpret_cast<void *>(completePacketResponse));
        // Publish fallback functions before changing import slots/code entries.
        // All hooks must be able to pass through even during installation rollback.
        originalStringConverter = reinterpret_cast<Convert>(send.trampoline);
        originalResponseCallback = reinterpret_cast<Receive>(recv.trampoline);
        activeProfile = profile;
        PausedThreads threads;
        const bool paused = threads.pause(send, recv);
        bool ok = false;
        if (paused) {
            // Roll back every site on failure, including a site whose protection
            // restoration failed after its bytes had already been written.
            ok = writeImportSlot(promiseSlot, reinterpret_cast<void *>(trackCreatedPromise)) &&
                 writeImportSlot(stringSlot, reinterpret_cast<void *>(createStringOrPacketBuffer)) &&
                 writeEntryDetour(send, false) && writeEntryDetour(recv, false);
            if (!ok) {
                writeEntryDetour(send, true);
                writeEntryDetour(recv, true);
                writeImportSlot(promiseSlot, reinterpret_cast<void *>(originalCreatePromise));
                writeImportSlot(stringSlot, reinterpret_cast<void *>(originalCreateString));
            }
        }
        threads.resume();
        if (!ok)
            throw std::runtime_error("packet hook installation failed; bridge disabled for this process");
        bridgeInstalled = true;
    } catch (const std::exception &error) {
        initializationError = error.what();
        throw;
    }
}
Value initCallback(Env env, void *info) {
    try {
        Value argv[1]{};
        size_t count = 1;
        check(api.getArgs(env, info, &count, argv, nullptr, nullptr), "initialize arguments");
        if (count != 1)
            throw std::runtime_error("initialize requires exact QQ version");
        initialize(stringArg(env, argv[0]));
        Value result = nullptr;
        check(api.boolean(env, true, &result), "initialize result");
        return result;
    } catch (const std::exception &error) {
        api.throwError(env, nullptr, error.what());
        return nullptr;
    }
}
// JS passes the service object explicitly so its native method keeps the correct
// receiver. Only this napi_call_function activates binary argument conversion;
// unrelated QQ calls and their deferreds are not opted into the packet bridge.
Value sendCallback(Env env, void *info) {
    try {
        if (!bridgeInstalled)
            throw std::runtime_error("packet bridge is not initialized");
        Value argv[3]{};
        size_t count = 3;
        check(api.getArgs(env, info, &count, argv, nullptr, nullptr), "send arguments");
        if (count != 3)
            throw std::runtime_error("send requires service, command and Buffer");
        bool buffer = false;
        check(api.isBuffer(env, argv[2], &buffer), "packet buffer");
        void *data = nullptr;
        size_t size = 0;
        if (!buffer)
            throw std::runtime_error("packet must be a Buffer");
        check(api.getBuffer(env, argv[2], &data, &size), "packet size");
        if (size > kMaxPacketBytes)
            throw std::runtime_error("packet exceeds 1 MiB");
        {
            std::lock_guard<std::mutex> lock(pendingDeferredsMutex);
            if (pendingDeferreds.size() >= kMaxPendingRequests)
                throw std::runtime_error("too many pendingDeferreds native packet requests");
        }
        Value method = nullptr, result = nullptr;
        check(api.get(env, argv[0], "sendSsoCmdReqByContend", &method), "send method");
        ScopedFlag scope(isRawRequest, true);
        const int status = api.call(env, argv[0], method, 2, argv + 1, &result);
        if (status == kNapiPendingException)
            return nullptr; // Preserve the original pendingDeferreds JS exception.
        check(status, "native send");
        return result;
    } catch (const std::exception &error) {
        api.throwError(env, nullptr, error.what());
        return nullptr;
    }
}
} // namespace

// Called by the existing bootstrap after QQ's wrapper initializer. Only publish
// JS entry points here; installation waits for the first uncached download query,
// when QQ's session and asynchronous services are ready.
void InstallPacketBridge(void *env, HMODULE runtime, AddonInit original, void *global) {
    HMODULE wrapper = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(original), &wrapper))
        return;
    wchar_t filename[32768]{};
    if (!GetModuleFileNameW(wrapper, filename, 32768))
        return;
    const auto name = wcsrchr(filename, L'\\');
    if (_wcsicmp(name ? name + 1 : filename, L"wrapper.node"))
        return; // Native fixtures have no real N-API.
    wrapperBase = reinterpret_cast<uintptr_t>(wrapper);
#define NAPI(member, name) api.member = resolve<decltype(api.member)>(runtime, name)
    NAPI(getArgs, "napi_get_cb_info");
    NAPI(getString, "napi_get_value_string_utf8");
    NAPI(isBuffer, "napi_is_buffer");
    NAPI(getBuffer, "napi_get_buffer_info");
    NAPI(createBuffer, "napi_create_buffer_copy");
    NAPI(createObject, "napi_create_object");
    NAPI(createFunction, "napi_create_function");
    NAPI(set, "napi_set_named_property");
    NAPI(get, "napi_get_named_property");
    NAPI(call, "napi_call_function");
    NAPI(boolean, "napi_get_boolean");
    NAPI(throwError, "napi_throw_error");
#undef NAPI
    Value bridge = nullptr, init = nullptr, send = nullptr;
    check(api.createObject(env, &bridge), "bridge object");
    check(api.createFunction(env, "initialize", SIZE_MAX, initCallback, nullptr, &init), "bridge initialize");
    check(api.createFunction(env, "send", SIZE_MAX, sendCallback, nullptr, &send), "bridge send");
    check(api.set(env, bridge, "initialize", init), "set initialize");
    check(api.set(env, bridge, "send", send), "set send");
    check(api.set(env, global, "__openqq_packet", bridge), "publish packet bridge");
}
