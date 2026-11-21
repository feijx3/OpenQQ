// 离线自检：把 bootstrap.cpp 里那套 std::string 布局实现**原样**跑一遍。
//
// 为什么要单独一个 target：
//   2026-11-21 的 28 次崩溃里 21 次是「字符串布局/构造用错」，而这类错误
//   完全可以在本地判定 —— 只要把「QQ 读回字符串的规则」当成规格写进断言。
//   这个程序不加载 wrapper.node、不碰 QQ、不需要注入，`ctest` 里跑。
//
// 判定方式：
//   写入侧 = 与 bootstrap.cpp 的 ssoStdStringFromBytes 逐字相同的逻辑
//   读回侧 = 从 wrapper.node 0xC59221 / 0xC5924A 反汇编得来的规则
//   两者对得上 → 说明「我们写出去的 24 字节，QQ 会解析成我们想要的 (指针, 长度)」。
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

// ── 写入侧（与 bootstrap.cpp 的 ssoStdStringFromBytes 逻辑一致）──────────────
// 只把「分配器」换成 std::malloc，其余分支/位运算/偏移必须一模一样。
bool WriteString(unsigned char* dst24, const unsigned char* data, size_t len) {
    if (!dst24) return false;
    for (int i = 0; i < 24; ++i) dst24[i] = 0;
    if (len == 0) return true;

    if (len <= 22) {
        dst24[0] = static_cast<unsigned char>(len << 1);   // 短串标记：最低位 0
        for (size_t i = 0; i < len; ++i) dst24[1 + i] = data[i];
        dst24[1 + len] = 0;
        return true;
    }

    const size_t cap = (len | 0xf);
    auto* heap = static_cast<unsigned char*>(std::malloc(cap + 1));
    if (!heap) return false;
    for (size_t i = 0; i < len; ++i) heap[i] = data[i];
    heap[len] = 0;
    std::memcpy(dst24 + 0x00, &(*(size_t*)&cap), 0);       // 占位，下面用 write 形式
    size_t field0 = cap | 1;                               // 最低位 1 = 长串
    std::memcpy(dst24 + 0x00, &field0, sizeof(field0));
    std::memcpy(dst24 + 0x08, &len, sizeof(len));
    size_t ptr = reinterpret_cast<size_t>(heap);
    std::memcpy(dst24 + 0x10, &ptr, sizeof(ptr));
    return true;
}

// ── 读回侧（严格按 wrapper.node 0xC59221 的规则）────────────────────────────
//   movzbl (%rsi),%r9d ; testb $1,%r9b ; jne 长串
//   短串: size = 首字节 >> 1 ; 数据 = this+1
//   长串: size = *(u64*)(this+8) ; 数据 = *(u64*)(this+16)
bool ReadString(const unsigned char* src24, const unsigned char** outData, size_t* outLen) {
    if (!src24 || !outData || !outLen) return false;
    if (src24[0] & 1) {
        size_t len = 0; size_t ptr = 0;
        std::memcpy(&len, src24 + 0x08, sizeof(len));
        std::memcpy(&ptr, src24 + 0x10, sizeof(ptr));
        if (!ptr) return false;
        *outLen = len;
        *outData = reinterpret_cast<const unsigned char*>(ptr);
        return true;
    }
    *outLen = static_cast<size_t>(src24[0] >> 1);
    *outData = src24 + 1;
    return true;
}

int g_fail = 0;

void Check(bool cond, const char* what) {
    if (!cond) { std::printf("  FAIL  %s\n", what); ++g_fail; }
}

// ── 指针链验证 ───────────────────────────────────────────────────────────────
// 这是 2026-11-21 第二个 bug 的离线判据。
// NAPI 绑定的真实序列（wrapper.node 0x1031035 / 0x1031051 / 0x1031060）：
//   rcx = *impl                       ← this
//   rax = *(void**)rcx                ← vtable
//   call *(void**)((char*)vtable + 0x780)
// 错误写法（我原来那版）：vtable = *(void***)impl，再取 ((unsigned char*)vtable)[0x780]
//   —— 拿到的是「this 的第 0x780 个**字节**」，不是函数指针槽，必崩。
struct FakeVtable {
    unsigned char bytes[0x800];
};

