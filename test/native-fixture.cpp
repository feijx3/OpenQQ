#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#include <limits.h>
#include <unistd.h>
#include <thread>
#endif

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>

using callback = void* (*)(void*, void*);
struct napi_module {
    int version; unsigned flags; const char* filename; callback init;
    const char* name; void* priv; void* reserved[4];
};
static_assert(offsetof(napi_module, init) == 16);
static_assert(offsetof(napi_module, name) == 24);

static bool mode(const char* expected) {
#ifdef _WIN32
    char value[64]{};
    return GetEnvironmentVariableA("OPENQQ_FIXTURE_MODE", value, sizeof(value)) && !std::strcmp(value, expected);
#else
    const char* value = std::getenv("OPENQQ_FIXTURE_MODE");
    return value && !std::strcmp(value, expected);
#endif
}

static bool output_path(std::string& out) {
#ifdef _WIN32
    char path[32768];
    if (!GetEnvironmentVariableA("OPENQQ_FIXTURE_OUTPUT", path, sizeof(path))) return false;
    out = path;
    return true;
#else
    const char* path = std::getenv("OPENQQ_FIXTURE_OUTPUT");
    if (!path || !*path) return false;
    out = path;
    return true;
#endif
}

static void sleep_ms(unsigned ms) {
#ifdef _WIN32
    Sleep(ms);
#else
    ::usleep(ms * 1000u);
#endif
}

#ifndef _WIN32
static std::string exe_dir() {
    char buf[PATH_MAX]{};
    ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n <= 0) return ".";
    std::string full(buf, static_cast<size_t>(n));
    size_t slash = full.find_last_of('/');
    return slash == std::string::npos ? "." : full.substr(0, slash);
}
#endif

#if defined(FIXTURE_HOST)
#ifdef _WIN32
__declspec(noinline) static void* decoy_init(void*, void* exports) { sleep_ms(1); return exports; }
#else
__attribute__((noinline)) static void* decoy_init(void*, void* exports) { sleep_ms(1); return exports; }
#endif
int main(int argc, char**) {
    if (argc != 1) return 9;
#ifdef _WIN32
    wchar_t executable[32768], cwd[32768];
    if (!GetModuleFileNameW(nullptr, executable, 32768) || !GetCurrentDirectoryW(32768, cwd)) return 10;
    // QQ's own resource/drive parsing expects ordinary DOS paths.
    if (!wcsncmp(executable, L"\\\\?\\", 4) || !wcsncmp(cwd, L"\\\\?\\", 4)) return 11;
    auto module = LoadLibraryW(L"QQNT.dll");
    if (!module) return 2;
    auto run = reinterpret_cast<void (*)(callback)>(GetProcAddress(module, "RunFixture"));
    if (!run) return 3;
    if (mode("cancel")) sleep_ms(300);
    if (mode("worker")) {
        auto thread = CreateThread(nullptr, 0, [](void* function) -> DWORD {
            reinterpret_cast<void (*)(callback)>(function)(decoy_init); return 0;
        }, reinterpret_cast<void*>(run), 0, nullptr);
        if (!thread) return 4;
        WaitForSingleObject(thread, INFINITE);
        CloseHandle(thread);
    } else run(decoy_init);
#else
    std::string lib = exe_dir() + "/QQNT.so";
    void* module = ::dlopen(lib.c_str(), RTLD_LAZY);
    if (!module) return 2;
    auto run = reinterpret_cast<void (*)(callback)>(::dlsym(module, "RunFixture"));
    if (!run) return 3;
    if (mode("cancel")) sleep_ms(300);
    if (mode("worker")) {
        std::thread worker([run] { run(decoy_init); });
        worker.join();
    } else run(decoy_init);
#endif
    sleep_ms(15000);
    return 0;
}

#elif defined(FIXTURE_ADDON)
extern "C" void qq_magic_napi_register(napi_module*);
static int addon_marker = 0;

__attribute__((noinline))
static void* addon_initialize(void*, void* exports) {
    if (exports) ++(*static_cast<int*>(exports));
    return exports;
}

__attribute__((constructor))
static void register_fixture_addon() {
    auto decoy = reinterpret_cast<callback>(::dlsym(RTLD_DEFAULT, "main_decoy_init"));
    if (decoy) {
        static napi_module unrelated = {0, 0, "fixture-decoy.node", decoy, "wrapper", nullptr, {}};
        qq_magic_napi_register(&unrelated);
    }
    static napi_module module = {1, 0, "fixture-wrapper.node", addon_initialize, "QQNT", &addon_marker, {}};
    qq_magic_napi_register(&module);
}

