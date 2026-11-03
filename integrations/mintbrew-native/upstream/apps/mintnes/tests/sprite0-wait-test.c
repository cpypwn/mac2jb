#include "../src/core.c"
#include <stdio.h>

int main(void) {
  const uint8_t program[] = {
      0xadu, 0x02u, 0x20u, 0x29u, 0x40u, 0xf0u, 0xf9u,
      0xa9u, 0x7fu, 0x8du, 0x00u, 0x00u, 0x4cu, 0x0cu, 0x80u};
  for (uint32_t i = 0; i < sizeof program; i++)
    words[NES_PRG + i] = program[i];
  words[PC] = 0x8000u;
  words[SP] = 0xfdu;
  words[P] = 0x24u;
  words[PPUMASK] = 0x1eu;
  words[NES_OAM] = 1u;
  words[NES_OAM + 3u] = 8u;
  words[NES_CHR] = 0xffu;
  words[NES_CHR + 2u] = 0xffu;
  cpuFrame();
  if (ram(0) != 0x7fu || (words[PPUSTATUS] & 64u) == 0u) {
    fprintf(stderr, "sprite-zero wait did not advance within a frame\n");
    return 1;
  }
  printf("sprite-zero wait advanced after %u approximate CPU cycles\n",
         words[CPU_CYCLES]);
  return 0;
}
