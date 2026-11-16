#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void require(bool ok, const char* operation) {
    if (!ok) {
        throw std::runtime_error(std::string(operation) + " (errno " + std::to_string(errno) + ": " + std::strerror(errno) + ")");
    }
}

std::string json_quote(const std::string& input) {
    std::string result = "\"";
    for (unsigned char c : input) {
        if (c == '\\' || c == '"') { result += '\\'; result += static_cast<char>(c); }
        else if (c < 32) result += ' ';
        else result += static_cast<char>(c);
    }
    return result + '"';
}

void log_native(const std::string& value) {
    std::fprintf(stderr, "[OpenQQ/native] %s\n", value.c_str());
    std::fflush(stderr);
}

std::string line_from_stdin(size_t limit) {
    std::string result;
    char c = 0;
    for (;;) {
        ssize_t n = ::read(STDIN_FILENO, &c, 1);
        if (n < 0) {
            if (errno == EINTR) continue;
            throw std::runtime_error("failed to read bootstrap input");
        }
        if (n == 0) throw std::runtime_error("missing bootstrap input");
        if (c == '\n') break;
        if (result.size() >= limit || c == '\0' || c == '\r') throw std::runtime_error("invalid bootstrap input");
        result += c;
    }
    if (result.empty()) throw std::runtime_error("missing bootstrap input");
    return result;
}

std::string basename_of(const std::string& path) {
    size_t pos = path.find_last_of('/');
    return pos == std::string::npos ? path : path.substr(pos + 1);
}

std::string dirname_of(const std::string& path) {
    size_t pos = path.find_last_of('/');
    if (pos == std::string::npos) return ".";
    return pos == 0 ? "/" : path.substr(0, pos);
}

std::string local_path(const std::string& input) {
    if (input.empty()) throw std::runtime_error("empty path");
    for (unsigned char c : input) {
        if (c < 32) throw std::runtime_error("control characters in path are forbidden");
    }
    if (input.rfind("//", 0) == 0 || input.rfind("\\\\", 0) == 0) {
        throw std::runtime_error("network/device paths are forbidden");
    }
    char resolved[PATH_MAX];
    require(::realpath(input.c_str(), resolved) != nullptr, "realpath input path");
    struct stat st{};
    require(::stat(resolved, &st) == 0, "stat input path");
    if (!S_ISREG(st.st_mode)) throw std::runtime_error("expected a regular local file");
    return resolved;
}

void verify_bootstrap_so(const std::string& path) {
    int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "open bootstrap shared object");
    Elf64_Ehdr ehdr{};
    ssize_t n = ::read(fd, &ehdr, sizeof(ehdr));
    ::close(fd);
    if (n != sizeof(ehdr) || std::memcmp(ehdr.e_ident, ELFMAG, SELFMAG) != 0 ||
        ehdr.e_ident[EI_CLASS] != ELFCLASS64 || ehdr.e_ident[EI_DATA] != ELFDATA2LSB ||
        ehdr.e_type != ET_DYN) {
        throw std::runtime_error("invalid Linux ELF64 bootstrap shared object");
    }
#if defined(__x86_64__)
    if (ehdr.e_machine != EM_X86_64) throw std::runtime_error("bootstrap shared object architecture mismatch (expected x86_64)");
#elif defined(__aarch64__)
    if (ehdr.e_machine != EM_AARCH64) throw std::runtime_error("bootstrap shared object architecture mismatch (expected aarch64)");
#endif
}

bool write_all(int fd, const char* data, size_t len) {
    while (len > 0) {
        ssize_t n = ::write(fd, data, len);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        data += n;
        len -= static_cast<size_t>(n);
    }
    return true;
}

bool read_small_file(const char* path, std::string& out) {
    int fd = ::open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return false;
    char buf[64]{};
    ssize_t n = ::read(fd, buf, sizeof(buf) - 1);
    ::close(fd);
    if (n <= 0) return false;
    out.assign(buf, static_cast<size_t>(n));
    return true;
}

bool in_container() {
    if (::access("/.dockerenv", F_OK) == 0 || ::access("/run/.containerenv", F_OK) == 0) return true;
    const char* env = std::getenv("container");
    return env && *env;
}

