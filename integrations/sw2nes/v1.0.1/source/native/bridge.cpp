// Minimal C API over QuickNES for the wasm2js build.
// All pointers returned here are offsets into the module heap.
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "Nes_Emu.h"
#include "Nes_Buffer.h"
#include "Data_Reader.h"
#include "abstract_file.h"
#ifdef SW2NES_PROFILE
#include <emscripten.h>
double sw2nes_prof[8];  // 0 frame, 1 cpu (from JS), 2 convert, 3 audio read; ms
#define PROF_T() emscripten_get_now()
#else
#define PROF_T() 0.0
#endif

#define EXPORT extern "C" __attribute__((used, visibility("default")))

enum { WIDTH = Nes_Emu::image_width, HEIGHT = Nes_Emu::image_height };
enum { BUF_W = WIDTH + 16, BUF_H = HEIGHT + 2 };
enum { SAMPLE_RATE = 48000, MAX_SAMPLES = 4096, AUDIO_CAP = 8192 };

static Nes_Emu* emu = 0;
static Nes_Buffer nes_buffer;           // non-linear NES mixer, mono
alignas(16) static uint8_t index_buffer[BUF_W * BUF_H];
static uint32_t rgba[WIDTH * HEIGHT];
static int16_t mono[MAX_SAMPLES];
static int16_t stereo[AUDIO_CAP * 2];
// Audio resampler state, 16.16 fixed point: integer-only, because doubles in
// jitless JS are heap-allocated (float math here caused frequent GC pauses).
static int rs_pos = 0, rs_step = 0x10000;
static int16_t rs_last = 0;
static int audio_vol = 256, audio_lp = 0, lp_state = 0;
static int audio_fill = 0;  // stereo frames accumulated since nes_audio_take()
static uint32_t palette32[256];
static short last_palette[Nes_Emu::max_palette_size];
static bool palette_valid = false;
static uint8_t* rom = 0;
static long rom_size = 0;
static char* state_buf = 0;
static long state_cap = 0;
static long state_len = 0;
static int crop_top = 8;  // rows hidden by NTSC overscan
// Indices of the last converted frame. RGBA output persists between frames,
// so only 4-pixel groups whose palette indices changed are re-converted.
alignas(16) static uint32_t prev_index[(BUF_W / 4) * BUF_H];
static bool prev_valid = false;
static int fmt16 = 0;
static uint32_t rgb16[(WIDTH * HEIGHT) / 2];
static uint16_t pal16[256];
static uint32_t lut2[65536];
static bool lut_valid = false;
static int heavy = 0;        // previous frame changed most groups: skip compares
static int frames_drawn = 0;
static int convert_pending = 0;  // frame rendered with render=2, not yet converted


EXPORT uint8_t* nes_rom_alloc(long size) {
  free(rom); rom = (uint8_t*)malloc(size); rom_size = rom ? size : 0; return rom;
}

EXPORT void nes_unload() {
  audio_fill = 0; rs_pos = 0; rs_step = 0x10000; rs_last = 0; convert_pending = 0; lp_state = 0;
  if (emu) { emu->close(); delete emu; emu = 0; }
  palette_valid = false;
  prev_valid = false;
  lut_valid = false;
  heavy = 0;
}

// Returns 0 on success, otherwise a pointer to an error string.
EXPORT const char* nes_load() {
  nes_unload();
  if (!rom || rom_size < 16) return "No ROM data";
  emu = new Nes_Emu;
  const char* err = emu->set_sample_rate(SAMPLE_RATE, &nes_buffer);
  if (err) return err;
  emu->set_equalizer(Nes_Emu::nes_eq);
  emu->set_palette_range(0);
  emu->set_pixels(index_buffer, BUF_W);
  Mem_File_Reader reader(rom, rom_size);
  err = emu->load_ines(reader);
  if (err) { nes_unload(); return err; }
  return 0;
}

EXPORT void nes_reset(int hard) { if (emu) emu->reset(hard != 0, false); }

// Output formats: RGBA8 (DXGI 28) or 16-bit B5G6R5 (DXGI 85: red in the high
// bits). 16-bit output converts two pixels per table lookup via lut2, indexed by
// a pair of palette indices; lut2 rows/columns are updated only for palette
// entries that actually changed.

EXPORT void nes_invalidate_video() { prev_valid = false; }
static void convert();
// Re-convert the current frame (e.g. after an output format change) without emulating.
EXPORT void nes_reconvert() { if (emu) { prev_valid = false; convert(); } }
// Test hook: force heavy (scrolling) conversion mode from the next diff evaluation on.
static int force_heavy = 0;
EXPORT void nes_test_force_heavy(int on) { force_heavy = on; }
// 0: RGBA8 (DXGI 28); 1: B5G6R5 (DXGI 85); 2: B5G5R5A1 opaque (DXGI 86).
EXPORT void nes_set_format16(int mode) { fmt16 = (mode == 1 || mode == 2) ? mode : 0; palette_valid = false; prev_valid = false; lut_valid = false; }
EXPORT int nes_bytes_per_pixel() { return fmt16 ? 2 : 4; }