#else
#ifdef _WIN32
#define API extern "C" __declspec(dllexport)
#define NOINLINE __declspec(noinline)
#else
#define API extern "C" __attribute__((visibility("default")))
#define NOINLINE __attribute__((noinline))
#endif

static int global_object;
static int facade_object;
static bool scope_closed;
static bool exception_pending;
static int cleared;
static std::string script_source;
static napi_module* registered_modules[8]{};
static size_t registered_count = 0;

API int napi_get_global(void*, void** out) { *out = &global_object; return 0; }
API int napi_set_named_property(void*, void*, const char*, void*) { return 0; }
API int napi_create_string_utf8(void*, const char* data, uint64_t size, void** out) {
    script_source.assign(data, size == UINT64_MAX ? std::strlen(data) : size);
    *out = &script_source; return 0;
}
API int napi_run_script(void*, void*, void** out) {
    if (global_object != 2) return 1;
    if (mode("script-error")) { exception_pending = true; return 1; }
    std::string path;
    if (!output_path(path)) return 1;
    std::ofstream(path) << script_source;
    *out = &facade_object;
    return 0;
}
API int napi_open_escapable_handle_scope(void*, void** out) { *out = &global_object; return 0; }
API int napi_close_escapable_handle_scope(void*, void*) { scope_closed = true; return 0; }
API int napi_escape_handle(void*, void*, void* value, void** out) { *out = value; return 0; }
API int napi_is_exception_pending(void*, bool* out) { *out = exception_pending; return 0; }
API int napi_get_and_clear_last_exception(void*, void** out) { exception_pending = false; ++cleared; *out = nullptr; return 0; }
API NOINLINE void qq_magic_napi_register(napi_module* module) {
    global_object += module->version;
    if (registered_count < 8) registered_modules[registered_count++] = module;
}

#if defined(FIXTURE_MAIN_EXE)
API NOINLINE void* main_decoy_init(void*, void* exports) {
    sleep_ms(1);
    return exports;
}

int main(int argc, char**) {
    if (argc != 1) return 9;
    std::string addon = exe_dir() + "/fixture-wrapper.node";
    void* handle = ::dlopen(addon.c_str(), RTLD_LAZY);
    if (!handle || registered_count < 2) return 2;
    void* result = nullptr;
    for (size_t i = 0; i < registered_count; ++i) {
        if (registered_modules[i] && registered_modules[i]->init) {
            result = registered_modules[i]->init(&global_object, &global_object);
        }
    }
    std::string path;
    if (output_path(path)) {
        const char* outcome = result == &facade_object && scope_closed ? "escaped replacement" : "original return";
        std::ofstream(path + ".return") << outcome;
    }
    sleep_ms(15000);
    return 0;
}
#else
NOINLINE static void* initialize(void*, void* exports) {
    global_object++;
    if (mode("original-error")) exception_pending = true;
    // Simulates QQ dying inside its own initializer after the launcher has detached.
#ifdef _WIN32
    if (mode("exit")) ExitProcess(0xC0000409);
#else
    if (mode("exit")) _exit(77);
#endif
    sleep_ms(1);
    return exports;
}
static void* init_last_registered() {
    auto* entry = registered_count > 0 ? registered_modules[registered_count - 1] : nullptr;
    return entry && entry->init ? entry->init(&global_object, &global_object) : nullptr;
}
API void RunFixture(callback decoy) {
    napi_module unrelated = {0, 0, "fixture-decoy.node", decoy, "wrapper", nullptr, {}};
    qq_magic_napi_register(&unrelated);
    init_last_registered();
    napi_module module = {1, 0, "fixture-wrapper.node", initialize, "QQNT", nullptr, {}};
    qq_magic_napi_register(&module);
    auto result = init_last_registered();
    std::string path;
    if (output_path(path)) {
        const char* outcome = result == &facade_object && scope_closed ? "escaped replacement" : "original return";
        if (mode("original-error")) outcome = exception_pending && cleared == 0 && !scope_closed ? "original exception preserved" : "invalid exception";
        if (mode("script-error")) outcome = !exception_pending && cleared == 1 && scope_closed ? "script exception cleared" : "invalid exception";
        std::ofstream(path + ".return") << outcome;
    }
}
#endif
#endif
