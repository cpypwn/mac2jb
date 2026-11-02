#include "mintnes_core.h"
#include "mintnes_audio.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  NES_RAM = 256u,
  NES_PRG = 2304u,
  NES_CHR = 35072u,
  NES_NAMETABLE = 43264u,
  NES_PALETTE = 45312u,
  NES_OAM = 45344u,
  NES_FRAMEBUFFER = 45600u,
  NES_MENU_TEXT = 107040u,
  NES_MENU_MODE = 19u,
  NES_SELECTED = 20u,
  NES_COUNT = 21u,
  NES_LOAD_REQUEST = 22u,
  NES_REFRESH_REQUEST = 23u,
  NES_MINUS_HELD = 24u,
  NES_NAME_WORDS = 48u,
  NES_MAX_ROMS = 16u,
  NES_MIRRORING = 25u,
  NES_PPU_READ_BUFFER = 26u,
  NES_APU_BASE = 32u,
  NES_APU_WORDS = 24u,
  NES_APU_SEQUENCE = 56u,
  NES_APU_FRAME = 57u,
  NES_APU_EVENT_BASE = 64u,
  NES_APU_EVENT_COUNT = 64u,
  NES_CHR_RAM = 61u
};

static uint32_t words[45600];
static uint8_t prg_ram[8192];
static uint32_t nes_buttons;

static uint32_t min_u32(uint32_t a, uint32_t b) { return a < b ? a : b; }
const uint32_t A = 0u, X = 1u, Y = 2u, SP = 3u, PC = 4u, P = 5u, HALT = 6u,
               FRAME = 7u;
const uint32_t PPUCTRL = 8u, PPUMASK = 9u, PPUSTATUS = 10u, PPUADDR = 11u,
               PPULATCH = 12u, OAMADDR = 13u;
const uint32_t CTRLSTROBE = 14u, CTRLSHIFT = 15u, CTRLBUTTONS = 16u,
               SCROLLX = 17u, SCROLLY = 18u;
const uint32_t MENU = 19u, MENU_INDEX = 20u, MENU_COUNT = 21u,
               LOAD_REQUEST = 22u, REFRESH_REQUEST = 23u, MINUS_HELD = 24u;
const uint32_t CPU_CYCLES = 27u, HIT_CHECKED = 28u, SPLIT_Y = 29u,
               TOP_CTRL = 30u, TOP_SCROLL_X = 31u, TOP_SCROLL_Y = 58u,
               PPUTEMP = 59u, FINE_X = 60u;
const uint32_t APU_LENGTHS = 62u;
const uint32_t F_C = 1u, F_Z = 2u, F_I = 4u, F_D = 8u, F_B = 16u, F_V = 64u,
               F_N = 128u;
uint32_t pattern(uint32_t base, uint32_t tile, uint32_t x, uint32_t y);
uint32_t spritePattern(uint32_t ctrl, uint32_t tile, uint32_t x, uint32_t y);
uint32_t spriteZeroRow();
uint32_t lengthValue(uint32_t index) {
  const uint32_t values[32] = {10u,  254u, 20u, 2u,  40u, 4u,  80u, 6u,
                               160u, 8u,   60u, 10u, 14u, 12u, 26u, 14u,
                               12u,  16u,  24u, 18u, 48u, 20u, 96u, 22u,
                               192u, 24u,  72u, 26u, 16u, 28u, 32u, 30u};
  return values[index & 31u];
}
uint32_t apuLength(uint32_t channel) {
  return (words[APU_LENGTHS] >> (channel * 8u)) & 255u;
}
void setApuLength(uint32_t channel, uint32_t value) {
  uint32_t shift = channel * 8u;
  words[APU_LENGTHS] =
      (words[APU_LENGTHS] & ~(255u << shift)) | ((value & 255u) << shift);
}

