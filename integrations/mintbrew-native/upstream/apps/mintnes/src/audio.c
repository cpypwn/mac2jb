#include "mintnes_audio.h"

#define CPU_RATE 1789773.0

static const uint8_t lengths_table[32] = {
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30};
static const uint16_t noise_periods[16] = {
    4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034,
    4068};

struct envelope {
  uint8_t start;
  uint8_t divider;
  uint8_t decay;
};

struct sweep {
  uint8_t reload;
  uint8_t divider;
};

static uint8_t registers[24];
static uint8_t length_counter[4];
static struct envelope envelopes[3];
static struct sweep sweeps[2];
static double phase[3];
static double noise_phase;
static uint16_t noise_shift;
static double frame_cycles;
static uint8_t frame_step;
static uint8_t linear_counter;
static uint8_t linear_reload;
static double hp90, hp90_input, hp440, hp440_input, lp;
#ifdef MINTNES_AUDIO_TEST
static uint32_t quarter_count, half_count;

void mintnes_audio_test_counts(uint32_t *quarter, uint32_t *half) {
  if (quarter)
    *quarter = quarter_count;
  if (half)
    *half = half_count;
}
#endif

static uint8_t enabled(uint32_t channel) {
  return (registers[0x15u] & (1u << channel)) != 0u;
}

static uint16_t timer(uint32_t channel) {
  uint32_t base = channel * 4u;
  return (uint16_t)(registers[base + 2u] |
                    ((registers[base + 3u] & 7u) << 8u));
}

static uint8_t volume(uint32_t channel) {
  uint32_t base = channel * 4u;
  uint8_t control = registers[base];
  uint8_t index = channel == 3u ? 2u : (uint8_t)channel;
  return (control & 16u) != 0u ? control & 15u : envelopes[index].decay;
}

void mintnes_audio_reset(void) {
  for (uint32_t i = 0; i < 24u; i++)
    registers[i] = 0;
  for (uint32_t i = 0; i < 4u; i++)
    length_counter[i] = 0;
  for (uint32_t i = 0; i < 3u; i++) {
    envelopes[i].start = 0;
    envelopes[i].divider = 0;
    envelopes[i].decay = 0;
    phase[i] = 0;
  }
  for (uint32_t i = 0; i < 2u; i++) {
    sweeps[i].reload = 0;
    sweeps[i].divider = 0;
  }
  noise_phase = 0;
  noise_shift = 1;
  frame_cycles = 0;
  frame_step = 0;
  linear_counter = 0;
  linear_reload = 0;
  hp90 = hp90_input = hp440 = hp440_input = lp = 0;
#ifdef MINTNES_AUDIO_TEST
  quarter_count = half_count = 0;
#endif
}

static void clock_quarter(void) {
#ifdef MINTNES_AUDIO_TEST
  quarter_count++;
#endif
  const uint8_t channels[3] = {0, 1, 3};
  for (uint32_t i = 0; i < 3u; i++) {
    struct envelope *envelope = &envelopes[i];
    uint8_t control = registers[channels[i] * 4u];
    uint8_t period = control & 15u;
    if (envelope->start) {
      envelope->start = 0;
      envelope->decay = 15;
      envelope->divider = period;
    } else if (envelope->divider == 0u) {
      envelope->divider = period;
      if (envelope->decay)
        envelope->decay--;
      else if (control & 32u)
        envelope->decay = 15;
    } else {
      envelope->divider--;
    }
  }
  if (linear_reload)
    linear_counter = registers[8] & 127u;
  else if (linear_counter)
    linear_counter--;
  if ((registers[8] & 128u) == 0u)
    linear_reload = 0;
}

static void clock_half(void) {
#ifdef MINTNES_AUDIO_TEST
  half_count++;
#endif
  for (uint32_t channel = 0; channel < 4u; channel++) {
    uint8_t control = registers[channel * 4u];
    uint8_t halt = channel == 2u ? 128u : 32u;
    if (length_counter[channel] && (control & halt) == 0u)
      length_counter[channel]--;
  }
  for (uint32_t channel = 0; channel < 2u; channel++) {
    struct sweep *sweep = &sweeps[channel];
    uint8_t control = registers[channel * 4u + 1u];
    uint8_t shift = control & 7u;
    uint8_t period = (control >> 4u) & 7u;
    if (sweep->divider == 0u) {
      if ((control & 128u) && shift) {
        uint16_t current = timer(channel);
        uint16_t delta = current >> shift;
        int32_t next = (control & 8u)
                           ? (int32_t)current - delta - (channel == 0u)
                           : (int32_t)current + delta;
        if (current >= 8u && next >= 0 && next <= 2047) {
          uint32_t base = channel * 4u;
          registers[base + 2u] = (uint8_t)next;
          registers[base + 3u] =
              (registers[base + 3u] & 248u) | ((uint32_t)next >> 8u);
        }
      }
      sweep->divider = period;
    } else {
      sweep->divider--;
    }
    if (sweep->reload) {
      sweep->reload = 0;
      sweep->divider = period;
    }
  }
}

