#pragma once

// Test-only access to the bridge implementation. The fixture links packet.cpp
// as a separate translation unit; this interface is absent from the shipped DLL.
#ifdef OPENQQ_PACKET_TESTING
#include <cstddef>
#include <cstdint>

using PacketTestValue = void *;
struct PacketTestMocks {
    int (*getArgs)(void *, void *, size_t *, void **, void **, void **);
    int (*getString)(void *, void *, char *, size_t, size_t *);
    int (*isBuffer)(void *, void *, bool *);
    int (*getBuffer)(void *, void *, void **, size_t *);
    int (*createBuffer)(void *, size_t, const void *, void **, void **);
    int (*createObject)(void *, void **);
    int (*set)(void *, void *, const char *, void *);
    int (*get)(void *, void *, const char *, void **);
    int (*call)(void *, void *, void *, size_t, void *const *, void **);
    int (*boolean)(void *, bool, void **);
    int (*throwError)(void *, const char *, const char *);
    int (*createString)(void *, const char *, size_t, void **);
    int (*createPromise)(void *, void **, void **);
    void *(*convert)(void *, void *, void *);
    void (*response)(void *);
    uint64_t (*now)();
};

struct PacketTestDetour {
    void *implementation;
    void *trampoline;
};

struct PacketBridgeTestAccess {
    void (*configure)(const PacketTestMocks &);
    bool (*supportsVersion)(const char *);
    uint64_t (*beginRequest)();
    void (*releaseRequest)(uint64_t);
    void (*setRawRequest)(uint64_t);
    void (*setRawResponse)(bool);
    bool (*rawResponse)();
    uint64_t (*rawRequestId)();
    size_t (*requestCount)();
    size_t (*deferredCount)();
    bool (*claim)(void *);
    int (*trackPromise)(void *, void **, void **);
    void *(*convert)(void *, void *, void *);
    int (*createResponse)(void *, const char *, size_t, void **, uintptr_t);
    void (*completeResponse)(void *);
    uintptr_t (*responseReturnAddress)();
    void *(*send)(void *, void *);
    void *(*release)(void *, void *);
    PacketTestDetour (*createDetour)(void *, const unsigned char *, size_t, void *);
    bool (*writeDetour)(void *, bool);
    void (*destroyDetour)(void *);
    const unsigned char *prologue;
    size_t prologueSize;
    size_t maxRequests;
    uint64_t trackingLifetimeMs;
};

PacketBridgeTestAccess GetPacketBridgeTestAccess();
#endif
