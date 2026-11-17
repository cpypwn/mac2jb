#include "qr.h"
#include "qrcodegen.h"

#include <stddef.h>
#include <string.h>

bool stremio_qr_encode(StremioQr *output, const char *url) {
    if (!output || !url) return false;
    memset(output, 0, sizeof(*output));

    size_t length = 0;
    while (length < 4096 && url[length]) {
        unsigned char ch = (unsigned char)url[length];
        if (ch < 0x20 || ch == 0x7f) return false;
        length++;
    }
    if (!length || length == 4096 || strncmp(url, "https://", 8) != 0) return false;

    uint8_t scratch[qrcodegen_BUFFER_LEN_MAX];
    uint8_t encoded[qrcodegen_BUFFER_LEN_MAX];
    if (!qrcodegen_encodeText(url, scratch, encoded, qrcodegen_Ecc_MEDIUM,
                             qrcodegen_VERSION_MIN, 20, qrcodegen_Mask_AUTO, true)) return false;

    int size = qrcodegen_getSize(encoded);
    if (size <= 0 || size > STREMIO_QR_MAX_SIZE) return false;
    output->size = (uint32_t)size;
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            output->modules[(size_t)y * (size_t)size + (size_t)x] =
                qrcodegen_getModule(encoded, x, y) ? 1 : 0;
        }
    }
    return true;
}