uint32_t ram(uint32_t a) { return words[NES_RAM + (a & 0x7ffu)] & 255u; }
void putRam(uint32_t a, uint32_t v) {
  words[NES_RAM + (a & 0x7ffu)] = v & 255u;
}
uint32_t prg(uint32_t a) {
  return words[NES_PRG + ((a - 0x8000u) & 0x7fffu)] & 255u;
}
uint32_t chr(uint32_t a) { return words[NES_CHR + (a & 0x1fffu)] & 255u; }
uint32_t ntIndex(uint32_t a) {
  uint32_t o = (a - 0x2000u) & 0xfffu, table = o / 1024u, offset = o % 1024u;
  return (((words[NES_MIRRORING] != 0u) ? (table & 1u) : (table >> 1u)) *
          1024u) +
         offset;
}
uint32_t palIndex(uint32_t a) {
  uint32_t i = (a - 0x3f00u) & 31u;
  return i == 16u || i == 20u || i == 24u || i == 28u ? i - 16u : i;
}
uint32_t ppuRead(uint32_t a) {
  a &= 0x3fffu;
  if (a < 0x2000u)
    return chr(a);
  if (a < 0x3f00u)
    return words[NES_NAMETABLE + ntIndex(a)] & 255u;
  return words[NES_PALETTE + palIndex(a)] & 63u;
}
void ppuWrite(uint32_t a, uint32_t v) {
  a &= 0x3fffu;
  if (a < 0x2000u && words[NES_CHR_RAM] != 0u)
    words[NES_CHR + a] = v & 255u;
  else if (a >= 0x2000u && a < 0x3f00u)
    words[NES_NAMETABLE + ntIndex(a)] = v & 255u;
  else if (a >= 0x3f00u)
    words[NES_PALETTE + palIndex(a)] = v & 63u;
}
uint32_t readCpu(uint32_t a) {
  a &= 0xffffu;
  if (a < 0x2000u)
    return ram(a);
  if (a < 0x4000u) {
    uint32_t r = a & 7u;
    if (r == 2u) {
      uint32_t sy = words[NES_OAM] & 255u;
      if (words[HIT_CHECKED] == 0u && words[CPU_CYCLES] >= 2400u + sy * 114u) {
        uint32_t hit = spriteZeroRow();
        words[HIT_CHECKED] = 1u;
        if (hit < 240u) {
          words[PPUSTATUS] |= 64u;
          words[SPLIT_Y] = hit;
          words[TOP_CTRL] = words[PPUCTRL];
          words[TOP_SCROLL_X] = words[SCROLLX];
          words[TOP_SCROLL_Y] = words[SCROLLY];
        }
      }
      uint32_t v = words[PPUSTATUS];
      words[PPUSTATUS] = v & 0x7fu;
      words[PPULATCH] = 0u;
      return v;
    }
    if (r == 4u) {
      uint32_t v = words[NES_OAM + (words[OAMADDR] & 255u)];
      return v & 255u;
    }
    if (r == 7u) {
      uint32_t addr = words[PPUADDR], next = ppuRead(addr),
               v = addr >= 0x3f00u ? next : words[NES_PPU_READ_BUFFER];
      words[NES_PPU_READ_BUFFER] =
          addr >= 0x3f00u ? ppuRead(addr - 0x1000u) : next;
      words[PPUADDR] =
          (addr + (((words[PPUCTRL] & 4u) != 0u) ? 32u : 1u)) & 0x3fffu;
      return v;
    }
    return 0u;
  }
  if (a == 0x4016u) {
    uint32_t i = words[CTRLSHIFT],
             v = (words[CTRLBUTTONS] >> min_u32(i, 7u)) & 1u;
    if (words[CTRLSTROBE] == 0u)
      words[CTRLSHIFT] = min_u32(i + 1u, 8u);
    return i >= 8u ? 1u : v;
  }
  if (a == 0x4015u) {
    uint32_t status = 0u;
    for (uint32_t channel = 0u; channel < 4u; channel++)
      if (apuLength(channel) != 0u)
        status |= 1u << channel;
    return status;
  }
  if (a >= 0x6000u && a < 0x8000u)
    return prg_ram[a - 0x6000u];
  if (a >= 0x8000u)
    return prg(a);
  return 0u;
}
void writeCpu(uint32_t a, uint32_t v) {
  a &= 0xffffu;
  v &= 255u;
  if (a < 0x2000u) {
    putRam(a, v);
    return;
  }
  if (a < 0x4000u) {
    uint32_t r = a & 7u;
    if (r == 0u) {
      words[PPUCTRL] = v;
      words[PPUTEMP] = (words[PPUTEMP] & ~0x0c00u) | ((v & 3u) << 10u);
    } else if (r == 1u)
      words[PPUMASK] = v;
    else if (r == 3u)
      words[OAMADDR] = v;
    else if (r == 4u) {
      words[NES_OAM + (words[OAMADDR] & 255u)] = v;
      words[OAMADDR] = (words[OAMADDR] + 1u) & 255u;
    } else if (r == 5u) {
      if (words[PPULATCH] == 0u) {
        words[SCROLLX] = v;
        words[FINE_X] = v & 7u;
        words[PPUTEMP] = (words[PPUTEMP] & ~31u) | (v >> 3u);
      } else {
        words[SCROLLY] = v;
        words[PPUTEMP] = (words[PPUTEMP] & ~0x73e0u) | ((v & 0xf8u) << 2u) |
                         ((v & 7u) << 12u);
      }
      words[PPULATCH] ^= 1u;
    } else if (r == 6u) {
      if (words[PPULATCH] == 0u)
        words[PPUTEMP] = (words[PPUTEMP] & 0xffu) | ((v & 63u) << 8u);
      else {
        words[PPUTEMP] = (words[PPUTEMP] & 0x7f00u) | v;
        words[PPUADDR] = words[PPUTEMP];
      }
      words[PPULATCH] ^= 1u;
    } else if (r == 7u) {
      ppuWrite(words[PPUADDR], v);
      words[PPUADDR] =
          (words[PPUADDR] + (((words[PPUCTRL] & 4u) != 0u) ? 32u : 1u)) &
          0x3fffu;
    }
    return;
  }
  if (a == 0x4014u) {
    for (uint32_t i = 0u; i < 256u; i++)
      words[NES_OAM + ((words[OAMADDR] + i) & 255u)] = ram((v << 8u) + i);
    return;
  }
  if (a == 0x4016u) {
    if ((v & 1u) != 0u) {
      words[CTRLSTROBE] = 1u;
      words[CTRLSHIFT] = 0u;
    } else if (words[CTRLSTROBE] != 0u) {
      words[CTRLSTROBE] = 0u;
      words[CTRLSHIFT] = 0u;
    }
    return;
  }
  if (a >= 0x6000u && a < 0x8000u) {
    prg_ram[a - 0x6000u] = (uint8_t)v;
    return;
  }
  if (a >= 0x4000u && a <= 0x4017u) {
    words[NES_APU_BASE + a - 0x4000u] = v;
    mintnes_audio_write((uint16_t)a, (uint8_t)v);
    if (a == 0x4015u) {
      for (uint32_t channel = 0u; channel < 4u; channel++)
        if ((v & (1u << channel)) == 0u)
          setApuLength(channel, 0u);
    } else if (a == 0x4003u || a == 0x4007u || a == 0x400bu || a == 0x400fu) {
      uint32_t channel = (a - 0x4003u) / 4u;
      if ((words[NES_APU_BASE + 0x15u] & (1u << channel)) != 0u)
        setApuLength(channel, lengthValue(v >> 3u));
    }
    uint32_t sequence = words[NES_APU_SEQUENCE] + 1u,
             slot = (sequence - 1u) % NES_APU_EVENT_COUNT;
    words[NES_APU_EVENT_BASE + slot * 3u] = a;
    words[NES_APU_EVENT_BASE + slot * 3u + 1u] = v;
    words[NES_APU_EVENT_BASE + slot * 3u + 2u] = sequence;
    words[NES_APU_SEQUENCE] = sequence;
    return;
  }
}
uint32_t fetch() {
  uint32_t pc = words[PC] & 0xffffu;
  words[PC] = (pc + 1u) & 0xffffu;
  return readCpu(pc);
}
uint32_t fetch16() {
  uint32_t lo = fetch();
  return lo | (fetch() << 8u);
}
void setFlag(uint32_t bit, bool on) {
  words[P] = on ? words[P] | bit : words[P] & ~bit;
}
bool flag(uint32_t bit) { return (words[P] & bit) != 0u; }
void setZN(uint32_t v) {
  setFlag(F_Z, (v & 255u) == 0u);
  setFlag(F_N, (v & 128u) != 0u);
}
void push(uint32_t v) {
  putRam(0x100u + words[SP], v);
  words[SP] = (words[SP] - 1u) & 255u;
}
uint32_t pop() {
  words[SP] = (words[SP] + 1u) & 255u;
  return ram(0x100u + words[SP]);
}
uint32_t modeAddr(uint32_t mode) {
  if (mode == 1u) {
    uint32_t z = (fetch() + words[X]) & 255u;
    return ram(z) | (ram((z + 1u) & 255u) << 8u);
  }
  if (mode == 5u)
    return fetch();
  if (mode == 9u) {
    uint32_t a = words[PC];
    words[PC] = (a + 1u) & 0xffffu;
    return a;
  }
  if (mode == 13u)
    return fetch16();
  if (mode == 17u) {
    uint32_t z = fetch();
    return (ram(z) | (ram((z + 1u) & 255u) << 8u)) + words[Y] & 0xffffu;
  }
  if (mode == 21u)
    return (fetch() + words[X]) & 255u;
  if (mode == 25u)
    return (fetch16() + words[Y]) & 0xffffu;
  if (mode == 29u)
    return (fetch16() + words[X]) & 0xffffu;
  return 0u;
}
void compare(uint32_t a, uint32_t v) {
  uint32_t d = (a - v) & 255u;
  setFlag(F_C, a >= v);
  setZN(d);
}
void addCarry(uint32_t v) {
  uint32_t a = words[A], carry = (uint32_t)(flag(F_C)), sum = a + v + carry,
           r = sum & 255u;
  setFlag(F_C, sum > 255u);
  setFlag(F_V, ((~(a ^ v) & (a ^ r)) & 128u) != 0u);
  words[A] = r;
  setZN(r);
}
uint32_t buttons() { return nes_buttons; }
void nmi() {
  uint32_t pc = words[PC];
  push(pc >> 8u);
  push(pc & 255u);
  push((words[P] & ~F_B) | 32u);
  setFlag(F_I, true);
  words[PC] = readCpu(0xfffau) | (readCpu(0xfffbu) << 8u);
}
bool branch(uint32_t op, uint32_t off) {
  bool take = (op == 0x10u && !flag(F_N)) || (op == 0x30u && flag(F_N)) ||
              (op == 0x50u && !flag(F_V)) || (op == 0x70u && flag(F_V)) ||
              (op == 0x90u && !flag(F_C)) || (op == 0xb0u && flag(F_C)) ||
              (op == 0xd0u && !flag(F_Z)) || (op == 0xf0u && flag(F_Z));
  if (take)
    words[PC] = (uint32_t)(((int32_t)(words[PC]) +
                            (int32_t)(off < 128u ? off : off - 256u)) &
                           65535);
  return take;
}
void instruction() {
  uint32_t op = fetch();
  if ((op & 3u) == 1u) {
    uint32_t group = op >> 5u, mode = op & 31u;
    if (mode != 1u && mode != 5u && mode != 9u && mode != 13u && mode != 17u &&
        mode != 21u && mode != 25u && mode != 29u) {
      words[HALT] = op + 1u;
      return;
    }
    if (group == 4u && mode == 9u) {
      words[HALT] = op + 1u;
      return;
    }
    uint32_t addr = modeAddr(mode), v = group == 4u ? 0u : readCpu(addr),
             a = words[A];
    if (group == 0u) {
      words[A] = a | v;
      setZN(words[A]);
    } else if (group == 1u) {
      words[A] = a & v;
      setZN(words[A]);
    } else if (group == 2u) {
      words[A] = a ^ v;
      setZN(words[A]);
    } else if (group == 3u)
      addCarry(v);
    else if (group == 4u)
      writeCpu(addr, a);
    else if (group == 5u) {
      words[A] = v;
      setZN(v);
    } else if (group == 6u)
      compare(a, v);
    else
      addCarry(v ^ 255u);
    return;
  }
  if ((op & 0x1fu) == 0x10u) {
    branch(op, fetch());
    return;
  }
  if (op == 0xa2u || op == 0xa6u || op == 0xb6u || op == 0xaeu || op == 0xbeu) {
    uint32_t at = op == 0xa2u   ? modeAddr(9u)
                  : op == 0xa6u ? modeAddr(5u)
                  : op == 0xb6u ? (fetch() + words[Y]) & 255u
                  : op == 0xaeu ? modeAddr(13u)
                                : modeAddr(25u);
    words[X] = readCpu(at);
    setZN(words[X]);
    return;
  }
  if (op == 0xa0u || op == 0xa4u || op == 0xb4u || op == 0xacu || op == 0xbcu) {
    uint32_t at = op == 0xa0u   ? modeAddr(9u)
                  : op == 0xa4u ? modeAddr(5u)
                  : op == 0xb4u ? modeAddr(21u)
                  : op == 0xacu ? modeAddr(13u)
                                : modeAddr(29u);
    words[Y] = readCpu(at);
    setZN(words[Y]);
    return;
  }
  if (op == 0x86u || op == 0x96u || op == 0x8eu) {
    uint32_t at = op == 0x86u   ? modeAddr(5u)
                  : op == 0x96u ? (fetch() + words[Y]) & 255u
                                : modeAddr(13u);
    writeCpu(at, words[X]);
    return;
  }
  if (op == 0x84u || op == 0x94u || op == 0x8cu) {
    uint32_t at = op == 0x84u   ? modeAddr(5u)
                  : op == 0x94u ? modeAddr(21u)
                                : modeAddr(13u);
    writeCpu(at, words[Y]);
    return;
  }
  if (op == 0xe0u || op == 0xe4u || op == 0xecu) {
    compare(words[X], readCpu(modeAddr(op == 0xe0u   ? 9u
                                       : op == 0xe4u ? 5u
                                                     : 13u)));
    return;
  }
  if (op == 0xc0u || op == 0xc4u || op == 0xccu) {
    compare(words[Y], readCpu(modeAddr(op == 0xc0u   ? 9u
                                       : op == 0xc4u ? 5u
                                                     : 13u)));
    return;
  }
  if (op == 0x24u || op == 0x2cu) {
    uint32_t v = readCpu(modeAddr(op == 0x24u ? 5u : 13u));
    setFlag(F_Z, (words[A] & v) == 0u);
    setFlag(F_N, (v & 128u) != 0u);
    setFlag(F_V, (v & 64u) != 0u);
    return;
  }
  if (op == 0xe6u || op == 0xf6u || op == 0xeeu || op == 0xfeu || op == 0xc6u ||
      op == 0xd6u || op == 0xceu || op == 0xdeu) {
    uint32_t at = (op & 15u) == 6u
                      ? (((op & 16u) != 0u) ? modeAddr(21u) : modeAddr(5u))
                      : (((op & 16u) != 0u) ? modeAddr(29u) : modeAddr(13u));
    uint32_t v = (readCpu(at) + ((op & 32u) != 0u ? 1u : 255u)) & 255u;
    writeCpu(at, v);
    setZN(v);
    return;
  }
  if (op == 0x0au || op == 0x4au || op == 0x2au || op == 0x6au || op == 0x06u ||
      op == 0x16u || op == 0x0eu || op == 0x1eu || op == 0x46u || op == 0x56u ||
      op == 0x4eu || op == 0x5eu || op == 0x26u || op == 0x36u || op == 0x2eu ||
      op == 0x3eu || op == 0x66u || op == 0x76u || op == 0x6eu || op == 0x7eu) {
    bool accum = (op & 15u) == 10u;
    uint32_t at = 0u;
    if (!accum)
      at = (op & 15u) == 6u
               ? (((op & 16u) != 0u) ? modeAddr(21u) : modeAddr(5u))
               : (((op & 16u) != 0u) ? modeAddr(29u) : modeAddr(13u));
    uint32_t v = accum ? words[A] : readCpu(at), kind = op & 0xe0u, r = 0u;
    if (kind == 0u) {
      setFlag(F_C, (v & 128u) != 0u);
      r = (v << 1u) & 255u;
    } else if (kind == 0x20u) {
      uint32_t c = (uint32_t)(flag(F_C));
      setFlag(F_C, (v & 128u) != 0u);
      r = ((v << 1u) | c) & 255u;
    } else if (kind == 0x40u) {
      setFlag(F_C, (v & 1u) != 0u);
      r = v >> 1u;
    } else {
      uint32_t c = (uint32_t)(flag(F_C));
      setFlag(F_C, (v & 1u) != 0u);
      r = (v >> 1u) | (c << 7u);
    }
    if (accum)
      words[A] = r;
    else
      writeCpu(at, r);
    setZN(r);
    return;
  }
  if (op == 0x4cu) {
    words[PC] = fetch16();
    return;
  }
  if (op == 0x6cu) {
    uint32_t at = fetch16();
    words[PC] =
        readCpu(at) | (readCpu((at & 0xff00u) | ((at + 1u) & 255u)) << 8u);
    return;
  }
  if (op == 0x20u) {
    uint32_t target = fetch16(), ret = (words[PC] - 1u) & 65535u;
    push(ret >> 8u);
    push(ret & 255u);
    words[PC] = target;
    return;
  }
  if (op == 0x00u) {
    uint32_t ret = (words[PC] + 1u) & 65535u;
    push(ret >> 8u);
    push(ret & 255u);
    push(words[P] | F_B | 32u);
    setFlag(F_I, true);
    words[PC] = readCpu(0xfffeu) | (readCpu(0xffffu) << 8u);
    return;
  }
  if (op == 0x60u) {
    words[PC] = ((pop() | (pop() << 8u)) + 1u) & 65535u;
    return;
  }
  if (op == 0x40u) {
    words[P] = (pop() | 32u) & ~F_B;
    words[PC] = pop() | (pop() << 8u);
    return;
  }
  if (op == 0x48u) {
    push(words[A]);
    return;
  }
  if (op == 0x68u) {
    words[A] = pop();
    setZN(words[A]);
    return;
  }
  if (op == 0x08u) {
    push(words[P] | F_B | 32u);
    return;
  }
  if (op == 0x28u) {
    words[P] = pop() | 32u;
    return;
  }
  if (op == 0xaau) {
    words[X] = words[A];
    setZN(words[X]);
    return;
  }
  if (op == 0xa8u) {
    words[Y] = words[A];
    setZN(words[Y]);
    return;
  }
  if (op == 0x8au) {
    words[A] = words[X];
    setZN(words[A]);
    return;
  }
  if (op == 0x98u) {
    words[A] = words[Y];
    setZN(words[A]);
    return;
  }
  if (op == 0xbau) {
    words[X] = words[SP];
    setZN(words[X]);
    return;
  }
  if (op == 0x9au) {
    words[SP] = words[X];
    return;
  }
  if (op == 0xe8u || op == 0xcau || op == 0xc8u || op == 0x88u) {
    uint32_t r = (op == 0xe8u || op == 0xcau) ? X : Y;
    words[r] = (words[r] + ((op == 0xe8u || op == 0xc8u) ? 1u : 255u)) & 255u;
    setZN(words[r]);
    return;
  }
  if (op == 0x18u || op == 0x38u) {
    setFlag(F_C, op == 0x38u);
    return;
  }
  if (op == 0x58u || op == 0x78u) {
    setFlag(F_I, op == 0x78u);
    return;
  }
  if (op == 0xd8u || op == 0xf8u) {
    setFlag(F_D, op == 0xf8u);
    return;
  }
  if (op == 0xb8u) {
    setFlag(F_V, false);
    return;
  }
  if (op == 0xeau)
    return;
  words[HALT] = op + 1u;
}
void cpuFrame() {
  words[FRAME]++;
  words[NES_APU_FRAME] = words[FRAME];
  for (uint32_t channel = 0u; channel < 4u; channel++) {
    uint32_t length = apuLength(channel),
             control = words[NES_APU_BASE + channel * 4u];
    if (channel == 2u)
      control = (control & 128u) != 0u ? 32u : 0u;
    if (length > 0u && (control & 32u) == 0u)
      setApuLength(channel, length > 2u ? length - 2u : 0u);
  }
  words[PPUSTATUS] = (words[PPUSTATUS] & ~64u) | 128u;
  words[CPU_CYCLES] = 0u;
  words[HIT_CHECKED] = 0u;
  words[SPLIT_Y] = 240u;
  words[CTRLBUTTONS] = buttons();
  if (words[HALT] == 0u) {
    if ((words[PPUCTRL] & 128u) != 0u)
      nmi();
    for (uint32_t i = 0u; i < 12000u; i++) {
      uint32_t pc = words[PC];
      if (pc >= 0x2000u && pc < 0x8000u) {
        words[HALT] = 0x101u;
        break;
      }
      uint32_t op = readCpu(pc);
      instruction();
      if (words[HALT] != 0u)
        break;
      words[CPU_CYCLES] += 3u;
      if (words[CPU_CYCLES] >= 29780u)
        break;
      if (op == 0x4cu && words[PC] == pc)
        break;
    }
  }
  words[PPUSTATUS] &= 0x7fu;
}
uint32_t pattern(uint32_t base, uint32_t tile, uint32_t x, uint32_t y) {
  uint32_t at = base + tile * 16u + y;
  uint32_t bit = 7u - x;
  return ((chr(at) >> bit) & 1u) | (((chr(at + 8u) >> bit) & 1u) << 1u);
}
uint32_t spritePattern(uint32_t ctrl, uint32_t tile, uint32_t x, uint32_t y) {
  if ((ctrl & 32u) != 0u)
    return pattern((tile & 1u) * 0x1000u, (tile & 0xfeu) + (y >> 3u), x,
                   y & 7u);
  return pattern((ctrl & 8u) != 0u ? 0x1000u : 0u, tile, x, y);
}
uint32_t backgroundPixel(uint32_t x, uint32_t y, uint32_t ctrl,
                         uint32_t scrollX, uint32_t scrollY) {
  uint32_t wx = (x + scrollX + (((ctrl & 1u) != 0u) ? 256u : 0u)) % 512u;
  uint32_t wy = (y + scrollY + (((ctrl & 2u) != 0u) ? 240u : 0u)) % 480u;
  uint32_t table = (wy / 240u) * 2u + wx / 256u, sx = wx % 256u, sy = wy % 240u;
  uint32_t addr = 0x2000u + table * 1024u + (sy / 8u) * 32u + sx / 8u;
  uint32_t tile = words[NES_NAMETABLE + ntIndex(addr)] & 255u;
  return pattern((ctrl & 16u) != 0u ? 0x1000u : 0u, tile, sx & 7u, sy & 7u);
}
uint32_t spriteZeroRow() {
  uint32_t mask = words[PPUMASK], ctrl = words[PPUCTRL];
  if ((mask & 24u) != 24u)
    return 240u;
  uint32_t sy = words[NES_OAM] & 255u, tile = words[NES_OAM + 1u] & 255u,
           attr = words[NES_OAM + 2u] & 255u, sx = words[NES_OAM + 3u] & 255u;
  uint32_t height = (ctrl & 32u) != 0u ? 16u : 8u;
  for (uint32_t row = 0u; row < height; row++) {
    uint32_t y = sy + 1u + row;
    if (y >= 240u)
      break;
    uint32_t py = ((attr & 128u) != 0u) ? height - 1u - row : row;
    for (uint32_t col = 0u; col < 8u; col++) {
      uint32_t x = sx + col;
      if (x >= 255u)
        break;
      if (x < 8u && ((mask & 6u) != 6u))
        continue;
      uint32_t px = ((attr & 64u) != 0u) ? 7u - col : col;
      if (spritePattern(ctrl, tile, px, py) != 0u &&
          backgroundPixel(x, y, ctrl, words[SCROLLX], words[SCROLLY]) != 0u)
        return y;
    }
  }
  return 240u;
}
uint32_t pixel(uint32_t x, uint32_t y) {
  bool top = words[SPLIT_Y] < 240u && y < words[SPLIT_Y];
  uint32_t bg = 0u, pal = 0u, ctrl = top ? words[TOP_CTRL] : words[PPUCTRL],
           mask = words[PPUMASK];
  if ((mask & 8u) != 0u && (x >= 8u || (mask & 2u) != 0u)) {
    uint32_t scrollX = top ? words[TOP_SCROLL_X] : words[SCROLLX],
             scrollY = top ? words[TOP_SCROLL_Y] : words[SCROLLY];
    uint32_t wx = (x + scrollX + (((ctrl & 1u) != 0u) ? 256u : 0u)) % 512u;
    uint32_t wy = (y + scrollY + (((ctrl & 2u) != 0u) ? 240u : 0u)) % 480u;
    uint32_t table = (wy / 240u) * 2u + wx / 256u, sx = wx % 256u,
             sy = wy % 240u;
    uint32_t tx = sx / 8u, ty = sy / 8u, base = 0x2000u + table * 1024u;
    uint32_t nt = words[NES_NAMETABLE + ntIndex(base + ty * 32u + tx)] & 255u;
    bg = pattern((ctrl & 16u) != 0u ? 0x1000u : 0u, nt, sx & 7u, sy & 7u);
    uint32_t attr =
        words[NES_NAMETABLE + ntIndex(base + 960u + (ty / 4u) * 8u + tx / 4u)] &
        255u;
    uint32_t shift = ((ty & 2u) != 0u ? 4u : 0u) + ((tx & 2u) != 0u ? 2u : 0u);
    pal = ((attr >> shift) & 3u) * 4u;
  }
  uint32_t color = words[NES_PALETTE + (bg == 0u ? 0u : pal + bg)] & 63u;
  if ((mask & 16u) != 0u && (x >= 8u || (mask & 4u) != 0u)) {
    for (uint32_t i = 0u; i < 64u; i++) {
      uint32_t sy = words[NES_OAM + i * 4u] & 255u,
               sx = words[NES_OAM + i * 4u + 3u] & 255u;
      uint32_t height = (ctrl & 32u) != 0u ? 16u : 8u;
      if (y <= sy || y > sy + height || x < sx || x >= sx + 8u)
        continue;
      uint32_t tile = words[NES_OAM + i * 4u + 1u] & 255u,
               attr = words[NES_OAM + i * 4u + 2u] & 255u;
      uint32_t px = ((attr & 64u) != 0u) ? 7u - (x - sx) : x - sx,
               py = ((attr & 128u) != 0u) ? height - (y - sy) : y - sy - 1u;
      uint32_t sprite = spritePattern(ctrl, tile, px, py);
      if (sprite == 0u)
        continue;
      if (bg == 0u || (attr & 32u) == 0u)
        color = words[NES_PALETTE + 16u + (attr & 3u) * 4u + sprite] & 63u;
      break;
    }
  }
  return color;
}

