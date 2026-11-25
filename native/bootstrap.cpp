#include "bootstrap.hpp"
#include "packet.hpp"
#include <cstdio>
#include <stdexcept>
#include <string>

template<class T> static T api(HMODULE module, const char* name) {
    auto address = GetProcAddress(module, name);
    if (!address) throw std::runtime_error(name);
    return reinterpret_cast<T>(address);
}
static void check(int status) {
    if (status) throw std::runtime_error("N-API returned " + std::to_string(status));
}

extern "C" __declspec(dllexport) void* OpenQQBootstrap(void* env, void* exports, BootstrapConfig* config) {
    // Run QQ's initializer unchanged, including any pending exception it creates.
    void* result = config->original(env, exports);
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
        InstallPacketBridge(env, runtime, config->original, object);
        check(set(env, object, "__openqq_exports", result ? result : exports));
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