bool sandbox_restricted(const std::string& exe_dir) {
    const std::string helper = exe_dir + "/chrome-sandbox";
    struct stat st{};
    bool suid_ok = (::stat(helper.c_str(), &st) == 0) && S_ISREG(st.st_mode) && st.st_uid == 0 && (st.st_mode & 04755) == 04755;
    if (suid_ok) return false;
    std::string val;
    if (read_small_file("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", val) && !val.empty() && val[0] == '1') return true;
    if (read_small_file("/proc/sys/kernel/unprivileged_userns_clone", val) && !val.empty() && val[0] == '0') return true;
    return ::access(helper.c_str(), F_OK) == 0;
}

std::string exit_reason(int status) {
    if (WIFEXITED(status)) return "exit code " + std::to_string(WEXITSTATUS(status));
    if (WIFSIGNALED(status)) {
        int sig = WTERMSIG(status);
        const char* name = ::strsignal(sig);
        return "signal " + std::to_string(sig) + (name ? std::string(" ") + name : "");
    }
    return "terminated";
}

std::string extract_json_string(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\":\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos += needle.size();
    std::string out;
    for (; pos < json.size(); ++pos) {
        char c = json[pos];
        if (c == '\\' && pos + 1 < json.size()) {
            char next = json[++pos];
            if (next == 'n') out += '\n';
            else if (next == 'r') out += '\r';
            else out += next;
        } else if (c == '"') {
            return out;
        } else {
            out += c;
        }
    }
    return out;
}