void mintnes_audio_write(uint16_t address, uint8_t value) {
  if (address < 0x4000u || address > 0x4017u)
    return;
  uint32_t offset = address - 0x4000u;
  registers[offset] = value;
  if (offset == 0x15u) {
    for (uint32_t channel = 0; channel < 4u; channel++)
      if (!enabled(channel))
        length_counter[channel] = 0;
    return;
  }
  if (offset == 1u || offset == 5u) {
    sweeps[offset == 1u ? 0u : 1u].reload = 1;
    return;
  }
  if (offset == 0x17u) {
    frame_cycles = 0;
    frame_step = 0;
    if (value & 128u) {
      clock_quarter();
      clock_half();
    }
    return;
  }
  uint32_t channel = offset == 3u   ? 0u
                     : offset == 7u ? 1u
                     : offset == 11u ? 2u
                     : offset == 15u ? 3u
                                     : 4u;
  if (channel == 4u)
    return;
  if (enabled(channel))
    length_counter[channel] = lengths_table[value >> 3u];
  if (channel < 2u) {
    phase[channel] = 0;
    envelopes[channel].start = 1;
  } else if (channel == 2u) {
    linear_reload = 1;
  } else {
    envelopes[2].start = 1;
  }
}

static void advance_frame(void) {
  static const uint16_t four_step[4] = {7457u, 14913u, 22371u, 29829u};
  static const uint16_t five_step[4] = {7457u, 14913u, 22371u, 37281u};
  uint8_t five = (registers[0x17u] & 128u) != 0u;
  const uint16_t *steps = five ? five_step : four_step;
  frame_cycles += CPU_RATE / MINTNES_AUDIO_RATE;
  if (frame_cycles < steps[frame_step])
    return;
  clock_quarter();
  if (frame_step & 1u)
    clock_half();
  frame_step++;
  if (frame_step == 4u) {
    frame_step = 0;
    frame_cycles -= five ? 37282.0 : 29830.0;
  }
}

static double pulse(uint32_t channel) {
  if (!enabled(channel) || !length_counter[channel])
    return 0;
  uint16_t period = timer(channel);
  uint8_t sweep = registers[channel * 4u + 1u];
  uint8_t shift = sweep & 7u;
  if (period < 8u || ((sweep & 128u) && shift && !(sweep & 8u) &&
                      period + (period >> shift) > 2047u))
    return 0;
  phase[channel] += CPU_RATE / (16.0 * (period + 1u) * MINTNES_AUDIO_RATE);
  if (phase[channel] >= 1.0)
    phase[channel] -= (uint32_t)phase[channel];
  static const double duty[4] = {0.125, 0.25, 0.5, 0.75};
  return phase[channel] < duty[registers[channel * 4u] >> 6u]
             ? volume(channel)
             : 0;
}

static double triangle(void) {
  if (!enabled(2u) || !length_counter[2] || !linear_counter)
    return 0;
  uint16_t period = timer(2u);
  if (period < 2u)
    return 0;
  phase[2] += CPU_RATE / (32.0 * (period + 1u) * MINTNES_AUDIO_RATE);
  if (phase[2] >= 1.0)
    phase[2] -= (uint32_t)phase[2];
  uint32_t step = (uint32_t)(phase[2] * 32.0);
  return step < 16u ? 15u - step : step - 16u;
}

static double noise(void) {
  noise_phase += CPU_RATE /
                 (noise_periods[registers[14] & 15u] * MINTNES_AUDIO_RATE);
  while (noise_phase >= 1.0) {
    noise_phase -= 1.0;
    uint32_t tap = (registers[14] & 128u) ? 6u : 1u;
    noise_shift = (noise_shift >> 1u) |
                  (((noise_shift ^ (noise_shift >> tap)) & 1u) << 14u);
  }
  return enabled(3u) && length_counter[3] && !(noise_shift & 1u)
             ? volume(3u)
             : 0;
}

void mintnes_audio_render(int16_t *stereo, uint32_t frames) {
  if (!stereo || frames > 4096u)
    return;
  for (uint32_t i = 0; i < frames; i++) {
    advance_frame();
    double p = pulse(0u) + pulse(1u), t = triangle(), n = noise();
    double pulse_out = p ? 95.88 / (8128.0 / p + 100.0) : 0;
    double tnd = t / 8227.0 + n / 12241.0;
    double mixed = pulse_out + (tnd ? 159.79 / (1.0 / tnd + 100.0) : 0);
    hp90 = 0.9883 * (hp90 + mixed - hp90_input);
    hp90_input = mixed;
    hp440 = 0.9440 * (hp440 + hp90 - hp440_input);
    hp440_input = hp90;
    lp += 0.8402 * (hp440 - lp);
    double sample = lp * 27852.0;
    int16_t value = (int16_t)(sample > 32767.0 ? 32767
                              : sample < -32768.0 ? -32768
                                                  : (int32_t)sample);
    stereo[i * 2u] = value;
    stereo[i * 2u + 1u] = value;
  }
}
