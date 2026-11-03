#include <assert.h>
#include <stdint.h>
#include <string.h>

typedef unsigned int u32;
typedef unsigned long long u64;
typedef struct { u64 result, value; } Reply;
typedef struct {
    u64 address, size;
    u32 type, attributes, permission, ipc_refs, device_refs, padding;
} MemoryInfo;

extern u32 process_request(u32 command, const u64 *input, u32 bytes,
    u32 handle, u64 *out, u32 *output_bytes, void *receive, u64 receive_size);

static const u64 source = 0x20000000, destination = 0x30000000;
static const u32 copied_handle = 0x42;
static u64 mapped_size;
static u32 permission, map_error, permission_error, unmap_error;
static u64 program_id = 0x0100c9100b06a000ULL;

Reply process_id(u32 handle) { return (Reply){handle == copied_handle ? 0 : 1, 4242}; }
Reply get_info(u32 type, u32 handle, u64 subtype) {
    (void)subtype;
    return (Reply){handle == copied_handle ? 0 : 1,
        type == 18 ? program_id : 0};
}
Reply query_process(MemoryInfo *info, u32 handle, u64 address) {
    if (handle != copied_handle) return (Reply){1, 0};
    memset(info, 0, sizeof(*info));
    if (address >= source && address < source + 0x8000) {
        *info = (MemoryInfo){.address = source, .size = 0x8000, .type = 5,
            .permission = 3};
        return (Reply){0, 0};
    }
    if (address >= destination && address < destination + 0x100000) {
        *info = (MemoryInfo){.address = destination,
            .size = mapped_size ? mapped_size : 0x100000,
            .type = mapped_size ? 3 : 0, .permission = permission};
        return (Reply){0, 0};
    }
    return (Reply){1, 0};
}
Reply query_memory(MemoryInfo *info, u64 address) {
    return query_process(info, copied_handle, address);
}
u32 map_process(u64 destination_address, u32 handle, u64 source_address, u64 size) {
    (void)destination_address; (void)handle; (void)source_address; (void)size;
    return 1;
}
u32 unmap_process(u64 destination_address, u32 handle, u64 source_address, u64 size) {
    (void)destination_address; (void)handle; (void)source_address; (void)size;
    return 1;
}
u32 map_code(u32 handle, u64 destination_address, u64 source_address, u64 size) {
    assert(handle == copied_handle && destination_address == destination &&
        source_address == source && size >= 0x1000);
    if (map_error) return map_error;
    mapped_size = size; permission = 0;
    return 0;
}
u32 unmap_code(u32 handle, u64 destination_address, u64 source_address, u64 size) {
    assert(handle == copied_handle && destination_address == destination &&
        source_address == source && size == mapped_size);
    if (unmap_error) return unmap_error;
    mapped_size = 0; permission = 0;
    return 0;
}
u32 process_permission(u32 handle, u64 address, u64 size, u32 target) {
    assert(handle == copied_handle && address == destination && size == mapped_size);
    if (permission_error) return permission_error;
    permission = target;
    return 0;
}

static u32 call(u32 command, u64 source_address, u64 destination_address,
    u64 pages, u64 *out) {
    u64 input[4] = {4242, source_address, destination_address, pages};
    u32 output_bytes = 0;
    memset(out, 0, 24 * sizeof(*out));
    u32 result = process_request(command, input, sizeof(input), copied_handle,
        out, &output_bytes, 0, 0);
    assert(output_bytes == 80);
    return result;
}

int main(void) {
    u64 out[24];
    assert(call(0x524f001a, source, destination, 2, out) == 0);
    assert(out[3] == 2 && out[8] == 1 && permission == 5 && mapped_size == 0x2000);
    assert(call(0x524f001c, source, destination, 2, out) == 0);
    assert(out[3] == 2 && out[6] == 0 && mapped_size == 0);
    program_id = 0x0100b4b00f9f6000ULL;
    assert(call(0x524f001a, source, destination, 2, out) == 0);
    assert(call(0x524f001c, source, destination, 2, out) == 0);
    program_id = 0x0400000000000037ULL;
    assert(call(0x524f001a, source, destination, 2, out) == 0xd401);
    program_id = 0x0100c9100b06a000ULL;

    assert(call(0x524f001b, source, destination, 2, out) == 0);
    assert(out[3] == 2 && permission == 3);
    assert(call(0x524f001a, source, destination, 2, out) == 0xd401);
    assert(call(0x524f001c, source, destination, 2, out) == 0);

    assert(call(0x524f001a, source, destination, 8, out) == 0xd401);
    assert(call(0x524f001a, source + 1, destination, 2, out) == 0xd401);
    assert(call(0x524f001a, source, destination + 1, 2, out) == 0xd401);
    assert(call(0x524f001a, source, destination, 0, out) == 0xd401);
    assert(call(0x524f001a, source, destination, 16385, out) == 0xd401);

    permission_error = 0xd001;
    assert(call(0x524f001a, source, destination, 2, out) == 0xd001);
    assert(out[5] == 0xd001 && out[6] == 0 && mapped_size == 0);
    unmap_error = 0xd002;
    assert(call(0x524f001a, source, destination, 2, out) == 0xd002);
    assert(out[5] == 0xd001 && out[6] == 0xd002 && mapped_size == 0x2000);
    permission_error = 0; unmap_error = 0;
    assert(call(0x524f001c, source, destination, 2, out) == 0);

    assert(call(0x524f001a, source, destination, 2, out) == 0);
    unmap_error = 0xd002;
    assert(call(0x524f001c, source, destination, 2, out) == 0xd002);
    assert(out[3] == 0 && out[5] == 0xd002 && out[6] == 1 && mapped_size == 0x2000);
    unmap_error = 0;
    assert(call(0x524f001c, source, destination, 2, out) == 0);
    return 0;
}
