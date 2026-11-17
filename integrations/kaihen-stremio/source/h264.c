#include "h264.h"

#include <string.h>

static const uint8_t start_code[4] = {0, 0, 0, 1};

static int append_nal(const uint8_t *bytes, size_t length, uint8_t *output,
                      size_t capacity, size_t *offset) {
    if (!length || capacity < sizeof(start_code) ||
        *offset > capacity - sizeof(start_code) ||
        length > capacity - sizeof(start_code) - *offset) return 0;
    memcpy(output + *offset, start_code, sizeof(start_code));
    *offset += sizeof(start_code);
    memcpy(output + *offset, bytes, length);
    *offset += length;
    return 1;
}

static int start_code_at(const uint8_t *bytes, size_t length, size_t offset,
                         size_t *code_size) {
    if (offset + 3 > length || bytes[offset] || bytes[offset + 1]) return 0;
    if (bytes[offset + 2] == 1) {
        *code_size = 3;
        return 1;
    }
    if (offset + 4 <= length && !bytes[offset + 2] && bytes[offset + 3] == 1) {
        *code_size = 4;
        return 1;
    }
    return 0;
}

int stremio_h264_config(const uint8_t *extra, size_t extra_size,
                        uint8_t *output, size_t capacity, size_t *written,
                        unsigned *nal_length_size) {
    size_t offset = 0, cursor = 0, code_size;
    int saw_sps = 0, saw_pps = 0;
    if (!extra || !output || !written || !nal_length_size) return 0;
    *written = 0;
    *nal_length_size = 0;
    if (extra_size >= 7 && extra[0] == 1) {
        unsigned length_size = (extra[4] & 3U) + 1U;
        unsigned sps_count = extra[5] & 31U;
        cursor = 6;
        if (!sps_count) return 0;
        for (unsigned i = 0; i < sps_count; i++) {
            if (cursor + 2 > extra_size) return 0;
            size_t length = ((size_t)extra[cursor] << 8) | extra[cursor + 1];
            cursor += 2;
            if (length > extra_size - cursor || !length || (extra[cursor] & 31) != 7 ||
                !append_nal(extra + cursor, length, output, capacity, &offset)) return 0;
            cursor += length;
            saw_sps = 1;
        }
        if (cursor >= extra_size) return 0;
        unsigned pps_count = extra[cursor++];
        if (!pps_count) return 0;
        for (unsigned i = 0; i < pps_count; i++) {
            if (cursor + 2 > extra_size) return 0;
            size_t length = ((size_t)extra[cursor] << 8) | extra[cursor + 1];
            cursor += 2;
            if (length > extra_size - cursor || !length || (extra[cursor] & 31) != 8 ||
                !append_nal(extra + cursor, length, output, capacity, &offset)) return 0;
            cursor += length;
            saw_pps = 1;
        }
        *nal_length_size = length_size;
    } else {
        while (cursor < extra_size) {
            if (!start_code_at(extra, extra_size, cursor, &code_size)) return 0;
            size_t begin = cursor + code_size;
            size_t end = begin;
            if (begin >= extra_size) return 0;
            while (end < extra_size && !start_code_at(extra, extra_size, end, &code_size)) end++;
            unsigned type = extra[begin] & 31U;
            if (type == 7 || type == 8) {
                if (!append_nal(extra + begin, end - begin, output, capacity, &offset)) return 0;
                if (type == 7) saw_sps = 1;
                if (type == 8) saw_pps = 1;
            }
            cursor = end;
        }
    }
    if (!saw_sps || !saw_pps) return 0;
    *written = offset;
    return 1;
}

int stremio_h264_access_unit(const uint8_t *packet, size_t packet_size,
                             unsigned nal_length_size, uint8_t *output,
                             size_t capacity, size_t *written) {
    size_t cursor = 0, offset = 0, code_size;
    if (!packet || !output || !written || !packet_size) return 0;
    *written = 0;
    if (!nal_length_size) {
        if (!start_code_at(packet, packet_size, 0, &code_size) || packet_size > capacity) return 0;
        memcpy(output, packet, packet_size);
        *written = packet_size;
        return 1;
    }
    if (nal_length_size > 4) return 0;
    while (cursor < packet_size) {
        if (nal_length_size > packet_size - cursor) return 0;
        size_t length = 0;
        for (unsigned i = 0; i < nal_length_size; i++)
            length = (length << 8) | packet[cursor++];
        if (length > packet_size - cursor ||
            !append_nal(packet + cursor, length, output, capacity, &offset)) return 0;
        cursor += length;
    }
    *written = offset;
    return offset != 0;
}
