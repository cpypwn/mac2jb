#include "h264.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    const uint8_t avcc[] = {1, 0x64, 0, 0x1f, 0xff, 0xe1,
                            0, 3, 0x67, 0x64, 0x1f,
                            1, 0, 2, 0x68, 0xee};
    const uint8_t sample[] = {0, 0, 0, 2, 0x65, 0x88,
                              0, 0, 0, 2, 0x06, 0x05};
    const uint8_t expected_config[] = {0, 0, 0, 1, 0x67, 0x64, 0x1f,
                                       0, 0, 0, 1, 0x68, 0xee};
    const uint8_t expected_sample[] = {0, 0, 0, 1, 0x65, 0x88,
                                       0, 0, 0, 1, 0x06, 0x05};
    uint8_t output[64];
    size_t written;
    unsigned length_size;
    assert(stremio_h264_config(avcc, sizeof avcc, output, sizeof output,
                               &written, &length_size));
    assert(length_size == 4 && written == sizeof expected_config);
    assert(!memcmp(output, expected_config, written));
    assert(stremio_h264_access_unit(sample, sizeof sample, length_size,
                                    output, sizeof output, &written));
    assert(written == sizeof expected_sample);
    assert(!memcmp(output, expected_sample, written));
    assert(stremio_h264_config(expected_config, sizeof expected_config,
                               output, sizeof output, &written, &length_size));
    assert(length_size == 0 && written == sizeof expected_config);
    assert(!stremio_h264_config(avcc, sizeof avcc - 1, output, sizeof output,
                                &written, &length_size));
    assert(!stremio_h264_access_unit(sample, sizeof sample - 1, 4,
                                     output, sizeof output, &written));
    assert(!stremio_h264_access_unit(sample, sizeof sample, 4,
                                     output, 5, &written));
    puts("h264 conversion checks passed");
    return 0;
}
