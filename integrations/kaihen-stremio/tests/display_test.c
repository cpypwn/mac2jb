#include "display.h"

#include <assert.h>
#include <stdio.h>

int main(void) {
    StremioViewport box;
    assert(stremio_viewport(1280, 720, 1920, 1080, &box));
    assert(box.x == 0 && box.y == 0 && box.width == 1280 && box.height == 720);
    assert(stremio_viewport(1280, 720, 640, 480, &box));
    assert(box.x == 160 && box.y == 0 && box.width == 960 && box.height == 720);
    assert(stremio_viewport(1280, 720, 720, 1280, &box));
    assert(box.y == 0 && box.height == 720 && box.width == 405 && box.x == 437);
    assert(!stremio_viewport(1280, 720, 0, 1080, &box));
    assert(stremio_nv12_pixel(16, 128, 128) == 0xff000000U);
    assert(stremio_nv12_pixel(235, 128, 128) == 0xffffffffU);
    assert(stremio_nv12_pixel(81, 90, 240) == 0xff0000ffU);
    puts("video layout checks passed");
    return 0;
}
