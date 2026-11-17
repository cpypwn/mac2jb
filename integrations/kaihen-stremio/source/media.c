#include "media.h"

#include <ctype.h>
#include <string.h>
#include <strings.h>

int stremio_media_https_url(const char *url) {
    const char *host;
    const char *end;
    if (!url || strncmp(url, "https://", 8)) return 0;
    host = url + 8;
    if (!*host) return 0;
    end = host + strcspn(host, "/?#");
    if (host == end) return 0;
    for (const char *p = host; p < end; p++) {
        if (!isalnum((unsigned char)*p) && *p != '.' && *p != '-' && *p != ':') return 0;
    }
    for (const char *p = end; *p; p++) {
        if ((unsigned char)*p <= 0x20 || (unsigned char)*p == 0x7f) return 0;
    }
    return 1;
}

static int mime_is(const char *actual, const char *expected) {
    size_t length;
    if (!actual) return 0;
    length = strlen(expected);
    if (strncasecmp(actual, expected, length)) return 0;
    return !actual[length] || actual[length] == ';' || isspace((unsigned char)actual[length]);
}

StremioMediaKind stremio_media_detect(const char *content_type,
                                     const uint8_t *bytes, size_t length) {
    if (bytes && length >= 7 && !memcmp(bytes, "#EXTM3U", 7)) return StremioMedia_Hls;
    if (bytes && length >= 12 && !memcmp(bytes + 4, "ftyp", 4)) return StremioMedia_Mp4;
    if (bytes && length >= 189 && bytes[0] == 0x47 && bytes[188] == 0x47)
        return StremioMedia_MpegTs;
    if (mime_is(content_type, "application/vnd.apple.mpegurl") ||
        mime_is(content_type, "application/x-mpegurl")) return StremioMedia_Hls;
    if (mime_is(content_type, "video/mp4")) return StremioMedia_Mp4;
    if (mime_is(content_type, "video/mp2t")) return StremioMedia_MpegTs;
    return StremioMedia_Unknown;
}

const char *stremio_media_name(StremioMediaKind kind) {
    switch (kind) {
        case StremioMedia_Hls: return "HLS";
        case StremioMedia_Mp4: return "MP4";
        case StremioMedia_MpegTs: return "MPEG-TS";
        default: return "unsupported media";
    }
}