// Optional user palette (512 entries incl. emphasis, RGB bytes), set from JS.
static uint8_t custom_pal[512 * 3];
static bool custom_pal_on = false;
EXPORT uint8_t* nes_palette_buffer() { return custom_pal; }
EXPORT void nes_use_palette(int on) { custom_pal_on = on != 0; palette_valid = false; prev_valid = false; lut_valid = false; }

static void update_palette(const Nes_Emu::frame_t& frame) {
  if (palette_valid && !memcmp(last_palette, frame.palette, sizeof(last_palette))) return;
  int changed[256], nchanged = 0;
#ifdef SW2NES_PROFILE
  sw2nes_prof[5] += 1;
#endif
  for (int i = 0; i < 256; i++) {
    if (palette_valid && last_palette[i] == frame.palette[i]) continue;
    Nes_Emu::rgb_t c = Nes_Emu::nes_colors[frame.palette[i]];
    if (custom_pal_on) { const uint8_t* q = custom_pal + (frame.palette[i] & 511) * 3; c.red = q[0]; c.green = q[1]; c.blue = q[2]; }
    palette32[i] = 0xff000000u | ((uint32_t)c.blue << 16) | ((uint32_t)c.green << 8) | c.red;
    pal16[i] = fmt16 == 2 ? (uint16_t)(0x8000 | ((c.red >> 3) << 10) | ((c.green >> 3) << 5) | (c.blue >> 3))
                          : (uint16_t)(((c.red >> 3) << 11) | ((c.green >> 2) << 5) | (c.blue >> 3));
    changed[nchanged++] = i;
  }
  if (fmt16) {
    if (!lut_valid || nchanged > 48) {
      for (int hi = 0; hi < 256; hi++) {
        uint32_t h = (uint32_t)pal16[hi] << 16; uint32_t* row = lut2 + (hi << 8);
        for (int lo = 0; lo < 256; lo++) row[lo] = h | pal16[lo];
      }
      lut_valid = true;
    } else {
      for (int k = 0; k < nchanged; k++) {
        int i = changed[k]; uint32_t pi = pal16[i];
        uint32_t* row = lut2 + (i << 8);
        for (int j = 0; j < 256; j++) { row[j] = (pi << 16) | pal16[j]; lut2[(j << 8) | i] = ((uint32_t)pal16[j] << 16) | pi; }
      }
    }
  }
  memcpy(last_palette, frame.palette, sizeof(last_palette));
  palette_valid = true;
  prev_valid = false;  // colours changed: convert everything
}

#ifdef SW2NES_JS_CONVERT
extern "C" int sw2nes_js_convert(const uint8_t* in, int pitch, uint32_t* out, uint32_t* prev, const uint32_t* pal, int rows, int mode);
#endif

