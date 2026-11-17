#include "playback.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int decoder_creates;
static int decoder_closes;
static int decoder_submits;
static int audio_initializes;
static int audio_exits;
static int audio_starts;
static int audio_stops;
static int audio_plays;
static Result audio_initialize_result;

Result videoDecoderCreate(VideoDecoder *decoder, const VideoDecoderConfig *config) {
    assert(config->codec == ViddecCodec_H264);
    assert(config->tiling == ViddecTilingMode_PitchLinear);
    assert(config->codec_config_size > 0);
    decoder->active = 1;
    decoder_creates++;
    return 0;
}

Result videoDecoderSubmit(VideoDecoder *decoder, const void *sample, size_t size,
                          int64_t timestamp_ns, bool end_of_stream, uint64_t timeout_ns) {
    assert(decoder->active && sample && size && timestamp_ns == 42);
    assert(!end_of_stream && timeout_ns == 100);
    decoder_submits++;
    return 0;
}

Result videoDecoderGetFrame(VideoDecoder *decoder, VideoFrame *frame, uint64_t timeout_ns) {
    assert(decoder->active && timeout_ns == 100);
    frame->width = 16;
    frame->height = 16;
    return 0;
}

Result videoDecoderCopyFrame(VideoDecoder *decoder, const VideoFrame *frame,
                             uint8_t *y, size_t y_pitch, uint8_t *uv, size_t uv_pitch) {
    assert(decoder->active && frame->width == 16);
    assert(y && uv && y_pitch == 16 && uv_pitch == 16);
    return 0;
}

void videoDecoderReleaseFrame(VideoDecoder *decoder, VideoFrame *frame) {
    assert(decoder->active);
    frame->width = 0;
}

Result videoDecoderFlush(VideoDecoder *decoder) {
    assert(decoder->active);
    return 0;
}

void videoDecoderClose(VideoDecoder *decoder) {
    assert(decoder->active);
    decoder->active = 0;
    decoder_closes++;
}

Result audoutInitialize(void) {
    audio_initializes++;
    return audio_initialize_result;
}

void audoutExit(void) { audio_exits++; }
uint32_t audoutGetSampleRate(void) { return 48000; }
uint32_t audoutGetChannelCount(void) { return 2; }
int audoutGetPcmFormat(void) { return PcmFormat_Int16; }
Result audoutStartAudioOut(void) { audio_starts++; return 0; }
Result audoutStopAudioOut(void) { audio_stops++; return 0; }
Result audoutFlushAudioOutBuffers(bool *flushed) {
    if (flushed) *flushed = true;
    return 0;
}

Result audoutPlayBuffer(AudioOutBuffer *source, AudioOutBuffer **released) {
    assert((uintptr_t)source->buffer % 0x1000 == 0);
    assert(source->data_size == 16 && source->buffer_size == 16384);
    audio_plays++;
    *released = source;
    return 0;
}

int main(void) {
    const uint8_t codec_config[] = {0, 0, 0, 1, 0x67};
    const uint8_t sample[] = {0, 0, 0, 1, 0x65};
    StremioPlayback playback;
    assert(stremio_playback_open(&playback, 1280, 720, 30, codec_config,
                                sizeof(codec_config)) == 0);
    assert(playback.video_ready && playback.audio_started);
    assert(stremio_playback_submit_h264(&playback, sample, sizeof(sample), 42, false, 100) == 0);
    VideoFrame frame = {0};
    assert(stremio_playback_next_frame(&playback, &frame, 100) == 0);
    uint8_t y[256] = {0}, uv[128] = {0};
    assert(stremio_playback_copy_frame(&playback, &frame, y, 16, uv, 16) == 0);
    stremio_playback_release_frame(&playback, &frame);
    assert(frame.width == 0);
    int16_t pcm[8] = {0};
    assert(stremio_playback_play_pcm16(&playback, pcm, 4) == 0);
    assert(stremio_playback_play_pcm16(&playback, pcm, 0) != 0);
    assert(stremio_playback_flush_video(&playback) == 0);
    stremio_playback_close(&playback);
    assert(decoder_creates == 1 && decoder_closes == 1 && decoder_submits == 1);
    assert(audio_initializes == 1 && audio_exits == 1 && audio_starts == 1);
    assert(audio_stops == 1 && audio_plays == 1);

    audio_initialize_result = 17;
    assert(stremio_playback_open(&playback, 1280, 720, 30, codec_config,
                                sizeof(codec_config)) == 17);
    assert(decoder_creates == 2 && decoder_closes == 2 && audio_exits == 1);
    assert(stremio_playback_open(&playback, 0, 720, 30, codec_config,
                                sizeof(codec_config)) != 0);
    puts("playback scaffold checks passed");
    return 0;
}
