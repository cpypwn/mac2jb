#include "session.h"
#include "display.h"
#include "h264.h"
#include "media.h"
#include "netio.h"
#include "playback.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_VIDEO_PACKET = 4 * 1024 * 1024 };

typedef struct {
    AVFormatContext *format;
    AVCodecContext *audio_decoder;
    SwrContext *resampler;
    AVFrame *audio_frame;
    AVPacket *packet;
    StremioPlayback playback;
    StremioVideoScreen screen;
    uint8_t *annex_b;
    size_t annex_b_capacity;
    unsigned nal_length_size;
    int video_index;
    int audio_index;
    int video_ended;
    int stopped_by_user;
    int clock_ready;
    int64_t clock_pts_ns;
    uint64_t clock_wall_ns;
} NativeSession;

static void fail(char *status, size_t size, const char *message, int code) {
    if (!status || !size) return;
    if (code < 0) {
        char reason[96];
        av_strerror(code, reason, sizeof reason);
        snprintf(status, size, "%s: %s", message, reason);
    } else {
        snprintf(status, size, "%s", message);
    }
}

static int stopped(PadState *pad) {
    padUpdate(pad);
    uint64_t down = padGetButtonsDown(pad);
    return (down & (HidNpadButton_B | HidNpadButton_Minus | HidNpadButton_Plus)) != 0;
}

static void anchor_clock(NativeSession *session, int64_t pts_ns) {
    if (!session->clock_ready && pts_ns >= 0) {
        session->clock_ready = 1;
        session->clock_pts_ns = pts_ns;
        session->clock_wall_ns = armTicksToNs(armGetSystemTick());
    }
}

static void pace_video(NativeSession *session, PadState *pad, int64_t pts_ns) {
    if (pts_ns < 0) return;
    anchor_clock(session, pts_ns);
    uint64_t now = armTicksToNs(armGetSystemTick());
    int64_t media_elapsed = pts_ns - session->clock_pts_ns;
    int64_t wall_elapsed = now >= session->clock_wall_ns
                         ? (int64_t)(now - session->clock_wall_ns) : 0;
    if (media_elapsed < -1000000000LL || media_elapsed > wall_elapsed + 30000000000LL) {
        session->clock_pts_ns = pts_ns;
        session->clock_wall_ns = now;
        return;
    }
    while (media_elapsed > wall_elapsed && appletMainLoop()) {
        if (stopped(pad)) {
            session->stopped_by_user = 1;
            return;
        }
        int64_t remaining = media_elapsed - wall_elapsed;
        svcSleepThread(remaining < 10000000LL ? remaining : 10000000LL);
        now = armTicksToNs(armGetSystemTick());
        wall_elapsed = now >= session->clock_wall_ns
                     ? (int64_t)(now - session->clock_wall_ns) : 0;
    }
    if (media_elapsed > wall_elapsed) session->stopped_by_user = 1;
}

static int audio_output(NativeSession *session, const AVFrame *frame) {
    int capacity = swr_get_out_samples(session->resampler, frame->nb_samples);
    if (capacity <= 0 || capacity > 65536) return AVERROR(EINVAL);
    int16_t *pcm = malloc((size_t)capacity * 2 * sizeof(*pcm));
    if (!pcm) return AVERROR(ENOMEM);
    uint8_t *output[] = {(uint8_t *)pcm};
    int count = swr_convert(session->resampler, output, capacity,
                            (const uint8_t * const *)frame->extended_data, frame->nb_samples);
    if (count < 0) {
        free(pcm);
        return count;
    }
    for (int offset = 0; offset < count;) {
        int frames = count - offset;
        if (frames > STREMIO_PCM_FRAMES_PER_BUFFER) frames = STREMIO_PCM_FRAMES_PER_BUFFER;
        Result rc = stremio_playback_play_pcm16(&session->playback, pcm + offset * 2, (size_t)frames);
        if (R_FAILED(rc)) {
            free(pcm);
            return AVERROR(EIO);
        }
        offset += frames;
    }
    free(pcm);
    return 0;
}

static int audio_packet(NativeSession *session, const AVPacket *packet) {
    int rc = avcodec_send_packet(session->audio_decoder, packet);
    if (rc < 0) return rc;
    for (;;) {
        rc = avcodec_receive_frame(session->audio_decoder, session->audio_frame);
        if (rc == AVERROR(EAGAIN) || rc == AVERROR_EOF) return 0;
        if (rc < 0) return rc;
        if (session->audio_frame->best_effort_timestamp != AV_NOPTS_VALUE)
            anchor_clock(session, av_rescale_q(session->audio_frame->best_effort_timestamp,
                         session->format->streams[session->audio_index]->time_base,
                         (AVRational){1, 1000000000}));
        rc = audio_output(session, session->audio_frame);
        av_frame_unref(session->audio_frame);
        if (rc < 0) return rc;
    }
}

