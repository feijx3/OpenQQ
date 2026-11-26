// The implementation is linked as a separate translation unit, not included.
#include "../native/packet-test.hpp"
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
const auto bridge = GetPacketBridgeTestAccess();
void requireTest(bool condition, const char *message) {
    if (!condition)
        throw std::runtime_error(message);
}
void *const bufferValue = reinterpret_cast<void *>(0x1000);
void *const textValue = reinterpret_cast<void *>(0x2000);
void *const promiseValue = reinterpret_cast<void *>(0x4000);
void *const serviceValue = reinterpret_cast<void *>(0x5000);
void *const methodValue = reinterpret_cast<void *>(0x6000);
std::vector<unsigned char> inputBytes, stringStorage, copied;
std::string placeholderText, argumentText, jsError;
uint64_t nowMs = 0;
uintptr_t nextDeferred = 0x3000;
void *lastDeferred = nullptr;
size_t bufferCalls = 0;
int callStatus = 0;
bool throwFromCall = false, failHandle = false, expectedRawResponse = false;
enum class ResponseMode { Normal, FreePages, FreePagesAndThrow };
ResponseMode responseMode = ResponseMode::Normal;
struct CallbackArgs {
    std::vector<void *> values;
};
struct Handle {
    void *promise = nullptr;
    std::string id;
} lastHandle;