static void convert() {
  const Nes_Emu::frame_t& frame = emu->frame();
#ifdef SW2NES_PROFILE
  double tp = PROF_T();
#endif
  update_palette(frame);
#ifdef SW2NES_PROFILE
  sw2nes_prof[7] += PROF_T() - tp;
#endif
  const uint8_t* in = frame.pixels + crop_top * BUF_W;
  uint32_t* prev = prev_index + crop_top * (WIDTH / 4);
  // Heavy mode (most of the frame changes, e.g. scrolling): convert everything
  // without comparing, and keep the comparison copy only on the frame before a
  // periodic re-check (every 16 drawn frames).
  bool full = true, store = true;
  if (prev_valid && heavy) {
    int k = ++frames_drawn & 15;
    if (k == 0) full = false; else store = (k == 15);
  } else if (prev_valid) full = false;
  int changed = 0;
#ifdef SW2NES_PROFILE
  if (full) sw2nes_prof[6] += 1;
#endif
  // Inner loops handle 4 groups (16 pixels) per iteration: in the jitless
  // interpreter, per-iteration loop overhead costs more than the loads.
  if (fmt16) {
    const uint32_t* L = lut2;
    uint32_t* out = rgb16 + crop_top * (WIDTH / 2);
    for (int y = crop_top; y < HEIGHT - crop_top; y++, in += BUF_W, prev += WIDTH / 4, out += WIDTH / 2) {
      const uint32_t* sp = (const uint32_t*)in; uint32_t* p = prev; uint32_t* o = out;
      for (int x = 0; x < WIDTH / 16; x++, sp += 4, p += 4, o += 8) {
        uint32_t v0 = sp[0], v1 = sp[1], v2 = sp[2], v3 = sp[3];
        if (!full) {
          if (!((v0 ^ p[0]) | (v1 ^ p[1]) | (v2 ^ p[2]) | (v3 ^ p[3]))) continue;
          changed++;
        }
        if (store) { p[0] = v0; p[1] = v1; p[2] = v2; p[3] = v3; }
        o[0] = L[v0 & 0xFFFF]; o[1] = L[v0 >> 16]; o[2] = L[v1 & 0xFFFF]; o[3] = L[v1 >> 16];
        o[4] = L[v2 & 0xFFFF]; o[5] = L[v2 >> 16]; o[6] = L[v3 & 0xFFFF]; o[7] = L[v3 >> 16];
      }
    }
  } else {
#ifdef SW2NES_JS_CONVERT
    // Hand-written JS (native/convert_lib.js); counts changed 4-pixel words.
    changed = sw2nes_js_convert(in, BUF_W, rgba + crop_top * WIDTH, prev, palette32,
                                HEIGHT - 2 * crop_top, full ? (store ? 1 : 2) : 0);
    if (!full) heavy = force_heavy || changed * 100 > ((HEIGHT - 2 * crop_top) * (WIDTH / 4)) * 85;
    prev_valid = true;
    return;
#endif
    const uint32_t* pal = palette32;
    uint32_t* out = rgba + crop_top * WIDTH;
    for (int y = crop_top; y < HEIGHT - crop_top; y++, in += BUF_W, prev += WIDTH / 4, out += WIDTH) {
      const uint32_t* sp = (const uint32_t*)in; uint32_t* p = prev; uint32_t* o = out;
      for (int x = 0; x < WIDTH / 16; x++, sp += 4, p += 4, o += 16) {
        uint32_t v0 = sp[0], v1 = sp[1], v2 = sp[2], v3 = sp[3];
        if (!full) {
          if (!((v0 ^ p[0]) | (v1 ^ p[1]) | (v2 ^ p[2]) | (v3 ^ p[3]))) continue;
          changed++;
        }
        if (store) { p[0] = v0; p[1] = v1; p[2] = v2; p[3] = v3; }
        o[0] = pal[v0 & 255]; o[1] = pal[(v0 >> 8) & 255]; o[2] = pal[(v0 >> 16) & 255]; o[3] = pal[v0 >> 24];
        o[4] = pal[v1 & 255]; o[5] = pal[(v1 >> 8) & 255]; o[6] = pal[(v1 >> 16) & 255]; o[7] = pal[v1 >> 24];
        o[8] = pal[v2 & 255]; o[9] = pal[(v2 >> 8) & 255]; o[10] = pal[(v2 >> 16) & 255]; o[11] = pal[v2 >> 24];
        o[12] = pal[v3 & 255]; o[13] = pal[(v3 >> 8) & 255]; o[14] = pal[(v3 >> 16) & 255]; o[15] = pal[v3 >> 24];
      }
    }
  }
  if (!full) heavy = force_heavy || changed * 100 > ((HEIGHT - 2 * crop_top) * (WIDTH / 16)) * 85;
  prev_valid = true;  // stale only within heavy mode, which re-stores before any diff
}