struct CallRecord {
    void* self;
    void* cmd;
    void* body;
    void* out;
    int hits;
} g_rec{};

void StubTarget(void* self, void* cmd, void* body, void* out) {
    g_rec.self = self; g_rec.cmd = cmd; g_rec.body = body; g_rec.out = out;
    ++g_rec.hits;
}

// 正确实现：按反汇编的三层关系取函数指针
using ContendFn = void (*)(void*, void*, void*, void*);
ContendFn ResolveCorrect(void* impl) {
    if (!impl) return nullptr;
    void* self = *reinterpret_cast<void**>(impl);
    if (!self) return nullptr;
    auto* vtable = *reinterpret_cast<unsigned char**>(self);
    if (!vtable) return nullptr;
    return *reinterpret_cast<ContendFn*>(vtable + 0x780);
}

// 错误实现：复刻我之前那版（用于证明它取到的是垃圾）
ContendFn ResolveWrong(void* impl) {
    if (!impl) return nullptr;
    auto* vtbl = *reinterpret_cast<unsigned char**>(impl);   // = self，不是 vtable
    if (!vtbl) return nullptr;
    return reinterpret_cast<ContendFn>(vtbl[0x780]);         // 取「第 0x780 个字节」
}

// 往返：写进去的字节，按读回规则必须一字不差地拿回来
void RoundTrip(const std::vector<unsigned char>& data, const char* label) {
    unsigned char buf[24];
    Check(WriteString(buf, data.data(), data.size()), "WriteString 返回 false");
    const unsigned char* got = nullptr; size_t gotLen = 0;
    Check(ReadString(buf, &got, &gotLen), "ReadString 返回 false");
    Check(gotLen == data.size(), "长度不一致");
    if (gotLen == data.size() && got) {
        Check(std::memcmp(got, data.data(), data.size()) == 0, "内容不一致");
    }
    std::printf("  ok    %-28s len=%zu %s\n", label, data.size(),
                data.size() <= 22 ? "(短串)" : "(长串)");
}

}  // namespace

