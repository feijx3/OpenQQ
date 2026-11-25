// Exercises the independent bridge without loading QQ or any third-party addon.
#include "../native/packet.cpp"
#include <iostream>
#include <cstdlib>
namespace {
void requireTest(bool value, const char *message) {
    if (!value)
        throw std::runtime_error(message);
}
std::vector<unsigned char> inputBytes, stringStorage, copied;
std::string placeholderText;
int normalCalls = 0, bufferCalls = 0;
void *const bufferValue = reinterpret_cast<void *>(0x1000);
void *const textValue = reinterpret_cast<void *>(0x2000);
int mockIsBuffer(Env, Value value, bool *result) {
    *result = value == bufferValue;
    return 0;
}
int mockGetBuffer(Env, Value, void **data, size_t *size) {
    *data = inputBytes.data();
    *size = inputBytes.size();
    return 0;
}
int mockString(Env, const char *text, size_t size, Value *result) {
    if (size == SIZE_MAX)
        size = std::strlen(text); // napi_auto_length
    placeholderText.assign(text, size);
    *result = textValue;
    ++normalCalls;
    return 0;
}
int mockBuffer(Env, size_t size, const void *data, void **, Value *result) {
    auto bytes = static_cast<const unsigned char *>(data);
    copied.assign(bytes, bytes + size);
    *result = bufferValue;
    ++bufferCalls;
    return 0;
}
void *mockConvert(void *out, Env, Value value) {
    if (value != textValue)
        return bufferValue;
    auto storage = static_cast<unsigned char *>(out);
    std::memset(storage, 0, 24);
    const auto size = placeholderText.size();
    if (size <= 22) {
        storage[0] = static_cast<unsigned char>(size * 2);
        std::memcpy(storage + 1, placeholderText.data(), size);
    } else {
        stringStorage.assign(placeholderText.begin(), placeholderText.end());
        stringStorage.push_back(0);
        storage[0] = 1;
        auto data = stringStorage.data();
        std::memcpy(storage + 8, &size, 8);
        std::memcpy(storage + 16, &data, 8);
    }
    return out;
}
int mockPromise(Env, void **deferred, Value *value) {
    *deferred = reinterpret_cast<void *>(0x3000);
    *value = textValue;
    return 0;
}
bool expectedRaw = false;
void mockReceive(void *object) {
    requireTest(isRawResponse == expectedRaw, "response scope changed unrelated request");
    auto context = *reinterpret_cast<unsigned char **>(static_cast<unsigned char *>(object) + 16);
    *reinterpret_cast<void **>(context + 32) = nullptr;
}
int replacement() {
    return 99;
}
void conversionTests() {
    api.isBuffer = mockIsBuffer;
    api.getBuffer = mockGetBuffer;
    api.createBuffer = mockBuffer;
    originalCreateString = mockString;
    originalStringConverter = mockConvert;
    std::array<unsigned char, 24> output{};
    for (size_t size : {size_t(0), size_t(1), size_t(22), size_t(23), size_t(256), size_t(4096)}) {
        inputBytes.resize(size);
        for (size_t i = 0; i < size; ++i)
            inputBytes[i] = static_cast<unsigned char>(i);
        ScopedFlag scope(isRawRequest, true);
        requireTest(convertPacketArgument(output.data(), nullptr, bufferValue) == output.data(),
                    "raw conversion result");
        const auto data = size <= 22 ? output.data() + 1 : stringStorage.data();
        requireTest(!size || !std::memcmp(data, inputBytes.data(), size), "binary bytes changed");
    }
    requireTest(convertPacketArgument(output.data(), nullptr, bufferValue) == bufferValue,
                "ordinary request conversion changed");
    isRawResponse = true;
    copied.clear();
    const unsigned char binary[] = {0, 0xff, 0xc0, 0x80, 1};
    Value result = nullptr;
    requireTest(!createResponseValue(nullptr, reinterpret_cast<const char *>(binary), sizeof(binary), &result,
                                     responseStringReturnAddress()),
                "create buffer status");
    requireTest(bufferCalls == 1 && copied == std::vector<unsigned char>(binary, binary + sizeof(binary)),
                "response binary not preserved");
    isRawResponse = false;
    createResponseValue(nullptr, "text", 4, &result, responseStringReturnAddress());
    requireTest(bufferCalls == 1 && placeholderText == "text", "ordinary response changed");
    isRawResponse = true;
    createResponseValue(nullptr, "other", 5, &result, responseStringReturnAddress() + 1);
    requireTest(bufferCalls == 1 && placeholderText == "other", "unrelated string call changed");
    isRawResponse = false;
}
void correlationTests() {
    originalCreatePromise = mockPromise;
    originalResponseCallback = mockReceive;
    void *deferred = nullptr;
    Value promise = nullptr;
    trackCreatedPromise(nullptr, &deferred, &promise);
    requireTest(pendingDeferreds.empty(), "ordinary promise was tracked");
    {
        ScopedFlag scope(isRawRequest, true);
        trackCreatedPromise(nullptr, &deferred, &promise);
    }
    requireTest(pendingDeferreds.count(deferred) == 1, "raw promise not tracked");
    alignas(void *) unsigned char context[64]{}, object[32]{};
    *reinterpret_cast<void **>(context + 32) = deferred;
    *reinterpret_cast<void **>(object + 16) = context;
    expectedRaw = true;
    completePacketResponse(object);
    requireTest(pendingDeferreds.empty() && !isRawResponse, "request not cleaned up");
    *reinterpret_cast<void **>(context + 32) = reinterpret_cast<void *>(0x4000);
    expectedRaw = false;
    completePacketResponse(object);
}
void detourTests() {
    auto code =
        static_cast<unsigned char *>(VirtualAlloc(nullptr, 128, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
    requireTest(code != nullptr, "allocate test function");
    std::memcpy(code, k52230StringConverterPrologue, sizeof(k52230StringConverterPrologue));
    const unsigned char tail[] = {0xb8, 42,   0,    0,    0,    0x48, 0x83, 0xc4,
                                  0x60, 0x5b, 0x5f, 0x5e, 0x41, 0x5e, 0x5d, 0xc3};
    std::memcpy(code + sizeof(k52230StringConverterPrologue), tail, sizeof(tail));
    DWORD old;
    requireTest(VirtualProtect(code, 128, PAGE_EXECUTE_READ, &old) != 0, "protect test function");
    auto function = reinterpret_cast<int (*)()>(code);
    requireTest(function() == 42, "test function failed");
    EntryDetour patch(reinterpret_cast<uintptr_t>(code), k52230StringConverterPrologue,
                      sizeof(k52230StringConverterPrologue), reinterpret_cast<void *>(replacement));
    requireTest(reinterpret_cast<int (*)()>(patch.trampoline)() == 42, "trampoline failed");
    requireTest(writeEntryDetour(patch, false), "patch failed");
    requireTest(function() == 99, "hook not executed");
    requireTest(writeEntryDetour(patch, true) && function() == 42, "restore failed");
    unsigned char wrong[sizeof(k52230StringConverterPrologue)]{};
    bool refused = false;
    try {
        EntryDetour invalid(reinterpret_cast<uintptr_t>(code), wrong, sizeof(wrong),
                            reinterpret_cast<void *>(replacement));
    } catch (...) {
        refused = true;
    }
    requireTest(refused, "signature mismatch accepted");
    VirtualFree(patch.trampoline, 0, MEM_RELEASE);
    VirtualFree(code, 0, MEM_RELEASE);
}
} // namespace
int main() {
    try {
        activeProfile = findPacketProfile("9.9.33-52230");
        requireTest(activeProfile && !findPacketProfile("9.9.37-54395"), "exact profile lookup failed");
        conversionTests();
        correlationTests();
        detourTests();
        std::cout << "Independent packet bridge: binary conversion, correlation and detour tests passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
