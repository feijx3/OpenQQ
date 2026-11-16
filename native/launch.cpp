#include "bootstrap.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <cwctype>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

static void require(bool ok, const char* operation) {
    if (!ok) throw std::runtime_error(std::string(operation) + " (Win32 " + std::to_string(GetLastError()) + ")");
}
static std::wstring wide(const std::string& text) {
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    require(count > 0, "invalid UTF-8");
    std::wstring result(count, L'\0');
    require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), count) == count, "UTF-8 conversion");
    return result;
}
static std::wstring lower(std::wstring text) {
    std::transform(text.begin(), text.end(), text.begin(), towlower);
    return text;
}
static std::wstring filename(const std::wstring& path) { return lower(path.substr(path.find_last_of(L"\\/") + 1)); }
static std::wstring filePath(HANDLE file) {
    std::wstring path(32768, L'\0');
    DWORD length = GetFinalPathNameByHandleW(file, path.data(), static_cast<DWORD>(path.size()), FILE_NAME_NORMALIZED);
    require(length && length < path.size(), "GetFinalPathNameByHandle");
    path.resize(length);
    return lower(path);
}
static std::wstring localPath(const std::string& input) {
    auto path = wide(input);
    require(path.rfind(L"\\\\", 0) != 0 && path.rfind(L"//", 0) != 0, "network/device paths are forbidden");
    HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    require(file != INVALID_HANDLE_VALUE, "open input path");
    try {
        auto result = filePath(file);
        require(result.size() > 7 && result[5] == L':' && result[6] == L'\\', "expected a local drive path");
        CloseHandle(file);
        return result;
    }
    catch (...) { CloseHandle(file); throw; }
}
static std::string quote(const std::string& input) {
    std::string result = "\"";
    for (unsigned char c : input) {
        if (c == '\\' || c == '"') { result += '\\'; result += c; }
        else if (c < 32) result += ' ';
        else result += c;
    }
    return result + '"';
}
static void log(const std::string& value) { std::cerr << "[OpenQQ/native] " << value << std::endl; }
// Process exit codes as text: NTSTATUS crash codes in hex with a short name, ordinary codes in decimal.
static std::string exitCode(DWORD code) {
    if (code < 0x80000000) return std::to_string(code);
    char hex[16];
    std::snprintf(hex, sizeof(hex), "0x%08lX", static_cast<unsigned long>(code));
    const char* name = code == 0xC0000005 ? " access violation" : code == 0xC0000409 ? " fail-fast/stack buffer overrun"
        : code == 0xC0000374 ? " heap corruption" : code == 0xC000001D ? " illegal instruction" : code == 0xC00000FD ? " stack overflow"
        : code == 0x80000003 ? " breakpoint" : code == 0xC000013A ? " console interrupt" : "";
    return std::string(hex) + name;
}
static std::string line(size_t limit) {
    std::string result;
    char c;
    while (std::cin.get(c) && c != '\n') {
        if (result.size() >= limit || c == '\0' || c == '\r') throw std::runtime_error("invalid bootstrap input");
        result += c;
    }
    if (result.empty() || !std::cin) throw std::runtime_error("missing bootstrap input");
    return result;
}

class Launcher {
    PROCESS_INFORMATION process{};
    std::map<DWORD, HANDLE> threads;
    std::map<uintptr_t, std::wstring> modules;
    uintptr_t watch = 0, runtime = 0, callback = 0, bootstrap = 0, allocation = 0;
    DWORD heldThread = 0, loaderThread = 0;
    CONTEXT saved{};
    DEBUG_EVENT event{};
    bool pending = false, attached = false, initialBreakpoint = false, redirected = false;
    std::wstring wrapper, dll;
    std::string source;
    // Where the bootstrap was when something went wrong; included in every failure message.
    const char* stage = "starting QQ";

