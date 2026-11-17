#ifndef KAIHEN_STREMIO_MEDIA_H
#define KAIHEN_STREMIO_MEDIA_H

#include <stddef.h>
#include <stdint.h>

typedef enum {
    StremioMedia_Unknown,
    StremioMedia_Hls,
    StremioMedia_Mp4,
    StremioMedia_MpegTs,
} StremioMediaKind;

int stremio_media_https_url(const char *url);
StremioMediaKind stremio_media_detect(const char *content_type,
                                     const uint8_t *bytes, size_t length);
const char *stremio_media_name(StremioMediaKind kind);

#endif