static int present_available(NativeSession *session, PadState *pad, uint64_t timeout_ns) {
    VideoFrame frame = {0};
    for (;;) {
        Result rc = stremio_playback_next_frame(&session->playback, &frame, timeout_ns);
        if (rc == KERNELRESULT(TimedOut)) return 0;
        if (R_FAILED(rc)) return AVERROR(EIO);
        int end_of_stream = frame.end_of_stream;
        if (!end_of_stream) pace_video(session, pad, frame.timestamp_ns);
        if (!end_of_stream && !session->stopped_by_user &&
            !stremio_video_present(&session->screen, &frame)) {
            stremio_playback_release_frame(&session->playback, &frame);
            return AVERROR(EIO);
        }
        stremio_playback_release_frame(&session->playback, &frame);
        timeout_ns = 0;
        if (end_of_stream) {
            session->video_ended = 1;
            return 0;
        }
        if (session->stopped_by_user) return 0;
    }
}

static int video_packet(NativeSession *session, const AVPacket *packet,
                        const AVStream *stream, PadState *pad) {
    if (packet->size <= 0 || packet->size > MAX_VIDEO_PACKET) return AVERROR(EINVAL);
    size_t required = (size_t)packet->size * 5 + 16;
    if (required > session->annex_b_capacity) {
        uint8_t *next = realloc(session->annex_b, required);
        if (!next) return AVERROR(ENOMEM);
        session->annex_b = next;
        session->annex_b_capacity = required;
    }
    size_t size = 0;
    if (!stremio_h264_access_unit(packet->data, (size_t)packet->size,
                                  session->nal_length_size, session->annex_b,
                                  session->annex_b_capacity, &size)) return AVERROR_INVALIDDATA;
    int64_t pts = packet->pts == AV_NOPTS_VALUE ? packet->dts : packet->pts;
    int64_t timestamp_ns = pts == AV_NOPTS_VALUE ? 0 : av_rescale_q(pts, stream->time_base,
                                                                      (AVRational){1, 1000000000});
    Result rc = stremio_playback_submit_h264(&session->playback, session->annex_b, size,
                                              timestamp_ns, false, 1000000000ULL);
    if (R_FAILED(rc)) return AVERROR(EIO);
    return present_available(session, pad, 0);
}

static int open_audio(NativeSession *session, AVStream *stream) {
    const AVCodec *codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) return AVERROR_DECODER_NOT_FOUND;
    session->audio_decoder = avcodec_alloc_context3(codec);
    if (!session->audio_decoder) return AVERROR(ENOMEM);
    int rc = avcodec_parameters_to_context(session->audio_decoder, stream->codecpar);
    if (rc < 0) return rc;
    rc = avcodec_open2(session->audio_decoder, codec, NULL);
    if (rc < 0) return rc;
    AVChannelLayout stereo;
    av_channel_layout_default(&stereo, 2);
    rc = swr_alloc_set_opts2(&session->resampler, &stereo, AV_SAMPLE_FMT_S16, 48000,
                              &session->audio_decoder->ch_layout,
                              session->audio_decoder->sample_fmt,
                              session->audio_decoder->sample_rate, 0, NULL);
    av_channel_layout_uninit(&stereo);
    if (rc < 0) return rc;
    return swr_init(session->resampler);
}

static int open_video(NativeSession *session, AVStream *stream) {
    AVCodecParameters *video = stream->codecpar;
    if (video->codec_id != AV_CODEC_ID_H264 || video->width < 16 || video->height < 16 ||
        video->width > 3840 || video->height > 2160) return AVERROR(ENOSYS);
    uint8_t config[4096];
    size_t config_size = 0;
    if (!stremio_h264_config(video->extradata, (size_t)video->extradata_size,
                             config, sizeof config, &config_size,
                             &session->nal_length_size)) return AVERROR_INVALIDDATA;
    AVRational frame_rate = av_guess_frame_rate(session->format, stream, NULL);
    uint32_t fps = frame_rate.num > 0 && frame_rate.den > 0
                 ? (uint32_t)av_rescale(frame_rate.num, 1, frame_rate.den) : 30;
    if (!fps) fps = 30;
    if (fps > 60) return AVERROR(ENOSYS);
    Result rc = stremio_playback_open(&session->playback, (uint32_t)video->width,
                                     (uint32_t)video->height, fps, config, config_size);
    return R_SUCCEEDED(rc) ? 0 : AVERROR(EIO);
}

