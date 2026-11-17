#include "netio.h"
#include "media.h"

#include <curl/curl.h>
#include <libavutil/mem.h>
#include <libavutil/error.h>

#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

enum {
    STREMIO_CACHE_BYTES = 256 * 1024,
    STREMIO_UNRANGED_BYTES = 16 * 1024 * 1024,
    STREMIO_AVIO_BYTES = 32 * 1024,
};

typedef struct {
    CURL *curl;
    char *url;
    uint8_t *cache;
    size_t cache_capacity;
    int64_t position;
    int64_t cache_start;
    size_t cache_length;
    int64_t file_length;
    int64_t range_start;
    long response_status;
    int range_ignored;
    int full;
} StremioNetSource;

static size_t receive_bytes(char *bytes, size_t size, size_t count, void *context) {
    StremioNetSource *source = context;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (source->response_status == 200 && length > source->cache_capacity - source->cache_length) {
        size_t target = source->cache_capacity;
        while (length > target - source->cache_length && target < STREMIO_UNRANGED_BYTES)
            target *= 2;
        if (length <= target - source->cache_length) {
            uint8_t *next = realloc(source->cache, target);
            if (!next) return 0;
            source->cache = next;
            source->cache_capacity = target;
        }
    }
    size_t remaining = source->cache_capacity - source->cache_length;
    if (length > remaining) {
        memcpy(source->cache + source->cache_length, bytes, remaining);
        source->cache_length += remaining;
        source->full = 1;
        return 0;
    }
    memcpy(source->cache + source->cache_length, bytes, length);
    source->cache_length += length;
    return length;
}

static size_t receive_header(char *bytes, size_t size, size_t count, void *context) {
    StremioNetSource *source = context;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length >= 5 && !strncasecmp(bytes, "HTTP/", 5)) {
        char *space = memchr(bytes, ' ', length);
        if (space && (size_t)(space - bytes) + 4 <= length) {
            source->response_status = strtol(space + 1, NULL, 10);
            source->range_start = -1;
        }
    } else if (length > 15 && !strncasecmp(bytes, "Content-Range:", 14)) {
        char line[128];
        unsigned long long first, last, total;
        size_t copy = length < sizeof(line) - 1 ? length : sizeof(line) - 1;
        memcpy(line, bytes, copy);
        line[copy] = 0;
        if (sscanf(line + 14, " bytes %llu-%llu/%llu", &first, &last, &total) == 3 &&
            total <= INT64_MAX && first <= last && last < total)
            source->range_start = (int64_t)first,
            source->file_length = (int64_t)total;
    }
    return length;
}