    [[noreturn]] void exited(DWORD code) {
        throw std::runtime_error("QQ exited before bootstrap completed (exit code " + exitCode(code) + "; stage: " + stage + ")");
    }
    // Once the initializer is redirected no more breakpoints are needed: detach so QQ never continues its
    // startup under a debugger, then wait for the bootstrap status without debug events.
    void finish(std::chrono::steady_clock::time_point deadline, const std::atomic<bool>& cancelled) {
        auto checkExit = [this] {
            if (WaitForSingleObject(process.hProcess, 0) != WAIT_OBJECT_0) return;
            DWORD code = 0;
            GetExitCodeProcess(process.hProcess, &code);
            exited(code);
        };
        for (int attempt = 0;; ++attempt) {
            if (DebugActiveProcessStop(process.dwProcessId)) break;
            DWORD error = GetLastError();
            checkExit();
            if (error != ERROR_ACCESS_DENIED || attempt >= 50 || std::chrono::steady_clock::now() >= deadline || cancelled) {
                SetLastError(error);
                require(false, "DebugActiveProcessStop");
            }
            WaitForSingleObject(process.hProcess, 10);
            checkExit();
        }
        attached = false;
        // DebugActiveProcessStop closes the debug-event thread handles owned by the system.
        threads.clear();
        while (std::chrono::steady_clock::now() < deadline && !cancelled) {
            checkExit();
            BootstrapConfig config{};
            try { config = read<BootstrapConfig>(allocation); }
            catch (...) { checkExit(); throw; }
            if (config.status < 0) throw std::runtime_error(std::string(config.error, strnlen(config.error, sizeof(config.error))));
            if (config.status > 0) {
                log("{\"stage\":\"bootstrapped\",\"pid\":" + std::to_string(process.dwProcessId) + "}");
                return;
            }
            WaitForSingleObject(process.hProcess, 25);
        }
        throw std::runtime_error(std::string(cancelled ? "bootstrap cancelled" : "bootstrap timed out after 30 seconds") + " (stage: " + stage + ")");
    }

