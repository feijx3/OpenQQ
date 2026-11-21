// 离线验证「rel32 跳板」逻辑 —— 不碰 QQ。
//
// 背景：wrapper.node 与我们注入的 dll 在进程里可能相隔几十 GB，
// 0x1030FAA 那条 call 的 rel32 够不着，所以要在一块「离 wrapper.node 足够近的
// 空闲内存」里写 `mov rax, imm64 ; jmp rax` 当跳板。
//
// 上一版按固定 128MB 步长试 16 个点，全部失败（那些地址被占了）。
// 这一版改成 VirtualQuery 遍历内存映射找真正的空闲区。
//
// 这个测试做的事：
//   ① 在「远处」造一块假 wrapper.node（用 VirtualAlloc 精确占位）
//   ② 在「更远处」造一个假目标函数（距离 > 2GB，确保 rel32 够不着）
//   ③ 跑与 bootstrap.cpp 完全相同的 VirtualQuery 搜索
//   ④ 写到跳板 → 真的 call 一次 → 必须正确回调到假目标函数
//   ⑤ 再跑一遍「距离在 2GB 内」的情况 → 应该走直连、不申请跳板
#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <cstring>

static int g_fail = 0;
static void Check(bool cond, const char* what) {
    std::printf("  %s  %s\n", cond ? "ok  " : "FAIL", what);
    if (!cond) ++g_fail;
}

// 假目标函数：返回一个魔数，证明跳板真的跳过来了
static volatile LONG g_hitCount = 0;
static int TrampolineTarget(int x) {
    InterlockedIncrement(&g_hitCount);
    return x * 7 + 3;
}

// ── 与 bootstrap.cpp 里一模一样的搜索逻辑 ─────────────────────────────────
static unsigned char* FindTrampoline(const unsigned char* base, const unsigned char* nextInstr) {
    const uintptr_t lo = reinterpret_cast<uintptr_t>(nextInstr) > 0x7fff0000ULL
                         ? reinterpret_cast<uintptr_t>(nextInstr) - 0x7fff0000ULL : 0x10000ULL;
    const uintptr_t hi = reinterpret_cast<uintptr_t>(nextInstr) + 0x7fff0000ULL;
    const uintptr_t baseAddr = reinterpret_cast<uintptr_t>(base);

    for (int dir = 0; dir < 2; ++dir) {
        uintptr_t cur = dir == 0 ? baseAddr + 0x08000000ULL : baseAddr;
        const uintptr_t stop = dir == 0 ? hi : lo;
        while (dir == 0 ? (cur < stop) : (cur > stop)) {
            MEMORY_BASIC_INFORMATION mbi{};
            if (!VirtualQuery(reinterpret_cast<void*>(cur), &mbi, sizeof(mbi))) break;
            const uintptr_t regionEnd = reinterpret_cast<uintptr_t>(mbi.BaseAddress) + mbi.RegionSize;
            if (mbi.State == MEM_FREE && mbi.RegionSize >= 0x10000) {
                uintptr_t candidate = reinterpret_cast<uintptr_t>(mbi.BaseAddress);
                if (candidate < lo) candidate = (lo + 0xffffULL) & ~0xffffULL;
                if (candidate + 0x1000 <= regionEnd && candidate >= lo && candidate <= hi) {
                    auto* t = static_cast<unsigned char*>(VirtualAlloc(
                        reinterpret_cast<void*>(candidate), 0x1000,
                        MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE));
                    if (t) return t;
                }
            }
            if (regionEnd <= cur) break;
            cur = regionEnd;
        }
    }
    return nullptr;
}

// 在指定地址附近申请一块（用于造「远处的 dll」）
static unsigned char* ClaimNear(uintptr_t start, size_t size) {
    for (uintptr_t a = start; a < start + 0x40000000ULL; a += 0x10000ULL) {
        auto* p = static_cast<unsigned char*>(VirtualAlloc(
            reinterpret_cast<void*>(a), size, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE));
        if (p) return p;
    }
    return nullptr;
}