static int fetch_cache(StremioNetSource *source) {
    char range[64];
    long status = 0;
    CURLcode rc;
    curl_off_t content_length = -1;
    if (source->range_ignored) return AVERROR_EOF;
    source->cache_start = source->position;
    source->cache_length = 0;
    source->full = 0;
    source->range_start = -1;
    source->response_status = 0;
    int64_t last = source->position > INT64_MAX - (STREMIO_CACHE_BYTES - 1)
                     ? INT64_MAX : source->position + STREMIO_CACHE_BYTES - 1;
    snprintf(range, sizeof range, "%lld-%lld",
             (long long)source->position, (long long)last);
    curl_easy_setopt(source->curl, CURLOPT_RANGE, range);
    rc = curl_easy_perform(source->curl);
    curl_easy_getinfo(source->curl, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_getinfo(source->curl, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &content_length);
    if (status == 416) return AVERROR_EOF;
    if ((rc != CURLE_OK && !(rc == CURLE_WRITE_ERROR && source->full && status == 200)) ||
        (status != 200 && status != 206)) return AVERROR(EIO);
    if (status == 200) {
        source->range_ignored = 1;
        if (source->position != 0) return AVERROR(ENOSYS);
        if (source->full) return AVERROR(ENOSYS);
        source->file_length = (int64_t)source->cache_length;
        if (content_length >= 0 && content_length != source->file_length) return AVERROR(EIO);
    } else if (source->range_start != source->position) {
        return AVERROR_INVALIDDATA;
    }
    if (source->cache_length == 0) return AVERROR_EOF;
    return 0;
}

static int read_packet(void *opaque, uint8_t *buffer, int buffer_size) {
    StremioNetSource *source = opaque;
    if (!source || !buffer || buffer_size <= 0) return AVERROR(EINVAL);
    if (source->range_ignored && source->position >= source->file_length) return AVERROR_EOF;
    if (source->position < source->cache_start ||
        source->position - source->cache_start >= (int64_t)source->cache_length) {
        int rc = fetch_cache(source);
        if (rc < 0) return rc;
    }
    size_t offset = (size_t)(source->position - source->cache_start);
    size_t available = source->cache_length - offset;
    size_t length = (size_t)buffer_size < available ? (size_t)buffer_size : available;
    memcpy(buffer, source->cache + offset, length);
    source->position += (int64_t)length;
    return (int)length;
}

static int64_t seek_packet(void *opaque, int64_t offset, int whence) {
    StremioNetSource *source = opaque;
    int64_t base;
    if (!source) return AVERROR(EINVAL);
    if (whence == AVSEEK_SIZE) {
        if (source->file_length < 0 && fetch_cache(source) < 0) return AVERROR(ENOSYS);
        return source->file_length >= 0 ? source->file_length : AVERROR(ENOSYS);
    }
    switch (whence & ~AVSEEK_FORCE) {
        case SEEK_SET: base = 0; break;
        case SEEK_CUR: base = source->position; break;
        case SEEK_END:
            if (source->file_length < 0) return AVERROR(ENOSYS);
            base = source->file_length;
            break;
        default: return AVERROR(EINVAL);
    }
    if ((offset > 0 && base > INT64_MAX - offset) ||
        (offset < 0 && base < INT64_MIN - offset)) return AVERROR(EINVAL);
    int64_t position = base + offset;
    if (position < 0 || (source->range_ignored && position > source->file_length))
        return AVERROR(EINVAL);
    source->position = position;
    return position;
}

int stremio_avio_open(AVFormatContext *format, AVIOContext **output,
                     const char *url, int flags, AVDictionary **options) {
    StremioNetSource *source;
    uint8_t *buffer;
    AVIOContext *io;
    (void)format;
    (void)options;
    if (!output || !(flags & AVIO_FLAG_READ) || (flags & AVIO_FLAG_WRITE) ||
        !stremio_media_https_url(url))
        return AVERROR(EINVAL);
    source = calloc(1, sizeof(*source));
    if (!source) return AVERROR(ENOMEM);
    source->url = malloc(strlen(url) + 1);
    if (source->url) strcpy(source->url, url);
    source->cache = malloc(STREMIO_CACHE_BYTES);
    source->cache_capacity = STREMIO_CACHE_BYTES;
    source->curl = curl_easy_init();
    source->file_length = -1;
    if (!source->url || !source->cache || !source->curl) {
        curl_easy_cleanup(source->curl);
        free(source->cache);
        free(source->url);
        free(source);
        return AVERROR(ENOMEM);
    }
    curl_easy_setopt(source->curl, CURLOPT_URL, source->url);
#if LIBCURL_VERSION_NUM >= 0x075500
    curl_easy_setopt(source->curl, CURLOPT_PROTOCOLS_STR, "https");
    curl_easy_setopt(source->curl, CURLOPT_REDIR_PROTOCOLS_STR, "https");
#else
    curl_easy_setopt(source->curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    curl_easy_setopt(source->curl, CURLOPT_REDIR_PROTOCOLS, CURLPROTO_HTTPS);
#endif
    curl_easy_setopt(source->curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(source->curl, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(source->curl, CURLOPT_CONNECTTIMEOUT, 10L);
    curl_easy_setopt(source->curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(source->curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(source->curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(source->curl, CURLOPT_USERAGENT, "kaihen-stremio/0.2");
    curl_easy_setopt(source->curl, CURLOPT_WRITEFUNCTION, receive_bytes);
    curl_easy_setopt(source->curl, CURLOPT_WRITEDATA, source);
    curl_easy_setopt(source->curl, CURLOPT_HEADERFUNCTION, receive_header);
    curl_easy_setopt(source->curl, CURLOPT_HEADERDATA, source);
    int initial = fetch_cache(source);
    if (initial < 0) {
        curl_easy_cleanup(source->curl);
        free(source->cache);
        free(source->url);
        free(source);
        return initial;
    }
    buffer = av_malloc(STREMIO_AVIO_BYTES);
    if (!buffer) {
        curl_easy_cleanup(source->curl);
        free(source->cache);
        free(source->url);
        free(source);
        return AVERROR(ENOMEM);
    }
    io = avio_alloc_context(buffer, STREMIO_AVIO_BYTES, 0, source,
                            read_packet, NULL, seek_packet);
    if (!io) {
        av_free(buffer);
        curl_easy_cleanup(source->curl);
        free(source->cache);
        free(source->url);
        free(source);
        return AVERROR(ENOMEM);
    }
    io->seekable = AVIO_SEEKABLE_NORMAL;
    *output = io;
    return 0;
}

int stremio_avio_close(AVFormatContext *format, AVIOContext *input) {
    (void)format;
    if (!input) return 0;
    StremioNetSource *source = input->opaque;
    av_freep(&input->buffer);
    avio_context_free(&input);
    if (source) {
        curl_easy_cleanup(source->curl);
        free(source->cache);
        free(source->url);
        free(source);
    }
    return 0;
}
