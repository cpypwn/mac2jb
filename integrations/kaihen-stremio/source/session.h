#ifndef KAIHEN_STREMIO_SESSION_H
#define KAIHEN_STREMIO_SESSION_H

#include <stddef.h>
#include <stdint.h>
#include <switch.h>

int stremio_native_play(const char *url, uint64_t resume_ms, PadState *pad,
                        char *status, size_t status_size);

#endif