    void read(uintptr_t address, void* data, size_t size) {
        SIZE_T got = 0;
        require(ReadProcessMemory(process.hProcess, reinterpret_cast<void*>(address), data, size, &got) && got == size, "ReadProcessMemory");
    }
    template<class T> T read(uintptr_t address) { T value{}; read(address, &value, sizeof(value)); return value; }
    void write(uintptr_t address, const void* data, size_t size) {
        SIZE_T sent = 0;
        require(WriteProcessMemory(process.hProcess, reinterpret_cast<void*>(address), data, size, &sent) && sent == size, "WriteProcessMemory");
    }
    std::string string(uintptr_t address) {
        std::string result;
        for (size_t i = 0; i < 512; ++i) {
            char c = read<char>(address + i);
            if (!c) return result;
            result += c;
        }
        throw std::runtime_error("unterminated export/module name");
    }
    uintptr_t exported(uintptr_t base, const char* name) {
        auto dos = read<IMAGE_DOS_HEADER>(base);
        require(dos.e_magic == IMAGE_DOS_SIGNATURE && dos.e_lfanew > 0 && dos.e_lfanew < 1048576, "invalid DOS header");
        auto nt = read<IMAGE_NT_HEADERS64>(base + dos.e_lfanew);
        require(nt.Signature == IMAGE_NT_SIGNATURE && nt.FileHeader.Machine == IMAGE_FILE_MACHINE_AMD64 && nt.OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC, "expected x64 PE");
        auto directory = nt.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT];
        require(directory.VirtualAddress && directory.Size, "missing exports");
        auto exports = read<IMAGE_EXPORT_DIRECTORY>(base + directory.VirtualAddress);
        require(exports.NumberOfNames <= 200000, "invalid exports");
        for (DWORD i = 0; i < exports.NumberOfNames; ++i) {
            auto rva = read<DWORD>(base + exports.AddressOfNames + i * sizeof(DWORD));
            if (string(base + rva) != name) continue;
            auto ordinal = read<WORD>(base + exports.AddressOfNameOrdinals + i * sizeof(WORD));
            require(ordinal < exports.NumberOfFunctions, "invalid export ordinal");
            rva = read<DWORD>(base + exports.AddressOfFunctions + ordinal * sizeof(DWORD));
            require(rva && !(rva >= directory.VirtualAddress && rva - directory.VirtualAddress < directory.Size), "forwarded export unsupported");
            return base + rva;
        }
        throw std::runtime_error(std::string("missing export: ") + name);
    }
    void setWatch(HANDLE thread) {
        CONTEXT context{};
        context.ContextFlags = CONTEXT_DEBUG_REGISTERS;
        require(GetThreadContext(thread, &context), "GetThreadContext");
        context.Dr0 = watch;
        context.Dr6 = 0;
        context.Dr7 = (context.Dr7 & ~DWORD64(0xf0003)) | (watch ? 1 : 0);
        require(SetThreadContext(thread, &context), "SetThreadContext");
    }
    void watchAll(uintptr_t address) {
        watch = address;
        for (auto& entry : threads) setWatch(entry.second);
    }
    void inject(DWORD threadId, CONTEXT context) {
        saved = context;
        saved.Dr0 = saved.Dr6 = saved.Dr7 = 0;
        saved.EFlags |= 0x10000; // Resume past the execution breakpoint without changing code bytes.
        require(SuspendThread(threads.at(threadId)) != DWORD(-1), "SuspendThread");
        heldThread = threadId;
        stage = "loading the bootstrap DLL";
        watchAll(0);
        const size_t dllBytes = (dll.size() + 1) * sizeof(wchar_t);
        const size_t bytes = sizeof(BootstrapConfig) + source.size() + 1 + dllBytes;
        allocation = reinterpret_cast<uintptr_t>(VirtualAllocEx(process.hProcess, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
        require(allocation != 0, "VirtualAllocEx");
        auto sourceAddress = allocation + sizeof(BootstrapConfig);
        auto dllAddress = sourceAddress + source.size() + 1;
        BootstrapConfig config{reinterpret_cast<AddonInit>(callback), reinterpret_cast<HMODULE>(runtime), reinterpret_cast<const char*>(sourceAddress), 0, {}};
        write(allocation, &config, sizeof(config));
        write(sourceAddress, source.c_str(), source.size() + 1);
        write(dllAddress, dll.c_str(), dllBytes);

        // Resolve the actual owner of LoadLibraryW; kernel32 may forward it to KernelBase.
        auto load = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
        HMODULE owner = nullptr;
        require(load && GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, reinterpret_cast<LPCWSTR>(load), &owner), "LoadLibraryW owner");
        wchar_t ownerPath[32768];
        require(GetModuleFileNameW(owner, ownerPath, 32768) != 0, "GetModuleFileName");
        uintptr_t remoteOwner = 0;
        for (auto& entry : modules) if (filename(entry.second) == filename(ownerPath)) remoteOwner = entry.first;
        require(remoteOwner != 0, "remote LoadLibraryW owner missing");
        auto remoteLoad = remoteOwner + (reinterpret_cast<uintptr_t>(load) - reinterpret_cast<uintptr_t>(owner));
        HANDLE loader = CreateRemoteThread(process.hProcess, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(remoteLoad), reinterpret_cast<void*>(dllAddress), 0, &loaderThread);
        require(loader != nullptr, "CreateRemoteThread LoadLibraryW");
        CloseHandle(loader);
    }
    void exception(DWORD& disposition) {
        auto code = event.u.Exception.ExceptionRecord.ExceptionCode;
        auto address = reinterpret_cast<uintptr_t>(event.u.Exception.ExceptionRecord.ExceptionAddress);
        if (code == EXCEPTION_BREAKPOINT && !initialBreakpoint) { initialBreakpoint = true; return; }
        if (code != EXCEPTION_SINGLE_STEP || address != watch || !watch) { disposition = DBG_EXCEPTION_NOT_HANDLED; return; }
        auto thread = threads.at(event.dwThreadId);
        CONTEXT context{};
        context.ContextFlags = CONTEXT_ALL;
        require(GetThreadContext(thread, &context), "GetThreadContext breakpoint");
        if (!(context.Dr6 & 1)) { disposition = DBG_EXCEPTION_NOT_HANDLED; return; }
        if (callback) { inject(event.dwThreadId, context); return; }
        auto module = context.Rcx;
        auto init = module ? read<uintptr_t>(module + 16) : 0;
        auto name = module ? read<uintptr_t>(module + 24) : 0;
        MEMORY_BASIC_INFORMATION memory{};
        uintptr_t owner = init && VirtualQueryEx(process.hProcess, reinterpret_cast<void*>(init), &memory, sizeof(memory)) ? reinterpret_cast<uintptr_t>(memory.AllocationBase) : 0;
        auto found = modules.find(owner);
        bool target = found != modules.end() && found->second == wrapper;
        log("{\"stage\":\"addon_register\",\"name\":" + quote(name ? string(name) : "") + ",\"target\":" + (target ? "true}" : "false}"));
        if (target) { callback = init; watchAll(callback); stage = "waiting for the wrapper initializer"; }
        context.Dr0 = watch;
        context.Dr6 = 0;
        context.EFlags |= 0x10000;
        require(SetThreadContext(thread, &context), "resume registration");
    }
public:
    ~Launcher() {
        if (attached) {
            // Debug events stop all threads. Clear our breakpoints before detaching on every exit path.
            watch = 0;
            for (auto& entry : threads) {
                if (!pending) SuspendThread(entry.second);
                try { setWatch(entry.second); } catch (...) {}
                if (!pending) ResumeThread(entry.second);
            }
            if (heldThread && threads.count(heldThread)) ResumeThread(threads.at(heldThread));
            if (pending) ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE);
            DebugActiveProcessStop(process.dwProcessId);
        }
        for (auto& entry : threads) CloseHandle(entry.second);
        if (process.hProcess) CloseHandle(process.hProcess);
    }
    void run(const std::string& executable, const std::string& wrapperPath, const std::string& dllPath, std::string script, const std::atomic<bool>& cancelled) {
        // Keep extended paths for module identity checks, but QQ parses argv/cwd as DOS paths.
        auto qq = localPath(executable).substr(4);
        wrapper = localPath(wrapperPath);
        dll = localPath(dllPath);
        source = std::move(script);
        std::wstring command = L"\"" + qq + L"\"";
        auto cwd = qq.substr(0, qq.find_last_of(L"\\/"));
        // Inherit log pipes only; QQ must not inherit the credential/cancellation stdin pipe.
        HANDLE inherited[3]{};
        SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
        inherited[0] = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
        require(inherited[0] != INVALID_HANDLE_VALUE, "open NUL stdin");
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        SIZE_T attributeBytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
        std::vector<unsigned char> attributes(attributeBytes);
        startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
        bool initialized = false;
        try {
            require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &inherited[1], 0, TRUE, DUPLICATE_SAME_ACCESS), "duplicate stdout");
            require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &inherited[2], 0, TRUE, DUPLICATE_SAME_ACCESS), "duplicate stderr");
            require(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes), "initialize handle list");
            initialized = true;
            require(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr), "set inherited handles");
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = inherited[0];
            startup.StartupInfo.hStdOutput = inherited[1];
            startup.StartupInfo.hStdError = inherited[2];
            require(CreateProcessW(qq.c_str(), command.data(), nullptr, nullptr, TRUE,
                DEBUG_ONLY_THIS_PROCESS | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                nullptr, cwd.c_str(), &startup.StartupInfo, &process), "CreateProcessW");
        } catch (...) {
            if (initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
            for (auto handle : inherited) if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
            throw;
        }
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        for (auto handle : inherited) CloseHandle(handle);
        CloseHandle(process.hThread);
        attached = true;
        stage = "waiting for QQNT.dll";
        require(DebugSetProcessKillOnExit(FALSE), "DebugSetProcessKillOnExit");
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
        while (std::chrono::steady_clock::now() < deadline && !cancelled) {
            if (redirected) { finish(deadline, cancelled); return; }
            if (!WaitForDebugEvent(&event, 50)) {
                require(GetLastError() == ERROR_SEM_TIMEOUT, "WaitForDebugEvent");
                continue;
            }
            pending = true;
            DWORD disposition = DBG_CONTINUE;
            switch (event.dwDebugEventCode) {
            case CREATE_PROCESS_DEBUG_EVENT:
                threads[event.dwThreadId] = event.u.CreateProcessInfo.hThread;
                if (event.u.CreateProcessInfo.hProcess != process.hProcess) CloseHandle(event.u.CreateProcessInfo.hProcess);
                if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
                break;
            case CREATE_THREAD_DEBUG_EVENT:
                threads[event.dwThreadId] = event.u.CreateThread.hThread;
                if (watch) setWatch(event.u.CreateThread.hThread);
                break;
            case EXIT_THREAD_DEBUG_EVENT:
                if (event.dwThreadId == loaderThread && heldThread) {
                    require(bootstrap != 0 && event.u.ExitThread.dwExitCode != 0, "bootstrap DLL load failed");
                    saved.Rip = exported(bootstrap, "OpenQQBootstrap");
                    saved.R8 = allocation;
                    require(SetThreadContext(threads.at(heldThread), &saved), "redirect initializer");
                    require(ResumeThread(threads.at(heldThread)) != DWORD(-1), "ResumeThread");
                    heldThread = 0;
                    redirected = true;
                    stage = "running the bootstrap script";
                }
                threads.erase(event.dwThreadId);
                break;
            case LOAD_DLL_DEBUG_EVENT: {
                auto& info = event.u.LoadDll;
                if (!info.hFile) break;
                std::wstring path;
                try { path = filePath(info.hFile); } catch (...) { CloseHandle(info.hFile); throw; }
                CloseHandle(info.hFile);
                auto base = reinterpret_cast<uintptr_t>(info.lpBaseOfDll);
                modules[base] = path;
                if (path == dll) bootstrap = base;
                if (!runtime && filename(path) == L"qqnt.dll") {
                    runtime = base;
                    watchAll(exported(base, "qq_magic_napi_register"));
                    stage = "waiting for wrapper.node registration";
                    log("{\"stage\":\"runtime_found\",\"name\":\"QQNT.dll\",\"pid\":" + std::to_string(process.dwProcessId) + "}");
                }
                break;
            }
            case UNLOAD_DLL_DEBUG_EVENT:
                modules.erase(reinterpret_cast<uintptr_t>(event.u.UnloadDll.lpBaseOfDll));
                break;
            case EXCEPTION_DEBUG_EVENT: exception(disposition); break;
            case EXIT_PROCESS_DEBUG_EVENT:
                attached = false;
                exited(event.u.ExitProcess.dwExitCode);
            }
            require(ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition), "ContinueDebugEvent");
            pending = false;
        }
        throw std::runtime_error(std::string(cancelled ? "bootstrap cancelled" : "bootstrap timed out after 30 seconds") + " (stage: " + stage + ")");
    }
};

int main() {
    try {
        // Four bounded UTF-8 lines on stdin; credentials never enter process arguments or files.
        auto executable = line(32768), wrapper = line(32768), dll = line(32768), source = line(1048576);
        static std::atomic<bool> cancelled{false};
        std::thread([] { std::cin.get(); cancelled = true; }).detach();
        Launcher launcher;
        launcher.run(executable, wrapper, dll, std::move(source), cancelled);
        return 0;
    } catch (const std::exception& error) {
        log("{\"stage\":\"error\",\"error\":" + quote(error.what()) + "}");
        return 1;
    }
}
