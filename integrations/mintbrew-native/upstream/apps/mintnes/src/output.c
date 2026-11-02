#include "mintnes_output.h"
#include "mintnes_audio.h"
#include "hbx_app.h"
#include "hbx_imports.h"

#define BUFFER_COUNT 8u
#define BUFFER_BYTES 4096u
#define OBJECT_BYTES 65536u
#define TOTAL_BYTES (OBJECT_BYTES + BUFFER_COUNT * BUFFER_BYTES)

static uint8_t *area;
static uint8_t queued[BUFFER_COUNT];
static uint8_t opened;
static uint8_t started;
static uint8_t blocked;
static void (*free_area)(void *);

static void *object(void) { return area; }
static void *descriptor(uint32_t index) { return area + 0x400u + index * 0x40u; }
static void *samples(uint32_t index) {
  return area + OBJECT_BYTES + index * BUFFER_BYTES;
}

static int ready(const struct hbx_ctx *ctx) {
  const struct hbx_audio *a = &ctx->audio;
  return a->initialize_parameter && a->open_default_audio_out &&
         a->sample_rate && a->channel_count && a->sample_format &&
         a->set_buffer_info && a->append_buffer && a->start && a->stop &&
         a->buffer_count && a->flush_buffers && a->released_buffer &&
         a->close;
}

static int release(const struct hbx_ctx *ctx) {
  void *(*released)(void *) =
      (void *(*)(void *))(uintptr_t)ctx->audio.released_buffer;
  for (uint32_t i = 0; i < BUFFER_COUNT; i++) {
    void *value = released(object());
    if (!value)
      return 1;
    uint32_t index = 0;
    while (index < BUFFER_COUNT && descriptor(index) != value)
      index++;
    if (index == BUFFER_COUNT || !queued[index])
      return 0;
    queued[index] = 0;
  }
  return 1;
}

int mintnes_output_open(const struct hbx_ctx *ctx) {
  if (opened)
    return !blocked;
  if (!ctx || !ready(ctx) || HBX_IMPORT_COUNT != 2u)
    return 0;
  uint64_t imports[2];
  if (hbx_imports_resolve(ctx, hbx_import_offsets, HBX_IMPORT_COUNT,
                          imports) != 2)
    return 0;
  int (*allocate)(void **, uint64_t, uint64_t) =
      (int (*)(void **, uint64_t, uint64_t))(uintptr_t)imports[0];
  void *memory = 0;
  if (allocate(&memory, OBJECT_BYTES, TOTAL_BYTES) != 0 || !memory)
    return 0;
  area = memory;
  free_area = (void (*)(void *))(uintptr_t)imports[1];
  for (uint32_t i = 0; i < TOTAL_BYTES; i++)
    area[i] = 0;
  void *param = area + 0x300u;
  ((void (*)(void *))(uintptr_t)ctx->audio.initialize_parameter)(param);
  ((uint32_t *)param)[0] = MINTNES_AUDIO_RATE;
  ((uint16_t *)param)[2] = 2;
  uint32_t result =
      ((uint32_t (*)(void *, const void *))(uintptr_t)ctx->audio.open_default_audio_out)(
          object(), param);
  if (result != 0u) {
    free_area(memory);
    area = 0;
    free_area = 0;
    return 0;
  }
  opened = 1;
  uint32_t (*format)(void *) =
      (uint32_t (*)(void *))(uintptr_t)ctx->audio.sample_format;
  uint32_t (*rate)(void *) =
      (uint32_t (*)(void *))(uintptr_t)ctx->audio.sample_rate;
  uint32_t (*channels)(void *) =
      (uint32_t (*)(void *))(uintptr_t)ctx->audio.channel_count;
  if (rate(object()) != MINTNES_AUDIO_RATE || channels(object()) != 2u ||
      format(object()) != 2u) {
    blocked = 1;
    mintnes_output_close(ctx);
    return 0;
  }
  return 1;
}

int mintnes_output_submit(const struct hbx_ctx *ctx, const int16_t *stereo,
                          uint32_t frames) {
  if (!ctx || !stereo || !opened || blocked || frames == 0u ||
      frames > MINTNES_AUDIO_FRAME_SAMPLES)
    return 0;
  if (!release(ctx)) {
    blocked = 1;
    return 0;
  }
  uint32_t index = 0;
  while (index < BUFFER_COUNT && queued[index])
    index++;
  if (index == BUFFER_COUNT)
    return 1;
  int16_t *output = samples(index);
  for (uint32_t i = 0; i < frames * 2u; i++)
    output[i] = stereo[i];
  ((void (*)(void *, void *, uint64_t, uint64_t))(uintptr_t)
       ctx->audio.set_buffer_info)(descriptor(index), samples(index),
                                   BUFFER_BYTES, frames * 4u);
  uint32_t appended = ((uint32_t (*)(void *, void *))(uintptr_t)
                           ctx->audio.append_buffer)(object(), descriptor(index));
  if (appended != 1u) {
    blocked = 1;
    return 0;
  }
  queued[index] = 1;
  if (!started) {
    uint32_t result =
        ((uint32_t (*)(void *))(uintptr_t)ctx->audio.start)(object());
    if (result != 0u) {
      blocked = 1;
      return 0;
    }
    started = 1;
  }
  return 1;
}

int mintnes_output_pause(const struct hbx_ctx *ctx) {
  if (!area || !opened)
    return 1;
  if (!ctx)
    return 0;
  int clean = 1;
  if (started) {
    uint32_t result =
        ((uint32_t (*)(void *))(uintptr_t)ctx->audio.stop)(object());
    if (result != 0u)
      clean = 0;
    else
      started = 0;
  }
  if (clean) {
    ((void (*)(void *))(uintptr_t)ctx->audio.flush_buffers)(object());
    clean = release(ctx);
    if (((uint32_t (*)(void *))(uintptr_t)ctx->audio.buffer_count)(object()) !=
        0u)
      clean = 0;
  }
  if (!clean) {
    blocked = 1;
    return 0;
  }
  return 1;
}

int mintnes_output_close(const struct hbx_ctx *ctx) {
  if (!area || !opened)
    return 1;
  if (!mintnes_output_pause(ctx))
    return 0;
  ((void (*)(void *))(uintptr_t)ctx->audio.close)(object());
  free_area(area);
  area = 0;
  free_area = 0;
  opened = started = blocked = 0;
  for (uint32_t i = 0; i < BUFFER_COUNT; i++)
    queued[i] = 0;
  return 1;
}
