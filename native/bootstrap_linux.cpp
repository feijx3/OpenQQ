#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <sys/mman.h>
#include <ucontext.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>

#if !defined(__x86_64__) && !defined(__aarch64__)
#error "OpenQQ Linux bootstrap supports x86_64 and aarch64"
#endif
static_assert(sizeof(void*) == 8, "OpenQQ requires 64-bit Linux");

namespace {

using AddonInit = void* (*)(void*, void*);
using DlopenFn = void* (*)(const char*, int);
using MagicRegisterFn = void (*)(void*);

struct NapiModule {
    int nm_version;
    unsigned int nm_flags;
    const char* nm_filename;
    AddonInit nm_register_func;
    const char* nm_modname;
    void* nm_priv;
    void* reserved[4];
};
static_assert(offsetof(NapiModule, nm_register_func) == 16);
static_assert(offsetof(NapiModule, nm_modname) == 24);

constexpr size_t kMaxSlots = 16;
#if defined(__x86_64__)
constexpr size_t kTrapSize = 1;
constexpr uint8_t kTrapByte = 0xCC;
#elif defined(__aarch64__)
constexpr size_t kTrapSize = 4;
constexpr uint32_t kTrapWord = 0xD4200000u;
#endif

struct HookSlot {
    AddonInit original;
    const char* modname;
    NapiModule cloned;
};

struct TrapState {
    uintptr_t reg_addr;
    uintptr_t ret_addr;
    int reg_orig_prot;
    int ret_orig_prot;
    uint8_t saved_reg[kTrapSize];
    uint8_t saved_ret[kTrapSize];
    bool reg_armed;
    bool ret_armed;
    pthread_t owner_thread;
    struct sigaction old_action;
};

DlopenFn g_real_dlopen = nullptr;
pthread_mutex_t g_hook_mutex = PTHREAD_MUTEX_INITIALIZER;
std::atomic<bool> g_active{false};
std::atomic<bool> g_bootstrapped{false};
std::atomic<bool> g_runtime_reported{false};
pid_t g_main_pid = 0;
int g_status_fd = -1;
void* g_runtime_handle = nullptr;
std::string* g_target_wrapper = nullptr;
std::string* g_source = nullptr;

HookSlot g_slots[kMaxSlots]{};
std::atomic<size_t> g_slot_count{0};
TrapState g_trap{};

std::string json_quote(const std::string& input) {
    std::string out = "\"";
    for (unsigned char c : input) {
        if (c == '\\' || c == '"') { out += '\\'; out += static_cast<char>(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c < 32) out += ' ';
        else out += static_cast<char>(c);
    }
    return out + '"';
}

void write_all(int fd, const void* data, size_t len) {
    const auto* ptr = static_cast<const uint8_t*>(data);
    while (len > 0) {
        ssize_t n = ::write(fd, ptr, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return;
        }
        ptr += n;
        len -= static_cast<size_t>(n);
    }
}

void send_status(const std::string& json) {
    if (g_status_fd < 0) return;
    std::string line = json + '\n';
    write_all(g_status_fd, line.data(), line.size());
}

void close_status_fd() {
    if (g_status_fd >= 0) {
        ::close(g_status_fd);
        g_status_fd = -1;
    }
}

std::string basename_of(const char* path) {
    if (!path || !*path) return "";
    const char* slash = std::strrchr(path, '/');
    return slash ? std::string(slash + 1) : std::string(path);
}

std::string realpath_of(const char* path) {
    if (!path || !*path) return "";
    char resolved[PATH_MAX];
    if (!::realpath(path, resolved)) return "";
    return resolved;
}

DlopenFn resolve_real_dlopen() {
    auto fn = __atomic_load_n(&g_real_dlopen, __ATOMIC_ACQUIRE);
    if (!fn) {
        fn = reinterpret_cast<DlopenFn>(::dlsym(RTLD_NEXT, "dlopen"));
        __atomic_store_n(&g_real_dlopen, fn, __ATOMIC_RELEASE);
    }
    return fn;
}

int parse_fd_env(const char* name) {
    const char* val = std::getenv(name);
    if (!val || !*val) return -1;
    char* end = nullptr;
    long parsed = std::strtol(val, &end, 10);
    if (*end != '\0' || parsed < 3 || parsed > 1048576) return -1;
    return static_cast<int>(parsed);
}

void strip_preload_self();

}  // namespace

extern "C" __attribute__((visibility("default"))) void qq_magic_napi_register(void* module_ptr);

namespace {

void openqq_init();

bool self_dl_info(Dl_info& info) {
    return ::dladdr(reinterpret_cast<const void*>(&openqq_init), &info) != 0;
}

bool is_self_symbol(void* sym) {
    if (!sym) return false;
    Dl_info self_info{};
    Dl_info sym_info{};
    if (!self_dl_info(self_info) || !::dladdr(sym, &sym_info)) return false;
    return self_info.dli_fbase == sym_info.dli_fbase;
}

void strip_preload_self_impl() {
    Dl_info self_info{};
    if (!self_dl_info(self_info) || !self_info.dli_fname) return;
    std::string self_real = realpath_of(self_info.dli_fname);
    const char* preload = std::getenv("LD_PRELOAD");
    if (!preload || !*preload) return;
    std::string next;
    const char* cur = preload;
    while (*cur) {
        while (*cur == ':' || *cur == ' ') ++cur;
        if (!*cur) break;
        const char* start = cur;
        while (*cur && *cur != ':' && *cur != ' ') ++cur;
        std::string item(start, static_cast<size_t>(cur - start));
        std::string item_real = realpath_of(item.c_str());
        if (item != self_info.dli_fname && (self_real.empty() || item_real != self_real)) {
            if (!next.empty()) next += ':';
            next += item;
        }
    }
    if (next.empty()) ::unsetenv("LD_PRELOAD");
    else ::setenv("LD_PRELOAD", next.c_str(), 1);
}

void strip_preload_self() { strip_preload_self_impl(); }

bool read_config_pipe(int fd, std::string& wrapper, std::string& source) {
    std::string data;
    char buf[8192];
    constexpr size_t kLimit = 2 * 1024 * 1024;
    while (data.size() < kLimit) {
        ssize_t n = ::read(fd, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (n == 0) break;
        data.append(buf, static_cast<size_t>(n));
    }
    size_t first = data.find('\n');
    if (first == std::string::npos) return false;
    size_t second = data.find('\n', first + 1);
    if (second == std::string::npos) return false;
    wrapper = data.substr(0, first);
    source = data.substr(first + 1, second - first - 1);
    return !wrapper.empty() && !source.empty();
}

void on_fork_child() {
    g_active.store(false, std::memory_order_release);
    close_status_fd();
}

int query_page_prot(uintptr_t addr) {
    int fd = ::open("/proc/self/maps", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return PROT_READ | PROT_EXEC;
    char buf[1024];
    size_t used = 0;
    for (;;) {
        ssize_t n = ::read(fd, buf + used, sizeof(buf) - 1 - used);
        if (n < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (n == 0 && used == 0) break;
        size_t total = used + static_cast<size_t>(n);
        buf[total] = '\0';
        char* cur = buf;
        for (;;) {
            char* eol = static_cast<char*>(std::memchr(cur, '\n', static_cast<size_t>(buf + total - cur)));
            if (!eol) break;
            *eol = '\0';
            char* dash = nullptr;
            unsigned long long start = std::strtoull(cur, &dash, 16);
            if (dash && *dash == '-') {
                char* sp = nullptr;
                unsigned long long end = std::strtoull(dash + 1, &sp, 16);
                if (sp && *sp == ' ' && addr >= start && addr < end) {
                    int prot = 0;
                    if (sp[1] == 'r') prot |= PROT_READ;
                    if (sp[2] == 'w') prot |= PROT_WRITE;
                    if (sp[3] == 'x') prot |= PROT_EXEC;
                    ::close(fd);
                    return prot ? prot : (PROT_READ | PROT_EXEC);
                }
            }
            cur = eol + 1;
        }
        size_t rem = static_cast<size_t>(buf + total - cur);
        if (n == 0) break;
        if (rem >= sizeof(buf) - 1) {
            // Long path on this line: discard up to next newline.
            used = 0;
            continue;
        }
        if (rem > 0) std::memmove(buf, cur, rem);
        used = rem;
    }
    ::close(fd);
    return PROT_READ | PROT_EXEC;
}

bool same_page(uintptr_t a, uintptr_t b) {
    long page = ::sysconf(_SC_PAGESIZE);
    if (page <= 0) page = 4096;
    uintptr_t mask = ~(static_cast<uintptr_t>(page) - 1);
    return (a & mask) == (b & mask);
}

bool set_page_prot(uintptr_t addr, size_t len, int prot) {
    long page = ::sysconf(_SC_PAGESIZE);
    if (page <= 0) page = 4096;
    uintptr_t mask = static_cast<uintptr_t>(page) - 1;
    uintptr_t begin = addr & ~mask;
    uintptr_t end = (addr + len + mask) & ~mask;
    return ::mprotect(reinterpret_cast<void*>(begin), end - begin, prot) == 0;
}

void write_trap_at(uintptr_t addr) {
#if defined(__x86_64__)
    *reinterpret_cast<volatile uint8_t*>(addr) = kTrapByte;
#elif defined(__aarch64__)
    *reinterpret_cast<volatile uint32_t*>(addr) = kTrapWord;
#endif
    __builtin___clear_cache(reinterpret_cast<char*>(addr), reinterpret_cast<char*>(addr + kTrapSize));
}

void restore_bytes_at(uintptr_t addr, const uint8_t* saved) {
    std::memcpy(reinterpret_cast<void*>(addr), saved, kTrapSize);
    __builtin___clear_cache(reinterpret_cast<char*>(addr), reinterpret_cast<char*>(addr + kTrapSize));
}

void* resolve_napi(const char* name) {
    void* sym = ::dlsym(RTLD_DEFAULT, name);
    if (!sym && g_runtime_handle) sym = ::dlsym(g_runtime_handle, name);
    if (!sym) throw std::runtime_error(name);
    return sym;
}

template<class T>
T api(const char* name) {
    return reinterpret_cast<T>(resolve_napi(name));
}

void check_napi(int status) {
    if (status) throw std::runtime_error("N-API returned " + std::to_string(status));
}

void* run_bootstrap(AddonInit original, void* env, void* exports) {
    send_status("{\"stage\":\"running_script\"}");
    void* result = original(env, exports);
    void* scope = nullptr;
    bool introduced_exception = false;
    using Pending = int (*)(void*, bool*);
    using Clear = int (*)(void*, void**);
    using Close = int (*)(void*, void*);
    Pending pending = nullptr;
    Clear clear = nullptr;
    Close close = nullptr;
    bool ok = false;
    std::string error_msg;
    try {
        pending = api<Pending>("napi_is_exception_pending");
        clear = api<Clear>("napi_get_and_clear_last_exception");
        close = api<Close>("napi_close_escapable_handle_scope");
        bool exception = false;
        check_napi(pending(env, &exception));
        if (exception) throw std::runtime_error("wrapper initializer has a pending exception");
        introduced_exception = true;
        auto open = api<int (*)(void*, void**)>("napi_open_escapable_handle_scope");
        auto global = api<int (*)(void*, void**)>("napi_get_global");
        auto set = api<int (*)(void*, void*, const char*, void*)>("napi_set_named_property");
        auto str = api<int (*)(void*, const char*, size_t, void**)>("napi_create_string_utf8");
        auto run = api<int (*)(void*, void*, void**)>("napi_run_script");
        auto escape = api<int (*)(void*, void*, void*, void**)>("napi_escape_handle");
        check_napi(open(env, &scope));
        void* object = nullptr;
        void* src = nullptr;
        void* value = nullptr;
        void* escaped = nullptr;
        check_napi(global(env, &object));
        check_napi(set(env, object, "__openqq_exports", result ? result : exports));
        check_napi(str(env, g_source ? g_source->c_str() : "", SIZE_MAX, &src));
        check_napi(run(env, src, &value));
        check_napi(escape(env, scope, value, &escaped));
        result = escaped;
        ok = true;
    } catch (const std::exception& err) {
        error_msg = err.what();
        if (introduced_exception && pending && clear) {
            bool exception = false;
            void* ignored = nullptr;
            if (!pending(env, &exception) && exception) clear(env, &ignored);
        }
    }
    if (scope && close && close(env, scope)) {
        ok = false;
        error_msg = "N-API scope close failed";
    }
    if (ok) {
        g_bootstrapped.store(true, std::memory_order_release);
        send_status("{\"stage\":\"bootstrapped\",\"pid\":" + std::to_string(::getpid()) + "}");
    } else {
        send_status("{\"stage\":\"error\",\"error\":" + json_quote(error_msg.empty() ? "bootstrap failed" : error_msg) + "}");
    }
    close_status_fd();
    return result;
}

void* dispatch_thunk(size_t idx, void* env, void* exports) {
    const HookSlot& slot = g_slots[idx];
    if (!slot.original) return exports;
    Dl_info info{};
    bool target = g_target_wrapper && ::dladdr(reinterpret_cast<void*>(slot.original), &info) &&
        realpath_of(info.dli_fname) == *g_target_wrapper;
    send_status("{\"stage\":\"addon_register\",\"name\":" + json_quote(slot.modname ? slot.modname : "") +
        ",\"target\":" + (target ? "true}" : "false}"));
    if (!target || g_bootstrapped.load(std::memory_order_acquire)) {
        return slot.original(env, exports);
    }
    return run_bootstrap(slot.original, env, exports);
}

template<size_t I>
void* bootstrap_thunk(void* env, void* exports) {
    return dispatch_thunk(I, env, exports);
}

AddonInit thunk_for(size_t idx) {
    static constexpr AddonInit table[kMaxSlots] = {
        bootstrap_thunk<0>, bootstrap_thunk<1>, bootstrap_thunk<2>, bootstrap_thunk<3>,
        bootstrap_thunk<4>, bootstrap_thunk<5>, bootstrap_thunk<6>, bootstrap_thunk<7>,
        bootstrap_thunk<8>, bootstrap_thunk<9>, bootstrap_thunk<10>, bootstrap_thunk<11>,
        bootstrap_thunk<12>, bootstrap_thunk<13>, bootstrap_thunk<14>, bootstrap_thunk<15>,
    };
    return idx < kMaxSlots ? table[idx] : nullptr;
}

void forward_sigtrap(int sig, siginfo_t* info, void* uctx) {
    if (g_trap.old_action.sa_flags & SA_SIGINFO) {
        if (g_trap.old_action.sa_sigaction) g_trap.old_action.sa_sigaction(sig, info, uctx);
        return;
    }
    if (g_trap.old_action.sa_handler != SIG_IGN && g_trap.old_action.sa_handler != SIG_DFL) {
        g_trap.old_action.sa_handler(sig);
        return;
    }
    struct sigaction def{};
    def.sa_handler = SIG_DFL;
    ::sigaction(SIGTRAP, &def, nullptr);
    ::raise(SIGTRAP);
}

void sigtrap_handler(int sig, siginfo_t* info, void* uctx) {
    if (!uctx || !pthread_equal(::pthread_self(), g_trap.owner_thread)) {
        forward_sigtrap(sig, info, uctx);
        return;
    }
    auto* uc = static_cast<ucontext_t*>(uctx);
#if defined(__x86_64__)
    uintptr_t pc = static_cast<uintptr_t>(uc->uc_mcontext.gregs[REG_RIP]);
    uintptr_t hit = pc - 1;
#elif defined(__aarch64__)
    uintptr_t pc = static_cast<uintptr_t>(uc->uc_mcontext.pc);
    uintptr_t hit = pc;
#endif
    if (g_trap.reg_armed && hit == g_trap.reg_addr) {
        restore_bytes_at(g_trap.reg_addr, g_trap.saved_reg);
        g_trap.reg_armed = false;
#if defined(__x86_64__)
        uc->uc_mcontext.gregs[REG_RIP] = static_cast<greg_t>(g_trap.reg_addr);
        auto* mod = reinterpret_cast<NapiModule*>(uc->uc_mcontext.gregs[REG_RDI]);
        uintptr_t ret_addr = *reinterpret_cast<uintptr_t*>(uc->uc_mcontext.gregs[REG_RSP]);
#elif defined(__aarch64__)
        auto* mod = reinterpret_cast<NapiModule*>(uc->uc_mcontext.regs[0]);
        uintptr_t ret_addr = static_cast<uintptr_t>(uc->uc_mcontext.regs[30]);
#endif
        if (mod && mod->nm_register_func) {
            size_t idx = g_slot_count.load(std::memory_order_relaxed);
            if (idx < kMaxSlots) {
                g_slot_count.store(idx + 1, std::memory_order_relaxed);
                g_slots[idx].original = mod->nm_register_func;
                g_slots[idx].modname = mod->nm_modname;
                g_slots[idx].cloned = *mod;
                g_slots[idx].cloned.nm_register_func = thunk_for(idx);
#if defined(__x86_64__)
                uc->uc_mcontext.gregs[REG_RDI] = reinterpret_cast<greg_t>(&g_slots[idx].cloned);
#elif defined(__aarch64__)
                uc->uc_mcontext.regs[0] = reinterpret_cast<uint64_t>(&g_slots[idx].cloned);
#endif
            }
        }
        if (ret_addr && ret_addr != g_trap.reg_addr && g_slot_count.load(std::memory_order_relaxed) < kMaxSlots) {
            int ret_prot = query_page_prot(ret_addr);
            if (set_page_prot(ret_addr, kTrapSize, PROT_READ | PROT_WRITE | PROT_EXEC)) {
                g_trap.ret_addr = ret_addr;
                g_trap.ret_orig_prot = ret_prot;
                std::memcpy(g_trap.saved_ret, reinterpret_cast<const void*>(ret_addr), kTrapSize);
                write_trap_at(ret_addr);
                g_trap.ret_armed = true;
            }
        }
        return;
    }
    if (g_trap.ret_armed && hit == g_trap.ret_addr) {
        uintptr_t old_ret = g_trap.ret_addr;
        int old_ret_prot = g_trap.ret_orig_prot;
        restore_bytes_at(old_ret, g_trap.saved_ret);
        g_trap.ret_armed = false;
        g_trap.ret_addr = 0;
#if defined(__x86_64__)
        uc->uc_mcontext.gregs[REG_RIP] = static_cast<greg_t>(old_ret);
#endif
        if (!g_trap.reg_armed && g_slot_count.load(std::memory_order_relaxed) < kMaxSlots) {
            write_trap_at(g_trap.reg_addr);
            g_trap.reg_armed = true;
        }
        if (!same_page(old_ret, g_trap.reg_addr)) {
            set_page_prot(old_ret, kTrapSize, old_ret_prot);
        }
        return;
    }
    forward_sigtrap(sig, info, uctx);
}

void report_runtime_if_known(void* reg_sym) {
    if (!reg_sym || g_runtime_reported.load(std::memory_order_acquire)) return;
    Dl_info info{};
    if (!::dladdr(reg_sym, &info) || !info.dli_fname) return;
    if (!g_runtime_handle) {
        DlopenFn real_dlopen = resolve_real_dlopen();
        if (real_dlopen) g_runtime_handle = real_dlopen(info.dli_fname, RTLD_NOLOAD | RTLD_LAZY);
    }
    if (!g_runtime_reported.exchange(true, std::memory_order_acq_rel)) {
        send_status("{\"stage\":\"runtime_found\",\"name\":" + json_quote(basename_of(info.dli_fname)) +
            ",\"pid\":" + std::to_string(::getpid()) + "}");
    }
}

__attribute__((constructor))
void openqq_init() {
    resolve_real_dlopen();
    int boot_fd = parse_fd_env("OPENQQ_BOOTSTRAP_FD");
    int status_fd = parse_fd_env("OPENQQ_STATUS_FD");
    ::unsetenv("OPENQQ_BOOTSTRAP_FD");
    ::unsetenv("OPENQQ_STATUS_FD");
    strip_preload_self();
    if (boot_fd < 0 || status_fd < 0) {
        if (boot_fd >= 0) ::close(boot_fd);
        if (status_fd >= 0) ::close(status_fd);
        return;
    }
    ::fcntl(status_fd, F_SETFD, FD_CLOEXEC);
    g_status_fd = status_fd;
    g_main_pid = ::getpid();
    std::string target_wrapper;
    std::string source;
    bool ok = read_config_pipe(boot_fd, target_wrapper, source);
    ::close(boot_fd);
    if (!ok) {
        send_status("{\"stage\":\"error\",\"error\":\"missing or invalid bootstrap configuration\"}");
        close_status_fd();
        return;
    }
    g_target_wrapper = new std::string(std::move(target_wrapper));
    g_source = new std::string(std::move(source));
    ::pthread_atfork(nullptr, nullptr, on_fork_child);
    g_active.store(true, std::memory_order_release);
    void* sym = ::dlsym(RTLD_DEFAULT, "qq_magic_napi_register");
    if (sym && !is_self_symbol(sym)) {
        report_runtime_if_known(sym);
    }
}

}  // namespace

extern "C" __attribute__((visibility("default")))
void qq_magic_napi_register(void* module_ptr) {
    MagicRegisterFn real_reg = reinterpret_cast<MagicRegisterFn>(::dlsym(RTLD_NEXT, "qq_magic_napi_register"));
    if (!real_reg && g_runtime_handle) {
        real_reg = reinterpret_cast<MagicRegisterFn>(::dlsym(g_runtime_handle, "qq_magic_napi_register"));
    }
    if (!real_reg || is_self_symbol(reinterpret_cast<void*>(real_reg))) return;
    if (!g_active.load(std::memory_order_acquire) || ::getpid() != g_main_pid || !module_ptr) {
        real_reg(module_ptr);
        return;
    }
    report_runtime_if_known(reinterpret_cast<void*>(real_reg));
    auto* mod = static_cast<NapiModule*>(module_ptr);
    Dl_info info{};
    bool target = g_target_wrapper && mod->nm_register_func && ::dladdr(reinterpret_cast<void*>(mod->nm_register_func), &info) &&
        realpath_of(info.dli_fname) == *g_target_wrapper;
    send_status("{\"stage\":\"addon_register\",\"name\":" + json_quote(mod->nm_modname ? mod->nm_modname : "") +
        ",\"target\":" + (target ? "true}" : "false}"));
    if (!target || g_bootstrapped.load(std::memory_order_acquire)) {
        real_reg(module_ptr);
        return;
    }
    size_t idx = g_slot_count.fetch_add(1, std::memory_order_relaxed);
    if (idx >= kMaxSlots) {
        real_reg(module_ptr);
        return;
    }
    g_slots[idx].original = mod->nm_register_func;
    g_slots[idx].modname = mod->nm_modname;
    g_slots[idx].cloned = *mod;
    g_slots[idx].cloned.nm_register_func = thunk_for(idx);
    real_reg(&g_slots[idx].cloned);
}

extern "C" __attribute__((visibility("default")))
void* dlopen(const char* filename, int flags) {
    DlopenFn real_dlopen = resolve_real_dlopen();
    if (!real_dlopen) return nullptr;
    if (!g_active.load(std::memory_order_acquire) || !filename || ::getpid() != g_main_pid) {
        return real_dlopen(filename, flags);
    }
    std::string resolved = realpath_of(filename);
    if (!g_target_wrapper || resolved != *g_target_wrapper) {
        void* handle = real_dlopen(filename, flags);
        if (handle && !g_runtime_reported.load(std::memory_order_acquire)) {
            void* reg = ::dlsym(handle, "qq_magic_napi_register");
            if (reg && !is_self_symbol(reg)) {
                if (!g_runtime_handle) g_runtime_handle = handle;
                report_runtime_if_known(reg);
            }
        }
        return handle;
    }

    ::pthread_mutex_lock(&g_hook_mutex);
    void* reg_sym = ::dlsym(RTLD_DEFAULT, "qq_magic_napi_register");
    bool need_trap = reg_sym && !is_self_symbol(reg_sym);
    bool trapped = false;
    if (need_trap) {
        report_runtime_if_known(reg_sym);
        uintptr_t reg_addr = reinterpret_cast<uintptr_t>(reg_sym);
        int orig_prot = query_page_prot(reg_addr);
        if (set_page_prot(reg_addr, kTrapSize, PROT_READ | PROT_WRITE | PROT_EXEC)) {
            struct sigaction sa{};
            sa.sa_sigaction = sigtrap_handler;
            sigemptyset(&sa.sa_mask);
            sa.sa_flags = SA_SIGINFO;
            if (::sigaction(SIGTRAP, &sa, &g_trap.old_action) == 0) {
                g_trap.reg_addr = reg_addr;
                g_trap.ret_addr = 0;
                g_trap.reg_orig_prot = orig_prot;
                g_trap.ret_orig_prot = PROT_READ | PROT_EXEC;
                std::memcpy(g_trap.saved_reg, reg_sym, kTrapSize);
                g_trap.reg_armed = true;
                g_trap.ret_armed = false;
                g_trap.owner_thread = ::pthread_self();
                write_trap_at(reg_addr);
                trapped = true;
            } else {
                set_page_prot(reg_addr, kTrapSize, orig_prot);
            }
        }
    }

    void* handle = real_dlopen(filename, flags);

    if (trapped) {
        if (g_trap.ret_armed && g_trap.ret_addr) {
            restore_bytes_at(g_trap.ret_addr, g_trap.saved_ret);
            if (!same_page(g_trap.ret_addr, g_trap.reg_addr)) {
                set_page_prot(g_trap.ret_addr, kTrapSize, g_trap.ret_orig_prot);
            }
            g_trap.ret_armed = false;
        }
        if (g_trap.reg_armed && g_trap.reg_addr) {
            restore_bytes_at(g_trap.reg_addr, g_trap.saved_reg);
            g_trap.reg_armed = false;
        }
        set_page_prot(g_trap.reg_addr, kTrapSize, g_trap.reg_orig_prot);
        ::sigaction(SIGTRAP, &g_trap.old_action, nullptr);
    }
    ::pthread_mutex_unlock(&g_hook_mutex);
    if (handle && !g_runtime_reported.load(std::memory_order_acquire)) {
        void* reg = ::dlsym(handle, "qq_magic_napi_register");
        if (reg && !is_self_symbol(reg)) {
            if (!g_runtime_handle) g_runtime_handle = handle;
            report_runtime_if_known(reg);
        }
    }
    return handle;
}
