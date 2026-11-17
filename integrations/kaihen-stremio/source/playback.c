#include "playback.h"

#include <stdlib.h>
#include <string.h>

static Result bad_input(void) {
    return MAKERESULT(Module_Libnx, LibnxError_BadInput);
}

Result stremio_playback_open(StremioPlayback *playback, uint32_t width, uint32_t height,
                            uint32_t frame_rate, const void *annex_b_sps_pps, size_t config_size) {
    if (!playback || !width || !height || !annex_b_sps_pps || !config_size)
        return bad_input();

    memset(playback, 0, sizeof(*playback));
    VideoDecoderConfig config = {
        .codec = ViddecCodec_H264,
        .width = width,
        .height = height,
        .frame_rate = frame_rate,
        .tiling = ViddecTilingMode_PitchLinear,
        .codec_config = annex_b_sps_pps,
        .codec_config_size = config_size,
    };
    Result rc = videoDecoderCreate(&playback->video, &config);
    if (R_FAILED(rc))
        return rc;
    playback->video_ready = true;

    rc = audoutInitialize();
    if (R_FAILED(rc)) {
        stremio_playback_close(playback);
        return rc;
    }
    playback->audio_ready = true;
    if (audoutGetSampleRate() != 48000 || audoutGetChannelCount() != 2 ||
        audoutGetPcmFormat() != PcmFormat_Int16) {
        stremio_playback_close(playback);
        return bad_input();
    }

    playback->audio_data = aligned_alloc(0x1000, STREMIO_PCM_FRAMES_PER_BUFFER * 4);
    if (!playback->audio_data) {
        stremio_playback_close(playback);
        return MAKERESULT(Module_Libnx, LibnxError_OutOfMemory);
    }
    playback->audio_buffer.buffer = playback->audio_data;
    playback->audio_buffer.buffer_size = STREMIO_PCM_FRAMES_PER_BUFFER * 4;

    rc = audoutStartAudioOut();
    if (R_FAILED(rc)) {
        stremio_playback_close(playback);
        return rc;
    }
    playback->audio_started = true;
    return 0;
}

Result stremio_playback_submit_h264(StremioPlayback *playback, const void *annex_b_access_unit,
                                   size_t size, int64_t timestamp_ns, bool end_of_stream,
                                   uint64_t timeout_ns) {
    if (!playback || !playback->video_ready || (!annex_b_access_unit && size))
        return bad_input();
    return videoDecoderSubmit(&playback->video, annex_b_access_unit, size, timestamp_ns,
                              end_of_stream, timeout_ns);
}

Result stremio_playback_next_frame(StremioPlayback *playback, VideoFrame *frame, uint64_t timeout_ns) {
    if (!playback || !playback->video_ready || !frame)
        return bad_input();
    return videoDecoderGetFrame(&playback->video, frame, timeout_ns);
}

Result stremio_playback_copy_frame(StremioPlayback *playback, const VideoFrame *frame,
                                  uint8_t *y, size_t y_pitch, uint8_t *uv, size_t uv_pitch) {
    if (!playback || !playback->video_ready || !frame || !y || !uv)
        return bad_input();
    return videoDecoderCopyFrame(&playback->video, frame, y, y_pitch, uv, uv_pitch);
}

void stremio_playback_release_frame(StremioPlayback *playback, VideoFrame *frame) {
    if (playback && playback->video_ready && frame)
        videoDecoderReleaseFrame(&playback->video, frame);
}

Result stremio_playback_play_pcm16(StremioPlayback *playback, const int16_t *stereo_frames,
                                  size_t frame_count) {
    if (!playback || !playback->audio_started || playback->audio_poisoned ||
        !stereo_frames || !frame_count || frame_count > STREMIO_PCM_FRAMES_PER_BUFFER)
        return bad_input();

    const size_t byte_count = frame_count * 2 * sizeof(*stereo_frames);
    memcpy(playback->audio_data, stereo_frames, byte_count);
    playback->audio_buffer.data_size = byte_count;
    AudioOutBuffer *released = NULL;
    Result rc = audoutPlayBuffer(&playback->audio_buffer, &released);
    if (R_FAILED(rc) || released != &playback->audio_buffer)
        playback->audio_poisoned = true;
    if (R_SUCCEEDED(rc) && released != &playback->audio_buffer)
        return bad_input();
    return rc;
}

Result stremio_playback_flush_video(StremioPlayback *playback) {
    if (!playback || !playback->video_ready)
        return bad_input();
    return videoDecoderFlush(&playback->video);
}

void stremio_playback_close(StremioPlayback *playback) {
    if (!playback)
        return;
    if (playback->audio_started) {
        audoutStopAudioOut();
        audoutFlushAudioOutBuffers(NULL);
    }
    if (playback->audio_ready)
        audoutExit();
    free(playback->audio_data);
    if (playback->video_ready)
        videoDecoderClose(&playback->video);
    memset(playback, 0, sizeof(*playback));
}
