#include "qr.h"

#include <assert.h>
#include <stddef.h>

static int dark(const StremioQr *qr, int x, int y) {
    return qr->modules[(size_t)y * qr->size + (size_t)x] != 0;
}

static void check_finder(const StremioQr *qr, int left, int top) {
    for (int y = 0; y < 7; y++) {
        for (int x = 0; x < 7; x++) {
            int expected = x == 0 || x == 6 || y == 0 || y == 6 ||
                           (x >= 2 && x <= 4 && y >= 2 && y <= 4);
            assert(dark(qr, left + x, top + y) == expected);
        }
    }
}

int main(void) {
    StremioQr qr;
    assert(stremio_qr_encode(&qr, "https://www.stremio.com/activate?code=0123456789"));
    assert(qr.size >= 21 && qr.size <= STREMIO_QR_MAX_SIZE);
    check_finder(&qr, 0, 0);
    check_finder(&qr, (int)qr.size - 7, 0);
    check_finder(&qr, 0, (int)qr.size - 7);
    assert(!stremio_qr_encode(&qr, "http://www.stremio.com/activate"));
    assert(!stremio_qr_encode(&qr, "https://www.stremio.com/activate\nother"));
    assert(!stremio_qr_encode(&qr, ""));
    assert(!stremio_qr_encode(NULL, "https://www.stremio.com/activate"));
    return 0;
}
