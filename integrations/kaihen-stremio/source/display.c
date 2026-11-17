#include "display.h"

#include <string.h>

int stremio_viewport(uint32_t screen_width, uint32_t screen_height,
                     uint32_t image_width, uint32_t image_height,
                     StremioViewport *out) {
    uint32_t width, height;
    if (!screen_width || !screen_height || !image_width || !image_height || !out) return 0;
    if ((uint64_t)image_width * screen_height > (uint64_t)image_height * screen_width) {
        width = screen_width;
        height = (uint32_t)((uint64_t)image_height * width / image_width);
    } else {
        height = screen_height;
        width = (uint32_t)((uint64_t)image_width * height / image_height);
    }
    if (!width || !height) return 0;
    out->x = (screen_width - width) / 2;
    out->y = (screen_height - height) / 2;
    out->width = width;
    out->height = height;
    return 1;
}

static uint8_t clamp_color(int value) {
    return value < 0 ? 0 : value > 255 ? 255 : (uint8_t)value;
}

uint32_t stremio_nv12_pixel(uint8_t y, uint8_t u, uint8_t v) {
    int c = y > 16 ? y - 16 : 0;
    int d = (int)u - 128;
    int e = (int)v - 128;
    uint32_t r = clamp_color((298 * c + 409 * e + 128) >> 8);
    uint32_t g = clamp_color((298 * c - 100 * d - 208 * e + 128) >> 8);
    uint32_t b = clamp_color((298 * c + 516 * d + 128) >> 8);
    return r | (g << 8) | (b << 16) | 0xff000000U;
}

#ifdef __SWITCH__
Result stremio_video_screen_open(StremioVideoScreen *screen) {
    Result rc;
    if (!screen) return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    memset(screen, 0, sizeof(*screen));
    screen->width = 1280;
    screen->height = 720;
    rc = framebufferCreate(&screen->framebuffer, nwindowGetDefault(),
                           screen->width, screen->height, PIXEL_FORMAT_RGBA_8888, 2);
    if (R_FAILED(rc)) return rc;
    rc = framebufferMakeLinear(&screen->framebuffer);
    if (R_FAILED(rc)) {
        framebufferClose(&screen->framebuffer);
        return rc;
    }
    screen->ready = 1;
    return 0;
}

void stremio_video_screen_close(StremioVideoScreen *screen) {
    if (screen && screen->ready) {
        framebufferClose(&screen->framebuffer);
        memset(screen, 0, sizeof(*screen));
    }
}

int stremio_video_present(StremioVideoScreen *screen, const VideoFrame *frame) {
    StremioViewport viewport;
    uint32_t stride;
    uint8_t *pixels;
    if (!screen || !screen->ready || !frame || !frame->planes[0] || !frame->planes[1] ||
        !frame->width || !frame->height || (frame->width & 1U) || (frame->height & 1U) ||
        frame->pitches[0] < frame->width || frame->pitches[1] < frame->width ||
        !stremio_viewport(screen->width, screen->height, frame->width, frame->height, &viewport))
        return 0;
    pixels = framebufferBegin(&screen->framebuffer, &stride);
    if (!pixels || stride < screen->width * 4) return 0;
    for (uint32_t y = 0; y < screen->height; y++) {
        uint32_t *row = (uint32_t *)(pixels + (size_t)y * stride);
        for (uint32_t x = 0; x < screen->width; x++) row[x] = 0xff14201cU;
    }
    for (uint32_t y = 0; y < viewport.height; y++) {
        uint32_t source_y = (uint32_t)((uint64_t)y * frame->height / viewport.height);
        uint32_t *row = (uint32_t *)(pixels + (size_t)(viewport.y + y) * stride);
        const uint8_t *luma = frame->planes[0] + (size_t)source_y * frame->pitches[0];
        const uint8_t *chroma = frame->planes[1] + (size_t)(source_y / 2) * frame->pitches[1];
        for (uint32_t x = 0; x < viewport.width; x++) {
            uint32_t source_x = (uint32_t)((uint64_t)x * frame->width / viewport.width);
            uint32_t uv_x = source_x & ~1U;
            row[viewport.x + x] = stremio_nv12_pixel(luma[source_x],
                                                       chroma[uv_x], chroma[uv_x + 1]);
        }
    }
    framebufferEnd(&screen->framebuffer);
    return 1;
}
#endif
