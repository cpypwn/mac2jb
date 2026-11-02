/**
 * @file harness.c
 * @brief Host (macOS) test harness for native.c: runs the console server against POSIX sockets.
 *
 * nn::socket is BSD-derived, so on macOS the ServerFunctions table maps 1:1 onto POSIX
 * (sockaddr_in has sin_len, MSG_DONTWAIT == 0x80, EAGAIN == 35, POLLERR|POLLHUP|POLLNVAL == 0x38).
 * Storage IPC is faked: reads return a deterministic byte pattern, so only source kind 0 (RomFS
 * storage) is exercised; the ExeFS/DLC open_source path still needs the console.
 *
 * Usage: harness <port> <manifest-path>
 *   Writes "<path>\t<offset>\t<size>" per file to the manifest, prints "ready", and serves until stdin closes.
 * Build: see engine/oz-code/test/run.sh (ASan + UBSan).
 */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "../native.h"

    #define INDEX_MAGIC 0x584950544632534eULL
    #define CFG_MAGIC 0x313050544632534eULL
    #define NONE 0xffffffffu

static const u64 cDataBytes = 16384;        ///< Small on purpose: forces block-cache misses and listing flushes.
static const u64 cIpcBytes = 8192;
static const u64 cScratchBytes = 8192;
static const u32 cSlots = SERVER_MAX_CLIENTS; ///< Same as engine/server.cjs deploys; check.py assumes it.
static const u32 cSourceHandle = 0x1234;

/// Byte at a given offset of the fake RomFS storage; the Python test computes the same function.
static u8 pattern(u64 offset) { return (u8) ((offset * 131u) ^ (offset >> 8)); }

// No SO_REUSEADDR here: native.c must cope with TIME_WAIT on its own, exactly as on the console.
static int sdk_socket(int domain, int type, int protocol) { return socket(domain, type, protocol); }
static int sdk_bind(int fd, const Address* a, u32 n) { return bind(fd, (const struct sockaddr*) a, n); }
static int sdk_listen(int fd, int backlog) { return listen(fd, backlog); }
static int sdk_accept(int fd, Address* a, u32* n) { return accept(fd, (struct sockaddr*) a, (socklen_t*) n); }
static s64 sdk_recv(int fd, void* b, u64 n, int flags) { return recv(fd, b, n, flags); }
static s64 sdk_send(int fd, const void* b, u64 n, int flags) { return send(fd, b, n, flags); }
static int sdk_close(int fd) { return close(fd); }
static int sdk_poll(PollFd* p, u64 n, int timeout) { return poll((struct pollfd*) p, (nfds_t) n, timeout); }
static int sdk_sockname(int fd, Address* a, u32* n) { return getsockname(fd, (struct sockaddr*) a, (socklen_t*) n); }
static int sdk_fcntl(int fd, int command, ...) {
    va_list args;
    va_start(args, command);
    int value = va_arg(args, int);
    va_end(args);
    return fcntl(fd, command, value);
}
static int sdk_errno(void) { return errno; }
static u32 sdk_close_handle(u32 handle) { (void) handle; return 0; }
static int sdk_thread_create(u64* thread, void* attributes, void* (*entry)(void*), void* argument) {
    (void) attributes;
    pthread_t created;
    int result = pthread_create(&created, 0, entry, argument);
    if (!result) *thread = (u64) (uintptr_t) created;
    return result;
}
static int sdk_thread_join(u64 thread, void** value) { return pthread_join((pthread_t) (uintptr_t) thread, value); }
static int sdk_setsockopt(int fd, int level, int option, const void* value, u32 n) { return setsockopt(fd, level, option, value, n); }
static int sdk_connect(int fd, const Address* a, u32 n) { return connect(fd, (const struct sockaddr*) a, n); }

/**
 * @brief Fake fsp IPC: decode the read request native.c's packet() builds and answer it.
 *
 * Request: output buffer descriptor in words 2..4, CMIF header at byte 32, input u64s at byte 48
 * ({offset, size} for storage reads). Response: no special header, CMIF "SFCO" at word 4, result 0.
 */
static u32 sdk_ipc(void* buffer, u64 bytes, u32 handle) {
    (void) bytes;
    u32* p = buffer;
    if (handle != cSourceHandle || !(p[0] >> 24)) return 0xbad;
    u64 address = (u64) p[3] | ((u64) ((p[4] >> 28) & 15) << 32) | ((u64) ((p[4] >> 2) & 0x3ffffff) << 36);
    u32 command = p[10];
    const u64* input = (const u64*) ((u8*) p + 48);
    if (command != 0) return 0xbad;
    u64 offset = input[0], count = input[1];
    u8* out = (u8*) (uintptr_t) address;
    for (u64 i = 0; i < count; i++) out[i] = pattern(offset + i);
    memset(p, 0, 64);
    p[4] = 0x4f434653;
    return 0;
}

/// Index builder state: nodes plus a string table, in the NS2FTPIX layout read by index_valid().
typedef struct {
    Node nodes[1024];
    u32 count;
    char strings[65536];
    u32 string_bytes;
    u64 next_offset;
    FILE* manifest;
} Tree;

static u32 add_string(Tree* t, const char* s) {
    u32 at = t->string_bytes;
    size_t n = strlen(s) + 1;
    memcpy(t->strings + at, s, n);
    t->string_bytes += (u32) n;
    return at;
}

