#ifndef KAIHEN_STREMIO_H264_H
#define KAIHEN_STREMIO_H264_H

#include <stddef.h>
#include <stdint.h>

int stremio_h264_config(const uint8_t *extra, size_t extra_size,
                        uint8_t *output, size_t capacity, size_t *written,
                        unsigned *nal_length_size);
int stremio_h264_access_unit(const uint8_t *packet, size_t packet_size,
                             unsigned nal_length_size, uint8_t *output,
                             size_t capacity, size_t *written);

#endif
