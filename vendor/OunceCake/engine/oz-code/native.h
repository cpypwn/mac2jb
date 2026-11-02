/**
 * @file native.h
 * @brief ABI shared between the injected read-only HTTP/WebDAV server and the host (engine/server.cjs).
 *
 * Every struct here is written byte-for-byte by the host, so field order, sizes and the
 * static asserts at the bottom are a wire contract. Change both sides together.
 */
#ifndef NS2_SERVER_NATIVE_H
#define NS2_SERVER_NATIVE_H
#define SERVER_MAX_CLIENTS 12
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef long long s64;
typedef struct {u8 length, family; u16 port; u32 address; u8 zero[8];} Address;
typedef struct {int fd; short events, revents;} PollFd;
/// SDK entry points resolved by the host; the order matches the table written in engine/server.cjs.
typedef struct {
    int (*socket)(int, int, int);
    int (*bind)(int, const Address*, u32);
    int (*listen)(int, int);
    int (*accept)(int, Address*, u32*);
    s64 (*recv)(int, void*, u64, int);
    s64 (*send)(int, const void*, u64, int);
    int (*close)(int);
    int (*poll)(PollFd*, u64, int);
    int (*sockname)(int, Address*, u32*);
    int (*fcntl)(int, int, ...);
    int (*get_errno)(void);
    u32 (*ipc)(void*, u64, u32);
    u32 (*close_handle)(u32);
    int (*thread_create)(u64*, void*, void* (*)(void*), void*);
    int (*thread_join)(u64, void**);
    int (*setsockopt)(int, int, int, const void*, u32);
    int (*connect)(int, const Address*, u32);
} ServerFunctions;
/// Written to ServerConfig.phase when startup fails (state 3), so the host can say which step broke.
enum StartupPhase {
    PHASE_CONFIG = 1, ///< Host-written configuration rejected.
    PHASE_INDEX = 2,  ///< File index from engine/mounts.cjs rejected.
    PHASE_SOCKET = 3, ///< socket(); native_result holds errno from here on.
    PHASE_BIND = 4,
    PHASE_LISTEN = 5,
};
// kinds: 0 = base/update romfs, 1 = exefs, 2 = dlc romfs
typedef struct {u32 handle; u8 kind, attributes; u16 reserved; u64 size;} Source;
typedef struct {
    u32 parent, child, next, type, name_offset, name_length, mount, source_path;
    u64 offset, size;
} Node;
typedef struct ServerConfigTag {
    u64 magic;
    u32 version;
    volatile u32 stop, state, result;
    u32 port, reserved;
    volatile u64 sent, files, native_result;
    u8 ip[4]; u32 phase;
    ServerFunctions* functions;
    const u8* index; u64 index_bytes;
    const Source* sources; u64 source_count;
    u8* data; u64 data_bytes;
    u8* ipc_buffer;
    volatile u32 pressure;  ///< Set by the accept loop when every slot is busy; idle keep-alive sessions yield. Host leaves it zero.
    u32 zip_port;
    u8 reserved_config[88]; // padding to align with layout from server.cjs
    volatile u32 io_lock; u32 padding;
    u8* slots; u64 slot_bytes;
    struct ServerConfigTag* owner;
} ServerConfig;
_Static_assert(sizeof(Address) == 16 && sizeof(PollFd) == 8 && sizeof(Node) == 48, "wire ABI");
_Static_assert(sizeof(Source) == 16, "source ABI");
_Static_assert(sizeof(ServerFunctions) == 17 * 8, "function table ABI");
_Static_assert(__builtin_offsetof(ServerConfig, functions) == 64 && sizeof(ServerConfig) == 256, "configuration ABI");
_Static_assert(__builtin_offsetof(ServerConfig, zip_port) == 132, "ZIP port ABI");
void* server_main(void* configuration);
#endif