// Runs one frame and appends its audio to the stereo accumulator.
// Returns the number of stereo sample frames this frame produced.
// render=0 uses QuickNES's cheaper skip path and leaves the image unchanged.
// render=2 renders but leaves pixel conversion for nes_convert(), so the caller
// can move it to the next tick after a heavy frame; it must run before the
// next nes_frame or present.
EXPORT void nes_convert() { if (convert_pending) { convert_pending = 0; convert(); } }
EXPORT int nes_frame(int pad1, int pad2, int render) {
  if (!emu) return -1;
  nes_convert();  // a deferred frame is never lost, even if the caller forgot
  double t0 = PROF_T();
  const char* err = render ? emu->emulate_frame(pad1, pad2) : emu->emulate_skip_frame(pad1, pad2);
  if (err) return -2;
  double t1 = PROF_T();
  if (render == 2) convert_pending = 1;
  else if (render) convert();
  double t2 = PROF_T();
  long n = emu->read_samples(mono, MAX_SAMPLES);
  if (audio_vol != 256 || audio_lp) {
    // Volume (x/256) and an optional one-pole low-pass that softens the harsh top end.
    for (long i = 0; i < n; i++) {
      int v = (mono[i] * audio_vol) >> 8;
      if (audio_lp) { lp_state += (v - lp_state) >> audio_lp; v = lp_state; }
      mono[i] = (short)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
  }
#ifdef SW2NES_PROFILE
  double t3 = PROF_T();
  sw2nes_prof[0] += t1 - t0; sw2nes_prof[2] += t2 - t1; sw2nes_prof[3] += t3 - t2;
#endif
  // Output up to n*ratio+2 frames; the cap leaves room (ratio <= 1.01).
  if (audio_fill + n + n / 64 + 4 > AUDIO_CAP) audio_fill = 0;  // consumer stalled; drop backlog
  int16_t* dst = stereo + audio_fill * 2;
  int out = 0;
  if (rs_step == 0x10000 && rs_pos == 0) {
    // Unity ratio: plain one-sample delay (bit-exact with the input stream).
    for (long i = 0; i < n; i++) { int16_t v = rs_last; dst[0] = v; dst[1] = v; dst += 2; rs_last = mono[i]; }
    out = (int)n;
  } else {
    // Linear resampler: rs_pos is the read position between rs_last and the next sample.
    for (long i = 0; i < n; i++) {
      int x = mono[i];
      while (rs_pos < 0x10000) {
        int16_t v = (int16_t)(rs_last + (((x - rs_last) * (rs_pos >> 2)) >> 14));  // fits in 32 bits
        dst[0] = v; dst[1] = v; dst += 2; out++;
        rs_pos += rs_step;
      }
      rs_pos -= 0x10000; rs_last = (int16_t)x;
    }
  }
  audio_fill += out;
  return out;
}

// Audio volume (0..256 = 0..100%) and low-pass strength (0 off, 1 soft, 2 strong).
EXPORT void nes_set_audio(int volume, int lowpass) {
  audio_vol = volume < 0 ? 0 : volume > 512 ? 512 : volume;
  audio_lp = lowpass < 0 ? 0 : lowpass > 3 ? 3 : lowpass;
}
// Program ROM, for Game Genie patches applied from JS.
EXPORT uint8_t* nes_prg() { return emu && emu->cart() ? (uint8_t*) emu->cart()->prg() : 0; }
EXPORT long nes_prg_size() { return emu && emu->cart() ? emu->cart()->prg_size() : 0; }

// Audio stretch factor (output samples per emulated sample), clamped to +-1%.
// Lets emulation lock to the display rate while AudioOut stays fed.
EXPORT void nes_set_audio_ratio(double ratio) {
  if (ratio < 0.99) ratio = 0.99; if (ratio > 1.01) ratio = 1.01;
  rs_step = (int)(65536.0 / ratio + 0.5);
  if (rs_step == 0x10000) rs_pos = 0;
}

// Returns the stereo frames accumulated at nes_audio() and resets the accumulator.
EXPORT int nes_audio_take() { int n = audio_fill; audio_fill = 0; return n; }

EXPORT uint32_t* nes_video() { return fmt16 ? rgb16 + crop_top * (WIDTH / 2) : rgba + crop_top * WIDTH; }
EXPORT int nes_width() { return WIDTH; }
EXPORT int nes_height() { return HEIGHT - crop_top * 2; }
EXPORT int16_t* nes_audio() { return stereo; }
EXPORT int nes_sample_rate() { return SAMPLE_RATE; }
#ifdef SW2NES_PROFILE
EXPORT double nes_prof(int i) { return sw2nes_prof[i]; }
EXPORT double* nes_prof_ptr() { return sw2nes_prof; }
#endif

EXPORT int nes_has_battery() { return emu && emu->has_battery_ram() ? 1 : 0; }
EXPORT uint8_t* nes_sram() { return emu ? emu->high_mem() : 0; }
// Diagnostics: CPU work RAM ($0000-$07FF).
EXPORT uint8_t* nes_ram() { return emu ? emu->low_mem() : 0; }
EXPORT int nes_sram_size() { return Nes_Emu::high_mem_size; }

// Save state into an internal buffer; returns its length (0 on failure).
EXPORT long nes_state_save() {
  if (!emu) return 0;
  Mem_Writer probe;
  if (emu->save_state(probe)) return 0;
  long size = probe.size();
  if (size > state_cap) {
    free(state_buf); state_buf = (char*)malloc(size); state_cap = state_buf ? size : 0;
    if (!state_buf) return 0;
  }
  Mem_Writer writer(state_buf, state_cap);
  if (emu->save_state(writer)) return 0;
  state_len = writer.size();
  return state_len;
}
EXPORT char* nes_state_buffer(long size) {
  if (size > state_cap) {
    free(state_buf); state_buf = (char*)malloc(size); state_cap = state_buf ? size : 0;
  }
  return state_buf;
}
EXPORT int nes_state_load(long size) {
  if (!emu || !state_buf || size <= 0 || size > state_cap) return 0;
  Mem_File_Reader reader(state_buf, size);
  return emu->load_state(reader) ? 0 : 1;
}
