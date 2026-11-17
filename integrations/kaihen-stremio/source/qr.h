#ifndef KAIHEN_STREMIO_QR_H
#define KAIHEN_STREMIO_QR_H

#include <stdbool.h>
#include <stdint.h>

#define STREMIO_QR_MAX_SIZE 97

typedef struct {
    uint32_t size;
    uint8_t modules[STREMIO_QR_MAX_SIZE * STREMIO_QR_MAX_SIZE];
} StremioQr;

bool stremio_qr_encode(StremioQr *output, const char *url);

#endif
