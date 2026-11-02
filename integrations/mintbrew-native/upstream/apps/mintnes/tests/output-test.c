#include "mintnes_output.h"
#include "mintnes_audio.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t opens, appends, starts, stops, flushes, closes, frees;
static uint32_t format = 2, stop_error;
static uint32_t release_ready = 1;
static void *pending[8];
static uint32_t pending_count;

static int allocate(void **out, uint64_t alignment, uint64_t bytes) {
  return posix_memalign(out, (size_t)alignment, (size_t)bytes);
}

static void release_memory(void *memory) {
  frees++;
  free(memory);
}

static void initialize(void *parameter) { memset(parameter, 0, 8); }

static uint32_t open_audio(void *object, const void *parameter) {
  (void)object;
  if (((const uint32_t *)parameter)[0] != MINTNES_AUDIO_RATE ||
      ((const uint16_t *)parameter)[2] != 2u)
    return 1;
  opens++;
  return 0;
}

static uint32_t sample_rate(void *object) {
  (void)object;
  return MINTNES_AUDIO_RATE;
}

static uint32_t channel_count(void *object) {
  (void)object;
  return 2;
}

static uint32_t sample_format(void *object) {
  (void)object;
  return format;
}

static void set_info(void *buffer, void *data, uint64_t capacity,
                     uint64_t bytes) {
  if (!buffer || !data || capacity != 4096u ||
      bytes != MINTNES_AUDIO_FRAME_SAMPLES * 4u)
    abort();
}

static uint32_t append(void *object, void *buffer) {
  (void)object;
  if (pending_count >= 8u)
    return 0;
  pending[pending_count++] = buffer;
  appends++;
  return 1;
}

static uint32_t start_audio(void *object) {
  (void)object;
  starts++;
  return 0;
}

static uint32_t stop_audio(void *object) {
  (void)object;
  stops++;
  return stop_error;
}

static uint32_t buffer_count(void *object) {
  (void)object;
  return pending_count;
}

static void flush(void *object) {
  (void)object;
  flushes++;
  release_ready = 1;
}

static void *released(void *object) {
  (void)object;
  if (!pending_count || !release_ready)
    return 0;
  void *buffer = pending[0];
  for (uint32_t i = 1u; i < pending_count; i++)
    pending[i - 1u] = pending[i];
  pending_count--;
  return buffer;
}

static void close_audio(void *object) {
  (void)object;
  closes++;
}

int main(void) {
  struct hbx_ctx ctx;
  memset(&ctx, 0, sizeof ctx);
  if (mintnes_output_open(&ctx))
    return 1;
  uint64_t imports[3] = {2u, (uint64_t)(uintptr_t)allocate,
                         (uint64_t)(uintptr_t)release_memory};
  ctx.args[0] = (uint64_t)(uintptr_t)imports;
  ctx.audio.initialize_parameter = (uint64_t)(uintptr_t)initialize;
  ctx.audio.open_default_audio_out = (uint64_t)(uintptr_t)open_audio;
  ctx.audio.sample_rate = (uint64_t)(uintptr_t)sample_rate;
  ctx.audio.channel_count = (uint64_t)(uintptr_t)channel_count;
  ctx.audio.sample_format = (uint64_t)(uintptr_t)sample_format;
  ctx.audio.set_buffer_info = (uint64_t)(uintptr_t)set_info;
  ctx.audio.append_buffer = (uint64_t)(uintptr_t)append;
  ctx.audio.start = (uint64_t)(uintptr_t)start_audio;
  ctx.audio.stop = (uint64_t)(uintptr_t)stop_audio;
  ctx.audio.buffer_count = (uint64_t)(uintptr_t)buffer_count;
  ctx.audio.flush_buffers = (uint64_t)(uintptr_t)flush;
  ctx.audio.released_buffer = (uint64_t)(uintptr_t)released;
  ctx.audio.close = (uint64_t)(uintptr_t)close_audio;

  int16_t samples[MINTNES_AUDIO_FRAME_SAMPLES * 2u] = {0};
  if (!mintnes_output_open(&ctx))
    return 2;
  for (uint32_t i = 0; i < 12u; i++)
    if (!mintnes_output_submit(&ctx, samples, MINTNES_AUDIO_FRAME_SAMPLES))
      return 3;
  if (opens != 1u || appends != 12u || starts != 1u)
    return 4;
  if (!mintnes_output_close(&ctx) || stops != 1u || flushes != 1u ||
      closes != 1u || frees != 1u || pending_count != 0u)
    return 5;

  if (!mintnes_output_open(&ctx))
    return 6;
  release_ready = 0;
  if (!mintnes_output_submit(&ctx, samples, MINTNES_AUDIO_FRAME_SAMPLES) ||
      !mintnes_output_submit(&ctx, samples, MINTNES_AUDIO_FRAME_SAMPLES) ||
      pending_count != 2u)
    return 7;
  if (!mintnes_output_pause(&ctx) || pending_count != 0u || stops != 2u ||
      flushes != 2u || closes != 1u || frees != 1u)
    return 8;
  if (!mintnes_output_submit(&ctx, samples, MINTNES_AUDIO_FRAME_SAMPLES) ||
      starts != 3u || !mintnes_output_close(&ctx) || stops != 3u ||
      closes != 2u || frees != 2u)
    return 9;

  format = 1u;
  if (mintnes_output_open(&ctx) || opens != 3u || closes != 3u ||
      frees != 3u)
    return 10;
  format = 2u;
  if (!mintnes_output_open(&ctx) ||
      !mintnes_output_submit(&ctx, samples, MINTNES_AUDIO_FRAME_SAMPLES))
    return 11;
  stop_error = 1u;
  if (mintnes_output_close(&ctx) || closes != 3u || frees != 3u)
    return 12;
  stop_error = 0u;
  if (!mintnes_output_close(&ctx) || closes != 4u || frees != 4u)
    return 13;
  printf("MintNES AudioOut queue, pause, drain, close and fallback passed\n");
  return 0;
}