int mintnes_supported_rom(const uint8_t *rom, size_t size) {
  uint32_t prg_banks, chr_banks, flags;
  if (!rom || size < 16u || size > 65536u || rom[0] != 'N' || rom[1] != 'E' ||
      rom[2] != 'S' || rom[3] != 0x1a)
    return 0;
  prg_banks = rom[4];
  chr_banks = rom[5];
  flags = rom[6];
  if ((prg_banks != 1 && prg_banks != 2) || chr_banks > 1 ||
      (flags & 0x0c) != 0 || ((flags >> 4) | (rom[7] & 0xf0)) != 0 ||
      (rom[7] & 0x0c) == 0x08)
    return 0;
  return size >= 16u + prg_banks * 16384u + chr_banks * 8192u;
}

int mintnes_load(const uint8_t *rom, size_t size) {
  uint32_t prg_bytes, chr_bytes, reset;
  if (!mintnes_supported_rom(rom, size))
    return 0;
  prg_bytes = (uint32_t)rom[4] * 16384u;
  chr_bytes = (uint32_t)rom[5] * 8192u;
  for (uint32_t i = 0; i < 45600u; i++)
    words[i] = 0;
  for (uint32_t i = 0; i < 8192u; i++)
    prg_ram[i] = 0;
  mintnes_audio_reset();
  for (uint32_t i = 0; i < 32768u; i++)
    words[NES_PRG + i] = rom[16u + i % prg_bytes];
  for (uint32_t i = 0; i < chr_bytes; i++)
    words[NES_CHR + i] = rom[16u + prg_bytes + i];
  words[NES_MIRRORING] = rom[6] & 1u;
  words[NES_CHR_RAM] = rom[5] == 0;
  words[SP] = 0xfdu;
  words[P] = 0x24u;
  words[SPLIT_Y] = 240u;
  reset = words[NES_PRG + 0x7ffcu] | (words[NES_PRG + 0x7ffdu] << 8u);
  if (reset < 0x8000u)
    return 0;
  words[PC] = reset;
  return 1;
}

uint32_t mintnes_frame(uint8_t buttons, uint8_t *pixels) {
  if (!pixels)
    return 0xffffffffu;
  nes_buttons = buttons;
  cpuFrame();
  for (uint32_t y = 0; y < MINTNES_HEIGHT; y++) {
    for (uint32_t x = 0; x < MINTNES_WIDTH; x++)
      pixels[y * MINTNES_WIDTH + x] = (uint8_t)pixel(x, y);
  }
  return words[HALT];
}

uint32_t mintnes_frame_count(void) { return words[FRAME]; }