void run_launcher(const std::string& executable, const std::string& wrapper_path, const std::string& so_path,
                  std::string source) {
    std::string qq = local_path(executable);
    require(::access(qq.c_str(), X_OK) == 0, "executable is not runnable");
    std::string wrapper = local_path(wrapper_path);
    std::string so = local_path(so_path);
    verify_bootstrap_so(so);

    int cfg_pipe[2]{-1, -1};
    int status_pipe[2]{-1, -1};
    require(::pipe(cfg_pipe) == 0, "pipe config");
    if (::pipe(status_pipe) != 0) {
        ::close(cfg_pipe[0]);
        ::close(cfg_pipe[1]);
        require(false, "pipe status");
    }
    ::fcntl(cfg_pipe[1], F_SETFD, FD_CLOEXEC);
    ::fcntl(status_pipe[0], F_SETFD, FD_CLOEXEC);
    int status_flags = ::fcntl(status_pipe[0], F_GETFL, 0);
    if (status_flags >= 0) ::fcntl(status_pipe[0], F_SETFL, status_flags | O_NONBLOCK);

    const std::string exe_dir = dirname_of(qq);
    const bool is_qq_bin = basename_of(qq) == "qq";
    const char* env_no_sandbox = std::getenv("OPENQQ_QQ_NO_SANDBOX");
    const char* env_disable_gpu = std::getenv("OPENQQ_QQ_DISABLE_GPU");
    const bool add_no_sandbox = (env_no_sandbox && std::strcmp(env_no_sandbox, "1") == 0) ||
        (is_qq_bin && (::geteuid() == 0 || in_container() || sandbox_restricted(exe_dir)));
    const bool add_container_flags = is_qq_bin &&
        ((env_disable_gpu && std::strcmp(env_disable_gpu, "1") == 0) ||
         (in_container() && (!env_disable_gpu || std::strcmp(env_disable_gpu, "0") != 0)));

    pid_t child = ::fork();
    if (child < 0) {
        ::close(cfg_pipe[0]); ::close(cfg_pipe[1]);
        ::close(status_pipe[0]); ::close(status_pipe[1]);
        require(false, "fork");
    }

    if (child == 0) {
        ::close(cfg_pipe[1]);
        ::close(status_pipe[0]);

        int dev_null = ::open("/dev/null", O_RDONLY);
        if (dev_null >= 0) {
            ::dup2(dev_null, STDIN_FILENO);
            if (dev_null > STDERR_FILENO) ::close(dev_null);
        }

        const char* existing_preload = std::getenv("LD_PRELOAD");
        std::string preload = (existing_preload && *existing_preload) ? (so + ":" + existing_preload) : so;
        ::setenv("LD_PRELOAD", preload.c_str(), 1);
        ::setenv("OPENQQ_BOOTSTRAP_FD", std::to_string(cfg_pipe[0]).c_str(), 1);
        ::setenv("OPENQQ_STATUS_FD", std::to_string(status_pipe[1]).c_str(), 1);

        if (::chdir(exe_dir.c_str()) != 0) _exit(126);

        std::vector<std::string> arg_storage;
        arg_storage.push_back(qq);
        if (add_no_sandbox) arg_storage.push_back("--no-sandbox");
        if (add_container_flags) {
            arg_storage.push_back("--disable-gpu");
            arg_storage.push_back("--disable-dev-shm-usage");
        }
        std::vector<char*> argv;
        argv.reserve(arg_storage.size() + 1);
        for (auto& item : arg_storage) argv.push_back(item.data());
        argv.push_back(nullptr);

        ::execv(qq.c_str(), argv.data());
        _exit(127);
    }

    ::close(cfg_pipe[0]);
    ::close(status_pipe[1]);

    const std::string payload = wrapper + '\n' + source + '\n';
    bool wrote = write_all(cfg_pipe[1], payload.data(), payload.size());
    ::close(cfg_pipe[1]);
    if (!wrote) {
        ::close(status_pipe[0]);
        throw std::runtime_error("failed to send bootstrap config to child");
    }

    std::string stage = "starting QQ";
    std::string buffer;
    bool status_eof = false;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);

    auto handle_line = [&](const std::string& msg) {
        if (msg.empty()) return false;
        if (msg.find("\"stage\":\"runtime_found\"") != std::string::npos) {
            stage = "waiting for wrapper.node registration";
            log_native(msg);
        } else if (msg.find("\"stage\":\"addon_register\"") != std::string::npos) {
            if (msg.find("\"target\":true") != std::string::npos) stage = "waiting for the wrapper initializer";
            log_native(msg);
        } else if (msg.find("\"stage\":\"running_script\"") != std::string::npos) {
            stage = "running the bootstrap script";
        } else if (msg.find("\"stage\":\"bootstrapped\"") != std::string::npos) {
            log_native(msg);
            return true;
        } else if (msg.find("\"stage\":\"error\"") != std::string::npos) {
            std::string err = extract_json_string(msg, "error");
            throw std::runtime_error(err.empty() ? "bootstrap failed" : err);
        }
        return false;
    };

    auto drain_status = [&]() {
        char chunk[4096];
        for (;;) {
            ssize_t n = ::read(status_pipe[0], chunk, sizeof(chunk));
            if (n > 0) {
                buffer.append(chunk, static_cast<size_t>(n));
                continue;
            }
            if (n == 0) {
                status_eof = true;
                break;
            }
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            status_eof = true;
            break;
        }
        for (size_t pos = 0; (pos = buffer.find('\n')) != std::string::npos;) {
            std::string one = buffer.substr(0, pos);
            buffer.erase(0, pos + 1);
            if (handle_line(one)) {
                ::close(status_pipe[0]);
                return true;
            }
        }
        return false;
    };

    try {
        while (std::chrono::steady_clock::now() < deadline) {
            int wstatus = 0;
            pid_t done = ::waitpid(child, &wstatus, WNOHANG);
            if (done == child) {
                if (drain_status()) return;
                throw std::runtime_error("QQ exited before bootstrap completed (" + exit_reason(wstatus) + "; stage: " + stage + ")");
            }

            struct pollfd fds[2]{};
            nfds_t nfds = 0;
            int status_idx = -1;
            if (!status_eof) {
                status_idx = static_cast<int>(nfds);
                fds[nfds].fd = status_pipe[0];
                fds[nfds].events = POLLIN;
                nfds++;
            }
            int stdin_idx = static_cast<int>(nfds);
            fds[nfds].fd = STDIN_FILENO;
            fds[nfds].events = POLLIN;
            nfds++;

            int rc = ::poll(fds, nfds, 25);
            if (rc < 0 && errno != EINTR) require(false, "poll");
            if (rc > 0 && status_idx >= 0 && (fds[status_idx].revents & (POLLIN | POLLHUP))) {
                if (drain_status()) return;
            }
            if (rc > 0 && (fds[stdin_idx].revents & (POLLIN | POLLHUP | POLLERR))) {
                throw std::runtime_error("bootstrap cancelled (stage: " + stage + ")");
            }
        }
        throw std::runtime_error("bootstrap timed out after 30 seconds (stage: " + stage + ")");
    } catch (...) {
        ::close(status_pipe[0]);
        throw;
    }
}

}  // namespace

int main() {
    ::signal(SIGPIPE, SIG_IGN);
    try {
        auto executable = line_from_stdin(32768);
        auto wrapper = line_from_stdin(32768);
        auto so = line_from_stdin(32768);
        auto source = line_from_stdin(1048576);
        run_launcher(executable, wrapper, so, std::move(source));
        return 0;
    } catch (const std::exception& error) {
        log_native("{\"stage\":\"error\",\"error\":" + json_quote(error.what()) + "}");
        return 1;
    }
}
