#ifndef MINTNES_CORE_H
#define MINTNES_CORE_H

#include <stddef.h>
#include <stdint.h>

#define MINTNES_WIDTH 256u
#define MINTNES_HEIGHT 240u
#define MINTNES_PIXELS (MINTNES_WIDTH * MINTNES_HEIGHT)

int mintnes_supported_rom(const uint8_t *rom, size_t size);
int mintnes_load(const uint8_t *rom, size_t size);
uint32_t mintnes_frame(uint8_t buttons, uint8_t *pixels);
uint32_t mintnes_frame_count(void);

#endif