static void close_session(NativeSession *session) {
    stremio_video_screen_close(&session->screen);
    stremio_playback_close(&session->playback);
    av_packet_free(&session->packet);
    av_frame_free(&session->audio_frame);
    swr_free(&session->resampler);
    avcodec_free_context(&session->audio_decoder);
    avformat_close_input(&session->format);
    free(session->annex_b);
}

int stremio_native_play(const char *url, uint64_t resume_ms, PadState *pad,
                        char *status, size_t status_size) {
    NativeSession session = {.video_index = -1, .audio_index = -1};
    AVDictionary *options = NULL;
    int rc = 0;
    if (!url || !stremio_media_https_url(url) || !pad) {
        fail(status, status_size, "Select a direct HTTPS stream", 0);
        return 0;
    }
    if (strstr(url, ".m3u8") && !avio_find_protocol_name(url)) {
        fail(status, status_size, "HLS needs FFmpeg HTTPS protocol support", 0);
        return 0;
    }
    session.format = avformat_alloc_context();
    if (!session.format) { rc = AVERROR(ENOMEM); goto done; }
    session.format->io_open = stremio_avio_open;
    session.format->io_close2 = stremio_avio_close;
    av_dict_set(&options, "http_persistent", "0", 0);
    av_dict_set(&options, "http_multiple", "0", 0);
    rc = avformat_open_input(&session.format, url, NULL, &options);
    av_dict_free(&options);
    if (rc < 0) goto done;
    rc = avformat_find_stream_info(session.format, NULL);
    if (rc < 0) goto done;
    session.video_index = av_find_best_stream(session.format, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    session.audio_index = av_find_best_stream(session.format, AVMEDIA_TYPE_AUDIO, -1,
                                               session.video_index, NULL, 0);
    if (session.video_index < 0) { rc = AVERROR_STREAM_NOT_FOUND; goto done; }
    rc = open_video(&session, session.format->streams[session.video_index]);
    if (rc < 0) goto done;
    if (session.audio_index >= 0) {
        rc = open_audio(&session, session.format->streams[session.audio_index]);
        if (rc < 0) {
            swr_free(&session.resampler);
            avcodec_free_context(&session.audio_decoder);
            session.audio_index = -1;
        }
    }
    session.audio_frame = av_frame_alloc();
    session.packet = av_packet_alloc();
    if (!session.audio_frame || !session.packet) { rc = AVERROR(ENOMEM); goto done; }
    if (resume_ms > 0 && resume_ms <= (uint64_t)INT64_MAX / 1000) {
        AVStream *video = session.format->streams[session.video_index];
        int64_t timestamp = av_rescale_q((int64_t)resume_ms, (AVRational){1, 1000},
                                          video->time_base);
        av_seek_frame(session.format, session.video_index, timestamp, AVSEEK_FLAG_BACKWARD);
    }
    if (R_FAILED(stremio_video_screen_open(&session.screen))) { rc = AVERROR(EIO); goto done; }
    while (appletMainLoop()) {
        if (session.stopped_by_user || stopped(pad)) { session.stopped_by_user = 1; rc = 0; break; }
        rc = av_read_frame(session.format, session.packet);
        if (rc == AVERROR_EOF) { rc = 0; break; }
        if (rc < 0) break;
        if (session.packet->stream_index == session.video_index)
            rc = video_packet(&session, session.packet, session.format->streams[session.video_index], pad);
        else if (session.packet->stream_index == session.audio_index)
            rc = audio_packet(&session, session.packet);
        else rc = 0;
        av_packet_unref(session.packet);
        if (rc < 0) break;
    }
    if (rc == 0 && !session.stopped_by_user) {
        Result end_rc = stremio_playback_submit_h264(&session.playback, NULL, 0, 0, true,
                                                      1000000000ULL);
        if (R_FAILED(end_rc)) rc = AVERROR(EIO);
        for (int i = 0; rc == 0 && !session.video_ended && i < 10; i++)
            rc = present_available(&session, pad, 100000000ULL);
    }
done:
    fail(status, status_size, rc < 0 ? "Playback stopped" : "Playback ended", rc);
    close_session(&session);
    return rc >= 0;
}