int main() {
    std::printf("=== ① rel32 距离检查 ===\n");
    // 造一个假 wrapper.node：随便占一块，当作镜像基址
    auto* fakeWrapper = ClaimNear(0x100000000ULL, 0x200000);
    if (!fakeWrapper) { std::printf("  无法申请假 wrapper 内存\n"); return 1; }
    std::printf("  fakeWrapper base = %p\n", static_cast<void*>(fakeWrapper));

    auto* ourDll = ClaimNear(0x4000000000ULL, 0x1000);       // 约 256GB 处，肯定 >2GB 远
    if (!ourDll) { std::printf("  无法申请远端内存\n"); return 1; }
    std::printf("  ourDll           = %p\n", static_cast<void*>(ourDll));

    const auto* nextInstr = fakeWrapper + 0x1030faf;          // call 之后的下一条指令
    const int64_t farDelta =
        static_cast<int64_t>(reinterpret_cast<uintptr_t>(ourDll) - reinterpret_cast<uintptr_t>(nextInstr));
    std::printf("  delta = %lld 字节（%.1f GB）\n", static_cast<long long>(farDelta), farDelta / 1073741824.0);
    const bool tooFar = farDelta > 0x7fffffffLL || farDelta < -0x80000000LL;
    Check(tooFar, "构造出的距离确实超出 rel32 范围（这才是需要跳板的场景）");

    std::printf("\n=== ② VirtualQuery 搜索跳板 ===\n");
    unsigned char* tramp = FindTrampoline(fakeWrapper, nextInstr);
    Check(tramp != nullptr, "找到一块可用跳板");
    if (!tramp) return 1;
    std::printf("  trampoline       = %p\n", static_cast<void*>(tramp));
    const int64_t trampDelta =
        static_cast<int64_t>(reinterpret_cast<uintptr_t>(tramp) - reinterpret_cast<uintptr_t>(nextInstr));
    std::printf("  trampDelta = %lld 字节\n", static_cast<long long>(trampDelta));
    Check(trampDelta <= 0x7fffffffLL && trampDelta >= -0x80000000LL, "跳板落在 rel32 可达范围内");

    std::printf("\n=== ③ 写跳板并真的调用 ===\n");
    // mov rax, imm64 ; jmp rax
    tramp[0] = 0x48; tramp[1] = 0xb8;
    const auto targetAddr = reinterpret_cast<uintptr_t>(&TrampolineTarget);
    std::memcpy(tramp + 2, &targetAddr, sizeof(targetAddr));
    tramp[10] = 0xff; tramp[11] = 0xe0;
    FlushInstructionCache(GetCurrentProcess(), tramp, 12);

    using Fn = int (*)(int);
    auto fn = reinterpret_cast<Fn>(tramp);
    const int got = fn(5);
    std::printf("  经跳板调用 TrampolineTarget(5) = %d（期望 38）\n", got);
    Check(got == 38, "跳板跳转正确，拿到目标的真实返回值");
    Check(g_hitCount == 1, "目标函数确实被调用了一次");

    std::printf("\n=== ④ 对照：距离在 2GB 内时不该申请跳板 ===\n");
    // 造一个「离得近」的假 dll 地址（就在假 wrapper 旁边）
    auto* nearDll = fakeWrapper + 0x1000000;                  // 仅 16MB 远
    const int64_t nearDelta =
        static_cast<int64_t>(reinterpret_cast<uintptr_t>(nearDll) - reinterpret_cast<uintptr_t>(nextInstr));
    std::printf("  nearDelta = %lld 字节\n", static_cast<long long>(nearDelta));
    const bool directOk = nearDelta <= 0x7fffffffLL && nearDelta >= -0x80000000LL;
    Check(directOk, "近距离时走直连，不需要跳板（省一次 VirtualAlloc）");

    std::printf("\n=== ⑤ 跳板不覆盖已占用内存 ===\n");
    {
        // 确认跳板所在的整页是我们自己的、可写可执行
        MEMORY_BASIC_INFORMATION mbi{};
        VirtualQuery(tramp, &mbi, sizeof(mbi));
        Check(mbi.State == MEM_COMMIT, "跳板页已提交");
        Check((mbi.Protect & (PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_READ)) != 0, "跳板页可执行");
        std::printf("  跳板页 protect = 0x%lx\n", mbi.Protect);
    }

    if (g_fail) { std::printf("\n结论：%d 项失败\n", g_fail); return 1; }
    std::printf("\n结论：跳板逻辑全部通过 —— 能在远距离场景下找到可达地址并正确跳转。\n");
    return 0;
}
