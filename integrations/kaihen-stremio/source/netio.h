#ifndef KAIHEN_STREMIO_NETIO_H
#define KAIHEN_STREMIO_NETIO_H

#include <libavformat/avformat.h>

int stremio_avio_open(AVFormatContext *format, AVIOContext **output,
                     const char *url, int flags, AVDictionary **options);
int stremio_avio_close(AVFormatContext *format, AVIOContext *input);

#endif
