#ifndef KAIHEN_STREMIO_DISPLAY_H
#define KAIHEN_STREMIO_DISPLAY_H

#include <stdint.h>

typedef struct {
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
} StremioViewport;

int stremio_viewport(uint32_t screen_width, uint32_t screen_height,
                     uint32_t image_width, uint32_t image_height,
                     StremioViewport *out);
uint32_t stremio_nv12_pixel(uint8_t y, uint8_t u, uint8_t v);

#ifdef __SWITCH__
#include <switch.h>
#include <switch2/video/decoder.h>

typedef struct {
    Framebuffer framebuffer;
    uint32_t width;
    uint32_t height;
    int ready;
} StremioVideoScreen;

Result stremio_video_screen_open(StremioVideoScreen *screen);
void stremio_video_screen_close(StremioVideoScreen *screen);
int stremio_video_present(StremioVideoScreen *screen, const VideoFrame *frame);
#endif

#endif
