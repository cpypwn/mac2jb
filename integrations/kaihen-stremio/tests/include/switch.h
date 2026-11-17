#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef uint32_t Result;
typedef uint64_t u64;
typedef struct { int unused; } PadState;
typedef struct { int unused; } Framebuffer;

enum { Module_Libnx = 1, LibnxError_BadInput = 2, LibnxError_OutOfMemory = 3 };
enum { ViddecCodec_H264 = 0, ViddecTilingMode_PitchLinear = 1, PcmFormat_Int16 = 2 };

#define MAKERESULT(module, error) ((Result)(((module) << 8) | (error)))
#define R_FAILED(result) ((result) != 0)
#define R_SUCCEEDED(result) ((result) == 0)

enum { HidNpadStyleSet_NpadStandard = 1 };
enum {
    HidNpadButton_Up = 1 << 0,
    HidNpadButton_Down = 1 << 1,
    HidNpadButton_A = 1 << 2,
    HidNpadButton_B = 1 << 3,
    HidNpadButton_X = 1 << 4,
    HidNpadButton_Y = 1 << 5,
    HidNpadButton_Plus = 1 << 6,
    HidNpadButton_Minus = 1 << 7,
};

void consoleInit(void *context);
void consoleUpdate(void *context);
void consoleExit(void *context);
void padConfigureInput(int count, int style);
void padInitializeDefault(PadState *pad);
void padUpdate(PadState *pad);
u64 padGetButtonsDown(PadState *pad);
void fsdevMountSdmc(void);
Result socketInitializeDefault(void);
void socketExit(void);
int appletMainLoop(void);
void svcSleepThread(int64_t duration_ns);

typedef struct { int active; } VideoDecoder;
typedef struct { uint32_t width; uint32_t height; } VideoFrame;
typedef struct {
    int codec;
    uint32_t width;
    uint32_t height;
    uint32_t frame_rate;
    int tiling;
    const void *codec_config;
    size_t codec_config_size;
} VideoDecoderConfig;
typedef struct AudioOutBuffer AudioOutBuffer;
struct AudioOutBuffer {
    AudioOutBuffer *next;
    void *buffer;
    uint64_t buffer_size;
    uint64_t data_size;
    uint64_t data_offset;
};

Result videoDecoderCreate(VideoDecoder *decoder, const VideoDecoderConfig *config);
Result videoDecoderSubmit(VideoDecoder *decoder, const void *sample, size_t size,
                          int64_t timestamp_ns, bool end_of_stream, uint64_t timeout_ns);
Result videoDecoderGetFrame(VideoDecoder *decoder, VideoFrame *frame, uint64_t timeout_ns);
Result videoDecoderCopyFrame(VideoDecoder *decoder, const VideoFrame *frame,
                             uint8_t *y, size_t y_pitch, uint8_t *uv, size_t uv_pitch);
void videoDecoderReleaseFrame(VideoDecoder *decoder, VideoFrame *frame);
Result videoDecoderFlush(VideoDecoder *decoder);
void videoDecoderClose(VideoDecoder *decoder);

Result audoutInitialize(void);
void audoutExit(void);
uint32_t audoutGetSampleRate(void);
uint32_t audoutGetChannelCount(void);
int audoutGetPcmFormat(void);
Result audoutStartAudioOut(void);
Result audoutStopAudioOut(void);
Result audoutFlushAudioOutBuffers(bool *flushed);
Result audoutPlayBuffer(AudioOutBuffer *source, AudioOutBuffer **released);
