#include "media.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    uint8_t mp4[] = {0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'};
    uint8_t ts[376] = {0};
    ts[0] = ts[188] = 0x47;
    assert(stremio_media_https_url("https://video.example/stream.m3u8?token=abc"));
    assert(stremio_media_https_url("https://video.example:443/file.mp4"));
    assert(!stremio_media_https_url("http://video.example/file.mp4"));
    assert(!stremio_media_https_url("https://user@video.example/file.mp4"));
    assert(!stremio_media_https_url("https:///file.mp4"));
    assert(!stremio_media_https_url("https://video.example/file.mp4\nHeader: bad"));
    assert(stremio_media_detect(NULL, (const uint8_t *)"#EXTM3U\n", 8) == StremioMedia_Hls);
    assert(stremio_media_detect("application/octet-stream", mp4, sizeof mp4) == StremioMedia_Mp4);
    assert(stremio_media_detect(NULL, ts, sizeof ts) == StremioMedia_MpegTs);
    assert(stremio_media_detect("video/mp4; charset=binary", NULL, 0) == StremioMedia_Mp4);
    assert(stremio_media_detect("application/vnd.apple.mpegurl", NULL, 0) == StremioMedia_Hls);
    assert(stremio_media_detect("text/plain", (const uint8_t *)"hello", 5) == StremioMedia_Unknown);
    assert(!strcmp(stremio_media_name(StremioMedia_Mp4), "MP4"));
    puts("media intake checks passed");
    return 0;
}