int main() {
    std::printf("=== 短串边界 1..22 ===\n");
    for (size_t n = 1; n <= 22; ++n) {
        std::vector<unsigned char> v(n);
        for (size_t i = 0; i < n; ++i) v[i] = static_cast<unsigned char>((i * 37 + 11) & 0xff);
        RoundTrip(v, "fixed");
    }

    std::printf("\n=== 长串边界 23..200 ===\n");
    for (size_t n : {23u, 24u, 31u, 63u, 64u, 100u, 200u}) {
        std::vector<unsigned char> v(n);
        for (size_t i = 0; i < n; ++i) v[i] = static_cast<unsigned char>((i * 91 + 7) & 0xff);
        RoundTrip(v, "fixed");
    }

    std::printf("\n=== 空串 ===\n");
    {
        unsigned char buf[24];
        std::vector<unsigned char> empty;
        WriteString(buf, empty.data(), 0);
        const unsigned char* got = nullptr; size_t gotLen = 99;
        Check(ReadString(buf, &got, &gotLen), "空串读回失败");
        Check(gotLen == 0, "空串长度应为 0");
        std::printf("  ok    空串 len=0\n");
    }

    std::printf("\n=== 真实 cmd 名 ===\n");
    for (const char* cmd : {"OidbSvc.0x102a_0", "OidbSvc.0xed3_1", "OidbSvc.0xf90_1",
                            "OidbSvc.0x6d8_3", "OidbSvcTrpcTcp.0x102a_0"}) {
        std::vector<unsigned char> v(cmd, cmd + std::strlen(cmd));
        RoundTrip(v, cmd);
    }

    std::printf("\n=== 真实 OIDB body（都含 >0x7F 字节，这是整个问题的起因）===\n");
    {
        const char* getPskey = "08aa2010001800220e0a0c717a6f6e652e71712e636f6d";
        const char* poke = "08d31d10011800221008d88ce68a0b10ceaf8b8f0228003000";
        for (const char* hex : {getPskey, poke}) {
            std::vector<unsigned char> v;
            for (size_t i = 0; i + 1 < std::strlen(hex); i += 2) {
                unsigned int b = 0;
                std::sscanf(hex + i, "%2x", &b);
                v.push_back(static_cast<unsigned char>(b));
            }
            bool hasHigh = false;
            for (auto b : v) if (b > 0x7f) hasHigh = true;
            std::printf("  ---- high=%s\n", hasHigh ? "Y" : "N");
            RoundTrip(v, "oidb");
        }
    }

    std::printf("\n=== 指针链：impl → this → vtable → slot+0x780 ===\n");
    {
        // 按 wrapper.node 的三层关系搭一个假对象：
        //   impl 的第 0 个 qword = this
        //   this 的第 0 个 qword = vtable
        //   vtable + 0x780 处放目标函数指针
        auto* vtable = new FakeVtable{};
        auto* self = new void*[4]{};
        auto* impl = new void*[4]{};

        std::memset(vtable->bytes, 0xcc, sizeof(vtable->bytes));   // 整片填 0xcc，模拟未初始化
        auto** slot = reinterpret_cast<ContendFn*>(vtable->bytes + 0x780);
        *slot = &StubTarget;

        self[0] = vtable;
        impl[0] = self;

        auto fn = ResolveCorrect(impl);
        Check(fn == &StubTarget, "正确解引用应拿到 StubTarget");
        std::printf("  正确实现 → %s\n", fn == &StubTarget ? "StubTarget ✓" : "错");

        if (fn == &StubTarget) {
            unsigned char cmdBuf[24] = {0};
            unsigned char bodyBuf[24] = {0};
            unsigned char outBuf[0x20] = {0};
            std::vector<unsigned char> cmdBytes{'O','i','d','b','S','v','c'};
            std::vector<unsigned char> bodyBytes{0x08, 0xaa, 0x20};
            WriteString(cmdBuf, cmdBytes.data(), cmdBytes.size());
            WriteString(bodyBuf, bodyBytes.data(), bodyBytes.size());
            fn(self, cmdBuf, bodyBuf, outBuf);
            Check(g_rec.hits == 1, "目标函数应被调用 1 次");
            Check(g_rec.self == self, "this 必须是 self（不是 impl）");
            Check(g_rec.cmd == cmdBuf, "第 2 参应是 cmd 串");
            Check(g_rec.body == bodyBuf, "第 3 参应是 body 串");
            Check(g_rec.out == outBuf, "第 4 参应是 out");
            std::printf("  调用记录 → this=%s cmd/body/out 位置全对\n",
                        g_rec.self == self ? "self ✓" : "错");
        }

        auto wrong = ResolveWrong(impl);
        // 错误实现会把这个字节 0xcc 强转成函数指针（0xcc..），与 StubTarget 不同
        Check(wrong != &StubTarget, "错误解引用不应拿到 StubTarget");
        std::printf("  错误实现 → 取到 0x%llx（不是 StubTarget）✓ 与线上崩溃一致\n",
                    static_cast<unsigned long long>(reinterpret_cast<size_t>(wrong)));

        delete[] impl; delete[] self; delete vtable;
    }

    std::printf("\n=== 反例：旧布局（size 放 +0x10）必须读不回来 ===\n");
    {
        // 旧实现把 size 写进 +0x10（MSVC 布局），但 QQ 按 libc++ 规则读。
        unsigned char wrong[24] = {0};
        const unsigned char data[5] = {0x08, 0xaa, 0x20, 0x10, 0x00};
        std::memcpy(wrong, data, 5);
        size_t five = 5;
        std::memcpy(wrong + 0x10, &five, sizeof(five));
        const unsigned char* got = nullptr; size_t gotLen = 0;
        ReadString(wrong, &got, &gotLen);
        std::printf("  旧布局写入 5 字节 → 读回 size=%zu（应为 5）\n", gotLen);
        Check(gotLen != 5, "旧布局必须读不回，否则说明读回规则也写错了");
        std::printf("  ✓ 旧布局确实读不回 —— 与「body 被解析成 529730」的线上现象一致\n");
    }

    if (g_fail) {
        std::printf("\n结论：%d 项失败\n", g_fail);
        return 1;
    }
    std::printf("\n结论：全部通过 —— 布局实现与 QQ 的读回规则一致。\n");
    return 0;
}
