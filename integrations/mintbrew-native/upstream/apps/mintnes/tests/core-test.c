#include "mintnes_core.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static uint8_t pixels[MINTNES_PIXELS];
static uint8_t rom[65536];

int main(int argc, char **argv) {
  FILE *file;
  size_t size;
  uint64_t signatures[3] = {0};
  uint64_t without_input = 1469598103934665603ull;
  uint32_t halted = 0;
  uint32_t colors = 0;
  uint8_t seen[64] = {0};
  clock_t started;
  if (argc != 2)
    return 2;
  file = fopen(argv[1], "rb");
  if (!file)
    return 2;
  size = fread(rom, 1, sizeof rom, file);
  fclose(file);
  if (!mintnes_supported_rom(rom, size))
    return 3;
  rom[6] |= 0x10;
  if (mintnes_supported_rom(rom, size))
    return 4;
  rom[6] &= (uint8_t)~0x10;
  if (mintnes_supported_rom(rom, 32))
    return 5;
  if (mintnes_supported_rom(rom, 65537u))
    return 13;
  if (!mintnes_load(rom, size))
    return 6;
  started = clock();
  for (uint32_t frame = 0; frame < 120; frame++) {
    uint8_t buttons = frame >= 30 && frame < 33   ? 8u
                      : frame >= 45 && frame < 85 ? 128u
                      : frame >= 90               ? 1u
                                                  : 0u;
    halted = mintnes_frame(buttons, pixels);
    if (halted)
      break;
    if (frame == 0 || frame == 60 || frame == 119) {
      uint64_t hash = 1469598103934665603ull;
      uint32_t slot = frame == 0 ? 0 : frame == 60 ? 1 : 2;
      for (size_t i = 0; i < MINTNES_PIXELS; i++) {
        hash ^= pixels[i];
        hash *= 1099511628211ull;
      }
      signatures[slot] = hash;
    }
  }
  if (halted) {
    fprintf(stderr, "ROM halted: %u\n", halted);
    return 7;
  }
  if (!signatures[0] || !signatures[1] || !signatures[2] ||
      signatures[0] == signatures[1] || signatures[1] == signatures[2]) {
    fprintf(stderr, "ROM did not advance visually\n");
    return 8;
  }
  for (size_t i = 0; i < MINTNES_PIXELS; i++) {
    uint8_t color = pixels[i] & 63u;
    if (!seen[color]) {
      seen[color] = 1;
      colors++;
    }
  }
  if (colors < 3u) {
    fprintf(stderr, "ROM drew only %u colors\n", colors);
    return 9;
  }
  if (!mintnes_load(rom, size))
    return 10;
  for (uint32_t frame = 0; frame < 120; frame++) {
    if (mintnes_frame(0, pixels))
      return 11;
  }
  for (size_t i = 0; i < MINTNES_PIXELS; i++) {
    without_input ^= pixels[i];
    without_input *= 1099511628211ull;
  }
  if (without_input == signatures[2])
    return 12;
  printf("frames=%u hashes=%llx,%llx,%llx cpu_seconds=%.3f\n",
         mintnes_frame_count(), (unsigned long long)signatures[0],
         (unsigned long long)signatures[1], (unsigned long long)signatures[2],
         (double)(clock() - started) / CLOCKS_PER_SEC);
  return 0;
}
