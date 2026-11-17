#include "artwork.h"

#include <curl/curl.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>

#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
    STREMIO_ARTWORK_DOWNLOAD_LIMIT = 8 * 1024 * 1024,
    STREMIO_ARTWORK_SOURCE_PIXELS = 16 * 1024 * 1024,
    STREMIO_ARTWORK_OUTPUT_PIXELS = 2 * 1024 * 1024,
    STREMIO_ARTWORK_MAX_EDGE = 2048
};

typedef struct {
    uint8_t *bytes;
    size_t length;
    size_t capacity;
} ArtworkDownload;

static size_t receive_artwork(char *bytes, size_t size, size_t count, void *opaque) {
    ArtworkDownload *download = opaque;
    size_t length;
    size_t capacity;
    uint8_t *next;
    if (!download || (size && count > SIZE_MAX / size)) return 0;
    length = size * count;
    if (length > STREMIO_ARTWORK_DOWNLOAD_LIMIT - download->length) return 0;
    if (length > download->capacity - download->length) {
        capacity = download->capacity ? download->capacity : 64 * 1024;
        while (length > capacity - download->length &&
               capacity < STREMIO_ARTWORK_DOWNLOAD_LIMIT) capacity *= 2;
        if (capacity > STREMIO_ARTWORK_DOWNLOAD_LIMIT)
            capacity = STREMIO_ARTWORK_DOWNLOAD_LIMIT;
        if (length > capacity - download->length) return 0;
        next = realloc(download->bytes, capacity);
        if (!next) return 0;
        download->bytes = next;
        download->capacity = capacity;
    }
    memcpy(download->bytes + download->length, bytes, length);
    download->length += length;
    return length;
}

static int download_artwork(const char *url, ArtworkDownload *download) {
    CURL *curl;
    CURLcode result;
    long status = 0;
    if (!url || !download ||
        ((strncmp(url, "https://", 8) || !url[8]) &&
         (strncmp(url, "http://", 7) || !url[7]))) return 0;
    curl = curl_easy_init();
    if (!curl) return 0;
    curl_easy_setopt(curl, CURLOPT_URL, url);
#if LIBCURL_VERSION_NUM >= 0x075500
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
    curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
#else
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTP | CURLPROTO_HTTPS);
    curl_easy_setopt(curl, CURLOPT_REDIR_PROTOCOLS, CURLPROTO_HTTP | CURLPROTO_HTTPS);
#endif
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 5L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 4L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 8L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "kaihen-stremio/0.2");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive_artwork);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, download);
    result = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_cleanup(curl);
    return result == CURLE_OK && status == 200 && download->length > 0;
}

static enum AVCodecID artwork_codec(const ArtworkDownload *download) {
    const uint8_t *bytes = download->bytes;
    size_t length = download->length;
    if (length >= 8 && !memcmp(bytes, "\x89PNG\r\n\x1a\n", 8)) return AV_CODEC_ID_PNG;
    if (length >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff)
        return AV_CODEC_ID_MJPEG;
    if (length >= 12 && !memcmp(bytes, "RIFF", 4) && !memcmp(bytes + 8, "WEBP", 4))
        return AV_CODEC_ID_WEBP;
    return AV_CODEC_ID_NONE;
}

static int fit_artwork(int width, int height, uint32_t max_width, uint32_t max_height,
                       int *out_width, int *out_height) {
    uint64_t scaled;
    if (width <= 0 || height <= 0 || max_width == 0 || max_height == 0 ||
        max_width > STREMIO_ARTWORK_MAX_EDGE || max_height > STREMIO_ARTWORK_MAX_EDGE ||
        (uint64_t)max_width * max_height > STREMIO_ARTWORK_OUTPUT_PIXELS) return 0;
    if ((uint64_t)width * max_height > (uint64_t)height * max_width) {
        *out_width = width < (int)max_width ? width : (int)max_width;
        scaled = (uint64_t)height * (uint32_t)*out_width / (uint32_t)width;
        *out_height = scaled ? (int)scaled : 1;
    } else {
        *out_height = height < (int)max_height ? height : (int)max_height;
        scaled = (uint64_t)width * (uint32_t)*out_height / (uint32_t)height;
        *out_width = scaled ? (int)scaled : 1;
    }
    return *out_width > 0 && *out_height > 0 &&
           *out_width <= (int)max_width && *out_height <= (int)max_height &&
           (uint64_t)*out_width * *out_height <= STREMIO_ARTWORK_OUTPUT_PIXELS;
}

static int decode_artwork(const ArtworkDownload *download, uint32_t max_width,
                          uint32_t max_height, StremioArtwork *out) {
    const AVCodec *codec;
    AVCodecContext *context = NULL;
    AVPacket *packet = NULL;
    AVFrame *frame = NULL;
    struct SwsContext *scaler = NULL;
    uint32_t *pixels = NULL;
    uint8_t *planes[4];
    int lines[4];
    int width, height;
    int ok = 0;
    enum AVCodecID codec_id = artwork_codec(download);
    if (codec_id == AV_CODEC_ID_NONE || download->length > INT_MAX) return 0;
    codec = avcodec_find_decoder(codec_id);
    if (!codec) return 0;
    context = avcodec_alloc_context3(codec);
    packet = av_packet_alloc();
    frame = av_frame_alloc();
    if (!context || !packet || !frame) goto done;
    context->max_pixels = STREMIO_ARTWORK_SOURCE_PIXELS;
    if (avcodec_open2(context, codec, NULL) < 0 ||
        av_new_packet(packet, (int)download->length) < 0) goto done;
    memcpy(packet->data, download->bytes, download->length);
    if (avcodec_send_packet(context, packet) < 0 || avcodec_receive_frame(context, frame) < 0 ||
        frame->width <= 0 || frame->height <= 0 ||
        (uint64_t)frame->width * frame->height > STREMIO_ARTWORK_SOURCE_PIXELS ||
        !fit_artwork(frame->width, frame->height, max_width, max_height, &width, &height))
        goto done;
    pixels = malloc((size_t)width * height * sizeof(*pixels));
    if (!pixels) goto done;
    scaler = sws_getContext(frame->width, frame->height, (enum AVPixelFormat)frame->format,
                            width, height, AV_PIX_FMT_RGBA, SWS_BILINEAR,
                            NULL, NULL, NULL);
    if (!scaler) goto done;
    planes[0] = (uint8_t *)pixels;
    planes[1] = planes[2] = planes[3] = NULL;
    lines[0] = width * 4;
    lines[1] = lines[2] = lines[3] = 0;
    if (sws_scale(scaler, (const uint8_t *const *)frame->data, frame->linesize,
                  0, frame->height, planes, lines) != height) goto done;
    out->pixels = pixels;
    out->width = (uint32_t)width;
    out->height = (uint32_t)height;
    out->stride = (uint32_t)width;
    pixels = NULL;
    ok = 1;
done:
    free(pixels);
    sws_freeContext(scaler);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&context);
    return ok;
}

int stremio_artwork_fetch(const char *url, uint32_t max_width, uint32_t max_height,
                          StremioArtwork *out) {
    ArtworkDownload download = {0};
    int ok;
    if (!out) return 0;
    memset(out, 0, sizeof(*out));
    if (!download_artwork(url, &download)) {
        free(download.bytes);
        return 0;
    }
    ok = decode_artwork(&download, max_width, max_height, out);
    free(download.bytes);
    return ok;
}

void stremio_artwork_release(StremioArtwork *artwork) {
    if (!artwork) return;
    free((void *)artwork->pixels);
    memset(artwork, 0, sizeof(*artwork));
}
