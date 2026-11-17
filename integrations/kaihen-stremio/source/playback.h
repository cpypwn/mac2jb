#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <switch.h>
#ifdef __SWITCH__
#include <switch2/video/decoder.h>
#endif

enum { STREMIO_PCM_FRAMES_PER_BUFFER = 4096 };

typedef struct {
    VideoDecoder video;
    AudioOutBuffer audio_buffer;
    void *audio_data;
    bool video_ready;
    bool audio_ready;
    bool audio_started;
    bool audio_poisoned;
} StremioPlayback;

Result stremio_playback_open(StremioPlayback *playback, uint32_t width, uint32_t height,
                            uint32_t frame_rate, const void *annex_b_sps_pps, size_t config_size);
// submit one annex b access unit; the caller owns container parsing and timestamps.
Result stremio_playback_submit_h264(StremioPlayback *playback, const void *annex_b_access_unit,
                                   size_t size, int64_t timestamp_ns, bool end_of_stream,
                                   uint64_t timeout_ns);
Result stremio_playback_next_frame(StremioPlayback *playback, VideoFrame *frame, uint64_t timeout_ns);
Result stremio_playback_copy_frame(StremioPlayback *playback, const VideoFrame *frame,
                                  uint8_t *y, size_t y_pitch, uint8_t *uv, size_t uv_pitch);
void stremio_playback_release_frame(StremioPlayback *playback, VideoFrame *frame);
// pcm is 48 khz stereo int16; call from an audio worker because this blocks until played.
Result stremio_playback_play_pcm16(StremioPlayback *playback, const int16_t *stereo_frames,
                                  size_t frame_count);
Result stremio_playback_flush_video(StremioPlayback *playback);
void stremio_playback_close(StremioPlayback *playback);