int mockGetArgs(void *, void *info, size_t *count, void **args, void **, void **) {
    const auto &values = static_cast<CallbackArgs *>(info)->values;
    *count = std::min(*count, values.size());
    std::copy_n(values.begin(), *count, args);
    return 0;
}
int mockGetString(void *, void *, char *out, size_t capacity, size_t *size) {
    if (!out) {
        *size = argumentText.size();
        return 0;
    }
    *size = std::min(argumentText.size(), capacity - 1);
    std::memcpy(out, argumentText.data(), *size);
    out[*size] = 0;
    return 0;
}
int mockIsBuffer(void *, void *value, bool *out) {
    *out = value == bufferValue;
    return 0;
}
int mockGetBuffer(void *, void *, void **out, size_t *size) {
    *out = inputBytes.data();
    *size = inputBytes.size();
    return 0;
}
int mockString(void *, const char *text, size_t size, void **out) {
    if (size == SIZE_MAX)
        size = std::strlen(text);
    placeholderText.assign(text, size);
    *out = textValue;
    return 0;
}
int mockBuffer(void *, size_t size, const void *data, void **, void **out) {
    auto bytes = static_cast<const unsigned char *>(data);
    copied.assign(bytes, bytes + size);
    *out = bufferValue;
    ++bufferCalls;
    return 0;
}
int mockCreateObject(void *, void **out) {
    if (failHandle)
        return 9;
    lastHandle = {};
    *out = &lastHandle;
    return 0;
}
int mockSet(void *, void *object, const char *key, void *value) {
    requireTest(object == &lastHandle, "wrong handle receiver");
    if (!std::strcmp(key, "promise"))
        lastHandle.promise = value;
    else if (!std::strcmp(key, "id"))
        lastHandle.id = placeholderText;
    return 0;
}
int mockGet(void *, void *object, const char *, void **out) {
    requireTest(object == serviceValue, "wrong service receiver");
    *out = methodValue;
    return 0;
}
int mockPromise(void *, void **deferred, void **promise) {
    *deferred = reinterpret_cast<void *>(nextDeferred);
    *promise = promiseValue;
    return 0;
}
int mockCall(void *env, void *receiver, void *method, size_t count, void *const *args, void **out) {
    requireTest(receiver == serviceValue && method == methodValue && count == 2 && args[1] == bufferValue,
                "native call arguments changed");
    requireTest(bridge.rawRequestId() != 0, "native send has no request scope");
    bridge.trackPromise(env, &lastDeferred, out);
    nextDeferred += 16;
    if (throwFromCall)
        throw std::runtime_error("synchronous native exception");
    if (callStatus == 10)
        jsError = "QQ pending JS exception";
    return callStatus;
}
int mockBoolean(void *, bool, void **out) {
    *out = textValue;
    return 0;
}
int mockThrow(void *, const char *, const char *message) {
    jsError = message;
    return 0;
}
void *mockConvert(void *out, void *, void *value) {
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
void mockResponse(void *object) {
    requireTest(bridge.rawResponse() == expectedRawResponse, "unrelated response scope changed");
    if (expectedRawResponse)
        requireTest(bridge.deferredCount() == 0, "deferred not claimed before callback");
    auto context = *reinterpret_cast<unsigned char **>(static_cast<unsigned char *>(object) + 16);
    if (responseMode != ResponseMode::Normal) {
        // The old implementation accessed this unmapped memory after return.
        VirtualFree(context, 0, MEM_RELEASE);
        VirtualFree(object, 0, MEM_RELEASE);
        if (responseMode == ResponseMode::FreePagesAndThrow)
            throw std::runtime_error("QQ callback unwound");
    }
}
uint64_t mockNow() {
    return nowMs;
}
void reset() {
    inputBytes = {0, 0xff, 0x80, 1};
    stringStorage.clear();
    copied.clear();
    placeholderText.clear();
    argumentText.clear();
    jsError.clear();
    nowMs = 0;
    nextDeferred = 0x3000;
    bufferCalls = 0;
    callStatus = 0;
    throwFromCall = failHandle = expectedRawResponse = false;
    responseMode = ResponseMode::Normal;
    bridge.configure({mockGetArgs, mockGetString, mockIsBuffer, mockGetBuffer, mockBuffer, mockCreateObject,
                      mockSet, mockGet, mockCall, mockBoolean, mockThrow, mockString, mockPromise,
                      mockConvert, mockResponse, mockNow});
}
std::string sendRequest() {
    CallbackArgs args{{serviceValue, textValue, bufferValue}};
    auto result = bridge.send(nullptr, &args);
    if (!result)
        return {};
    requireTest(lastHandle.promise == promiseValue && !lastHandle.id.empty(), "invalid send handle");
    return lastHandle.id;
}
void releaseHandle(const std::string &id) {
    argumentText = id;
    CallbackArgs args{{textValue}};
    requireTest(bridge.release(nullptr, &args) != nullptr, "release failed");
}
void conversionTests() {
    reset();
    requireTest(bridge.supportsVersion("9.9.33-52230") && !bridge.supportsVersion("9.9.37-54395"),
                "exact profile lookup failed");
    std::array<unsigned char, 24> output{};
    auto id = bridge.beginRequest();
    bridge.setRawRequest(id);
    for (size_t size : {size_t(0), size_t(1), size_t(22), size_t(23), size_t(256), size_t(4096)}) {
        inputBytes.resize(size);
        for (size_t index = 0; index < size; ++index)
            inputBytes[index] = static_cast<unsigned char>(index);
        requireTest(bridge.convert(output.data(), nullptr, bufferValue) == output.data(),
                    "conversion result");
        auto data = size <= 22 ? output.data() + 1 : stringStorage.data();
        requireTest(!size || !std::memcmp(data, inputBytes.data(), size), "binary bytes changed");
    }
    bridge.setRawRequest(0);
    bridge.releaseRequest(id);
    requireTest(bridge.convert(output.data(), nullptr, bufferValue) == bufferValue,
                "ordinary conversion changed");
    const unsigned char binary[] = {0, 0xff, 0xc0, 0x80, 1};
    void *result = nullptr;
    bridge.setRawResponse(true);
    bridge.createResponse(nullptr, reinterpret_cast<const char *>(binary), sizeof(binary), &result,
                          bridge.responseReturnAddress());
    requireTest(bufferCalls == 1 && copied == std::vector<unsigned char>(binary, binary + sizeof(binary)),
                "response bytes changed");
    bridge.setRawResponse(false);
    bridge.createResponse(nullptr, "text", 4, &result, bridge.responseReturnAddress());
    bridge.setRawResponse(true);
    bridge.createResponse(nullptr, "other", 5, &result, bridge.responseReturnAddress() + 1);
    requireTest(bufferCalls == 1 && placeholderText == "other", "unrelated string converted to Buffer");
    bridge.setRawResponse(false);
}
void callbackLifetimeTests() {
    for (auto mode : {ResponseMode::FreePages, ResponseMode::FreePagesAndThrow}) {
        reset();
        const auto id = sendRequest();
        auto context = static_cast<unsigned char *>(
            VirtualAlloc(nullptr, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
        auto object = static_cast<unsigned char *>(
            VirtualAlloc(nullptr, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
        requireTest(context && object, "allocate callback pages");
        *reinterpret_cast<void **>(context + 32) = lastDeferred;
        *reinterpret_cast<void **>(object + 16) = context;
        responseMode = mode;
        expectedRawResponse = true;
        bool threw = false;
        try {
            bridge.completeResponse(object);
        } catch (const std::runtime_error &) {
            threw = true;
        }
        requireTest(threw == (mode == ResponseMode::FreePagesAndThrow), "callback exception changed");
        requireTest(!bridge.rawResponse() && bridge.deferredCount() == 0, "response scope not cleaned");
        releaseHandle(id);
        requireTest(bridge.requestCount() == 0, "request survived callback release");
    }
    reset();
    const auto id = sendRequest();
    alignas(void *) unsigned char context[64]{}, object[32]{};
    *reinterpret_cast<void **>(context + 32) = lastDeferred;
    *reinterpret_cast<void **>(object + 16) = context;
    releaseHandle(id); // JS timeout/disposal before QQ's late completion.
    expectedRawResponse = false;
    bridge.completeResponse(object);
    requireTest(!bridge.rawResponse() && bridge.requestCount() == 0, "late callback became raw");
}
void failedSendTests() {
    reset();
    callStatus = 10;
    for (size_t index = 0; index < 300; ++index) {
        requireTest(sendRequest().empty(), "pending exception was hidden");
        requireTest(jsError == "QQ pending JS exception", "original JS exception replaced");
        requireTest(bridge.requestCount() == 0 && bridge.deferredCount() == 0,
                    "sync exception leaked tracking");
        requireTest(bridge.rawRequestId() == 0, "request scope not restored");
    }
    callStatus = 9;
    requireTest(sendRequest().empty() && bridge.requestCount() == 0 && bridge.deferredCount() == 0,
                "N-API failure leaked tracking");
    callStatus = 0;
    throwFromCall = true;
    requireTest(sendRequest().empty() && bridge.requestCount() == 0, "C++ exception leaked tracking");
    throwFromCall = false;
    failHandle = true;
    requireTest(sendRequest().empty() && bridge.requestCount() == 0 && bridge.deferredCount() == 0,
                "handle construction failure leaked tracking");
}
void abandonedRequestTests() {
    reset();
    for (size_t index = 0; index < 300; ++index) {
        auto id = sendRequest();
        requireTest(!id.empty(), "request limit became permanent");
        releaseHandle(id);
        releaseHandle(id); // finally cleanup is idempotent.
        requireTest(bridge.requestCount() == 0 && bridge.deferredCount() == 0, "no-callback request leaked");
    }
    reset();
    std::string oldId;
    for (size_t index = 0; index < bridge.maxRequests; ++index) {
        auto id = sendRequest();
        requireTest(!id.empty(), "queue filled before limit");
        if (index == 0)
            oldId = id;
    }
    requireTest(sendRequest().empty(), "request limit not enforced");
    nowMs += bridge.trackingLifetimeMs + 1;
    nextDeferred = 0x3000; // QQ may reuse a pointer after an abandoned request.
    const auto freshId = sendRequest();
    requireTest(!freshId.empty() && bridge.requestCount() == 1 && bridge.deferredCount() == 1,
                "expired queue did not recover");
    releaseHandle(oldId);
    requireTest(bridge.deferredCount() == 1, "old ID released a reused deferred");
    releaseHandle(freshId);
    requireTest(bridge.requestCount() == 0 && bridge.deferredCount() == 0, "fresh request cleanup failed");

    reset();
    const auto id = sendRequest();
    nowMs += bridge.trackingLifetimeMs + 1;
    requireTest(!bridge.claim(lastDeferred) && bridge.requestCount() == 0, "expired response still raw");
    releaseHandle(id);
}
int replacement() {
    return 99;
}
void detourTests() {
    auto code =
        static_cast<unsigned char *>(VirtualAlloc(nullptr, 128, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE));
    requireTest(code != nullptr, "allocate test function");
    std::memcpy(code, bridge.prologue, bridge.prologueSize);
    const unsigned char tail[] = {0xb8, 42,   0,    0,    0,    0x48, 0x83, 0xc4,
                                  0x60, 0x5b, 0x5f, 0x5e, 0x41, 0x5e, 0x5d, 0xc3};
    std::memcpy(code + bridge.prologueSize, tail, sizeof(tail));
    DWORD old;
    requireTest(VirtualProtect(code, 128, PAGE_EXECUTE_READ, &old) != 0, "protect test function");
    auto function = reinterpret_cast<int (*)()>(code);
    auto patch = bridge.createDetour(code, bridge.prologue, bridge.prologueSize,
                                     reinterpret_cast<void *>(replacement));
    requireTest(function() == 42 && reinterpret_cast<int (*)()>(patch.trampoline)() == 42,
                "trampoline failed");
    requireTest(bridge.writeDetour(patch.implementation, false) && function() == 99, "hook failed");
    requireTest(bridge.writeDetour(patch.implementation, true) && function() == 42, "restore failed");
    unsigned char wrong[32]{};
    bool refused = false;
    try {
        bridge.createDetour(code, wrong, bridge.prologueSize, reinterpret_cast<void *>(replacement));
    } catch (...) {
        refused = true;
    }
    requireTest(refused, "signature mismatch accepted");
    bridge.destroyDetour(patch.implementation);
    VirtualFree(code, 0, MEM_RELEASE);
}
} // namespace
int main() {
    try {
        conversionTests();
        callbackLifetimeTests();
        failedSendTests();
        abandonedRequestTests();
        detourTests();
        std::cout
            << "Independent packet bridge: lifetime, cleanup, binary conversion and detour tests passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << "\n";
        return 1;
    }
}
