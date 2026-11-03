#include "mintnes_audio.h"
#include <stdint.h>
#include <stdio.h>

static int16_t pcm[MINTNES_AUDIO_FRAME_SAMPLES * 2u];

static void render_second(void) {
  for (uint32_t i = 0; i < 60u; i++)
    mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
}

static uint64_t energy(void) {
  uint64_t sum = 0;
  for (uint32_t i = 0; i < MINTNES_AUDIO_FRAME_SAMPLES; i++) {
    int32_t value = pcm[i * 2u];
    if (pcm[i * 2u + 1u] != value)
      return UINT64_MAX;
    sum += value < 0 ? (uint32_t)-value : (uint32_t)value;
  }
  return sum;
}

int main(void) {
  mintnes_audio_reset();
  mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
  if (energy() != 0u)
    return 1;

  mintnes_audio_write(0x4015u, 1u);
  mintnes_audio_write(0x4000u, 0x9fu);
  mintnes_audio_write(0x4002u, 0x60u);
  mintnes_audio_write(0x4003u, 0x08u);
  mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
  uint64_t pulse = energy();
  if (pulse < 10000u || pulse == UINT64_MAX)
    return 2;

  mintnes_audio_write(0x4015u, 0u);
  for (uint32_t i = 0; i < 4u; i++)
    mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
  if (energy() >= pulse / 20u)
    return 3;

  mintnes_audio_reset();
  mintnes_audio_write(0x4015u, 4u);
  mintnes_audio_write(0x4008u, 0xffu);
  mintnes_audio_write(0x400au, 0x20u);
  mintnes_audio_write(0x400bu, 0x08u);
  mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
  uint64_t triangle = energy();
  if (triangle < 10000u || triangle == UINT64_MAX)
    return 4;

  mintnes_audio_reset();
  mintnes_audio_write(0x4015u, 8u);
  mintnes_audio_write(0x400cu, 0x1fu);
  mintnes_audio_write(0x400eu, 0x03u);
  mintnes_audio_write(0x400fu, 0x08u);
  mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
  uint64_t noise = energy();
  if (noise < 10000u || noise == UINT64_MAX)
    return 5;

  uint32_t quarter, half;
  mintnes_audio_reset();
  render_second();
  mintnes_audio_test_counts(&quarter, &half);
  if (quarter != 239u || half != 119u) {
    fprintf(stderr, "four-step clocks: quarter=%u half=%u\n", quarter, half);
    return 6;
  }
  mintnes_audio_reset();
  mintnes_audio_write(0x4017u, 0x80u);
  mintnes_audio_test_counts(&quarter, &half);
  if (quarter != 1u || half != 1u)
    return 7;
  render_second();
  mintnes_audio_test_counts(&quarter, &half);
  if (quarter != 193u || half != 97u) {
    fprintf(stderr, "five-step clocks: quarter=%u half=%u\n", quarter, half);
    return 8;
  }

  printf("MintNES PCM and four/five-step APU timing passed\n");
  return 0;
}