/// Append a node as the last child of `parent`. Children must be added in index order (parent < child).
static u32 add_node(Tree* t, u32 parent, const char* name, int file, u64 size) {
    u32 id = t->count++;
    Node* n = &t->nodes[id];
    memset(n, 0, sizeof(*n));
    n->parent = parent;
    n->child = NONE;
    n->next = NONE;
    n->type = (u32) file;
    n->name_offset = add_string(t, name);
    n->name_length = (u32) strlen(name);
    if (file) {
        n->offset = t->next_offset;
        n->size = size;
        t->next_offset += size + 7; // Unaligned gaps catch off-by-one offset bugs.
    }
    if (id) {
        if (t->nodes[parent].child == NONE) t->nodes[parent].child = id;
        else {
            u32 at = t->nodes[parent].child;
            while (t->nodes[at].next != NONE) at = t->nodes[at].next;
            t->nodes[at].next = id;
        }
    }
    return id;
}

static void manifest_line(Tree* t, const char* path, u32 id) {
    fprintf(t->manifest, "%s\t%llu\t%llu\n", path, t->nodes[id].offset, t->nodes[id].size);
}

/// Build the test tree and serialize it; returns a malloc'd index.
static u8* build_index(Tree* t, u64* index_bytes) {
    add_node(t, 0, "", 0, 0);
    u32 romfs = add_node(t, 0, "romfs", 0, 0);
    manifest_line(t, "/romfs/hello.txt", add_node(t, romfs, "hello.txt", 1, 13));
    manifest_line(t, "/romfs/big.bin", add_node(t, romfs, "big.bin", 1, 100003));
    manifest_line(t, "/romfs/a b&<c>'\".dat", add_node(t, romfs, "a b&<c>'\".dat", 1, 5));
    manifest_line(t, "/romfs/\xe6\x97\xa5\xe6\x9c\xac.bin", add_node(t, romfs, "\xe6\x97\xa5\xe6\x9c\xac.bin", 1, 10));
    manifest_line(t, "/romfs/empty.bin", add_node(t, romfs, "empty.bin", 1, 0));
    u32 many = add_node(t, romfs, "many", 0, 0);
    u32 deep = add_node(t, many, "deep", 0, 0);
    manifest_line(t, "/romfs/many/deep/leaf.bin", add_node(t, deep, "leaf.bin", 1, 4097));
    for (int i = 0; i < 400; i++) {
        char name[32], path[64];
        snprintf(name, sizeof(name), "file-%03d.bin", i);
        snprintf(path, sizeof(path), "/romfs/many/%s", name);
        manifest_line(t, path, add_node(t, many, name, 1, (u64) i));
    }
    u64 nodes_bytes = (u64) t->count * sizeof(Node);
    *index_bytes = 64 + nodes_bytes + t->string_bytes;
    u8* index = calloc(1, *index_bytes);
    u64* header = (u64*) index;
    header[0] = INDEX_MAGIC;
    ((u32*) header)[2] = 1;
    ((u32*) header)[3] = sizeof(Node);
    header[2] = t->count;
    header[3] = 64;
    header[4] = 64 + nodes_bytes;
    header[5] = t->string_bytes;
    header[6] = *index_bytes;
    memcpy(index + 64, t->nodes, nodes_bytes);
    memcpy(index + 64 + nodes_bytes, t->strings, t->string_bytes);
    return index;
}

static void* run_server(void* config) { return server_main(config); }

int main(int argc, char** argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <port> <manifest-path>\n", argv[0]);
        return 2;
    }
    signal(SIGPIPE, SIG_IGN); // send() to a closed peer must fail, not kill the process.
    static Tree tree;
    tree.manifest = fopen(argv[2], "w");
    if (!tree.manifest) {
        perror("manifest");
        return 1;
    }
    u64 index_bytes;
    u8* index = build_index(&tree, &index_bytes);
    fclose(tree.manifest);

    static ServerFunctions functions = {
        sdk_socket, sdk_bind, sdk_listen, sdk_accept, sdk_recv, sdk_send, sdk_close, sdk_poll,
        sdk_sockname, sdk_fcntl, sdk_errno, sdk_ipc, sdk_close_handle, sdk_thread_create, sdk_thread_join,
        sdk_setsockopt, sdk_connect,
    };
    Source source = {cSourceHandle, 0, 0, 0, tree.next_offset};
    u64 slot_bytes = 4096 + cDataBytes + cIpcBytes + cScratchBytes;
    ServerConfig* config = calloc(1, sizeof(ServerConfig));
    config->magic = CFG_MAGIC;
    config->version = 1;
    config->port = (u32) atoi(argv[1]);
    config->zip_port = 12345;
    config->reserved = cSlots;
    config->functions = &functions;
    config->index = index;
    config->index_bytes = index_bytes;
    config->sources = &source;
    config->source_count = 1;
    config->data = calloc(1, cDataBytes);
    config->data_bytes = cDataBytes;
    config->ipc_buffer = calloc(1, cIpcBytes);
    config->slots = calloc(cSlots, slot_bytes);
    config->slot_bytes = slot_bytes;

    pthread_t server;
    pthread_create(&server, 0, run_server, config);
    while (!config->state) usleep(1000);
    if (config->state != 1) {
        fprintf(stderr, "server failed to start (state %u, phase %u, errno %llu)\n", config->state, config->phase,
                config->native_result);
        return 1;
    }
    printf("ready ip=%u.%u.%u.%u\n", config->ip[0], config->ip[1], config->ip[2], config->ip[3]);
    fflush(stdout);

    char ignored[64];
    while (fread(ignored, 1, sizeof(ignored), stdin) > 0) {}
    config->stop = 1;
    void* result;
    pthread_join(server, &result);
    printf("stopped: result=%llu sent=%llu files=%llu\n", (u64) (uintptr_t) result, config->sent, config->files);
    free(config->slots);
    free(config->ipc_buffer);
    free(config->data);
    free(config);
    free(index);
    return result ? 1 : 0;
}
