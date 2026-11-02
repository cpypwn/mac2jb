#ifndef MINTNES_AUDIO_H
#define MINTNES_AUDIO_H

#include <stdint.h>

#define MINTNES_AUDIO_RATE 48000u
#define MINTNES_AUDIO_FRAME_SAMPLES 800u

void mintnes_audio_reset(void);
void mintnes_audio_write(uint16_t address, uint8_t value);
void mintnes_audio_render(int16_t *stereo, uint32_t frames);
#ifdef MINTNES_AUDIO_TEST
void mintnes_audio_test_counts(uint32_t *quarter, uint32_t *half);
#endif

#endif
