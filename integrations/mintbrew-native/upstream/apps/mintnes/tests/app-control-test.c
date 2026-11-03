#include "hbx_app.h"
#include "hbx_ui.h"
#include "mintnes_output.h"
#include <stdarg.h>
#include <stdio.h>

extern int hbx_app_main(const struct hbx_ctx *ctx);

static uint8_t rom[65536];
static uint32_t rom_size;
static uint32_t input_step;
static uint32_t hold_mode;
static uint32_t refresh_mode;
static uint32_t auto_mode;
static uint32_t manual_start_mode;
static uint32_t automatic_starts;
static uint32_t isolated_auto_start;
static uint32_t halt_reports;
static uint32_t images;
static uint32_t presents;
static uint32_t menu_titles;
static uint32_t pauses;
static uint32_t asset_reads;
static uint32_t subtitle_seen;
static uint32_t author_seen;
static uint32_t subtitle_bullets;
static uint32_t control_label_mask;
static uint32_t control_action_mask;
static uint32_t control_alignment_errors;

static const struct {
  float y;
  const char *control;
  const char *action;
} control_rows[] = {
    {370, "A", "Play selected game"},
    {424, "Up / Down", "Choose game"},
    {478, "X", "Refresh ROM list"},
    {532, "B", "Return to launcher"},
    {691, "Plus / X", "Start / Select"},
    {737, "D-pad / stick", "Move"},
    {783, "A / B", "NES A / B"},
    {829, "Minus", "Return to list"},
};

static float text_width(void *self, uint32_t font, const char *value) {
  float width = 0;
  (void)self;
  (void)font;
  while (*value++)
    width += 10;
  return width;
}

hbx_status hbx_ctx_check(const struct hbx_ctx *ctx) {
  return ctx ? HBX_OK : HBX_ERR_ABI;
}

void hbx_input_poll(const struct hbx_ctx *ctx, struct hbx_input_state *input) {
  static const uint32_t sequence[] = {HBX_A,     0, HBX_A, HBX_B,
                                      HBX_MINUS, 0, HBX_B};
  hbx_memset(input, 0, sizeof *input);
  if (refresh_mode && input_step == 1u) {
    struct hbx_control *control = (struct hbx_control *)(uintptr_t)ctx->control;
    control->flags = 8u;
  }
  input->buttons = auto_mode ? (input_step == 0u || input_step == 2u ? HBX_A
                               : manual_start_mode && input_step == 45u ? HBX_PLUS
                               : input_step >= 80u && input_step < 100u ? HBX_DOWN
                               : input_step >= 105u ? HBX_MINUS : 0u)
                 : refresh_mode ? (input_step == 0u ? HBX_X
                                    : input_step == 2u ? HBX_B : 0u)
                 : hold_mode ? (input_step == 0u || input_step == 2u ? HBX_A
                                : input_step == 1u ? 0u
                                                   : HBX_MINUS)
                             : sequence[input_step < 7u ? input_step : 6u];
  input->pressed = input->buttons;
  input_step++;
}

const void *hbx_asset(const struct hbx_ctx *ctx, const char *name,
                      uint32_t *size) {
  (void)ctx;
  if (!hbx_streq(name, "Diamond Chase.nes"))
    return NULL;
  asset_reads++;
  *size = rom_size;
  return rom;
}

void hbx_logf(const struct hbx_ctx *ctx, const char *format, ...) {
  (void)ctx;
  if (hbx_streq(format, "mintnes: automatic start"))
    automatic_starts++;
  if (auto_mode && automatic_starts &&
      hbx_streq(format, "mintnes: pad %x -> nes %x, connected %u") &&
      !isolated_auto_start) {
    va_list args;
    va_start(args, format);
    uint32_t pad = va_arg(args, uint32_t);
    uint32_t mapped = va_arg(args, uint32_t);
    va_end(args);
    if (pad & HBX_DOWN)
      isolated_auto_start = mapped == 8u ? 1u : 2u;
  }
  if (hbx_streq(format, "mintnes: emulator stopped at frame %u, code %x"))
    halt_reports++;
}

void hbx_sleep_ns(uint64_t nanoseconds) { (void)nanoseconds; }

uint64_t hbx_pace(const struct hbx_ctx *ctx, uint64_t *deadline, uint32_t hz) {
  (void)ctx;
  if (hz != 60u || !deadline)
    return 0;
  *deadline += 1000000000ull / hz;
  return *deadline;
}

int mintnes_output_open(const struct hbx_ctx *ctx) {
  (void)ctx;
  return 1;
}

int mintnes_output_submit(const struct hbx_ctx *ctx, const int16_t *stereo,
                          uint32_t frames) {
  (void)ctx;
  (void)stereo;
  (void)frames;
  return 1;
}

int mintnes_output_pause(const struct hbx_ctx *ctx) {
  (void)ctx;
  pauses++;
  return 1;
}

int mintnes_output_close(const struct hbx_ctx *ctx) {
  (void)ctx;
  return 1;
}

static void begin(void *self, uint32_t color) {
  (void)self;
  (void)color;
}

static void rect(void *self, float x, float y, float w, float h, float radius,
                 uint32_t color) {
  (void)self;
  (void)x;
  (void)color;
  if (y == 199 && w == 6 && h == 6 && radius == 3)
    subtitle_bullets++;
}

static void stroke(void *self, float x, float y, float w, float h, float radius,
                   float thickness, uint32_t color) {
  (void)self;
  (void)x;
  (void)y;
  (void)w;
  (void)h;
  (void)radius;
  (void)thickness;
  (void)color;
}

static float draw_text(void *self, float x, float y, uint32_t font,
                       const char *value, uint32_t color) {
  (void)self;
  (void)color;
  if (hbx_streq(value, "ROM LIBRARY"))
    menu_titles++;
  if (hbx_streq(value, "experimental"))
    subtitle_seen++;
  if (hbx_streq(value, "by cpypwn"))
    author_seen++;
  for (uint32_t i = 0; i < sizeof control_rows / sizeof control_rows[0]; i++) {
    if (y != control_rows[i].y || font != HBX_FONT_BODY)
      continue;
    if (hbx_streq(value, control_rows[i].control)) {
      control_label_mask |= 1u << i;
      if (x != 1352)
        control_alignment_errors++;
    }
    if (hbx_streq(value, control_rows[i].action)) {
      control_action_mask |= 1u << i;
      if (x + text_width(self, font, value) != 1728 ||
          x < 1352 + text_width(self, font, control_rows[i].control) + 16)
        control_alignment_errors++;
    }
  }
  return 0;
}

static void draw_image(void *self, float x, float y, float w, float h,
                       const void *pixels, uint32_t iw, uint32_t ih) {
  (void)self;
  (void)x;
  (void)y;
  (void)w;
  (void)h;
  (void)pixels;
  if (iw == 256u && ih == 240u)
    images++;
}

static int present(void *self) {
  (void)self;
  presents++;
  return HBX_OK;
}

int main(int argc, char **argv) {
  FILE *file;
  struct hbx_ctx ctx;
  struct hbx_render render;
  struct hbx_ui_ops ops;
  struct hbx_asset_table table;
  struct hbx_control control;
  uint8_t data[2048];
  if (argc != 2)
    return 2;
  file = fopen(argv[1], "rb");
  if (!file)
    return 2;
  rom_size = (uint32_t)fread(rom, 1, sizeof rom, file);
  fclose(file);
  hbx_memset(&ctx, 0, sizeof ctx);
  hbx_memset(&render, 0, sizeof render);
  hbx_memset(&ops, 0, sizeof ops);
  hbx_memset(data, 0, sizeof data);
  hbx_memset(&control, 0, sizeof control);
  table.magic = HBX_ASSET_MAGIC;
  table.count = 1;
  table.entries[0].name_off = 1100;
  hbx_memcpy(data + 1100, "Diamond Chase.nes", 18);
  ctx.data_base = (uint64_t)(uintptr_t)data;
  ctx.data_size = sizeof data;
  ctx.assets = (uint64_t)(uintptr_t)&table;
  ctx.control = (uint64_t)(uintptr_t)&control;
  ctx.ui = (uint64_t)(uintptr_t)&render;
  render.abi = HBX_RENDER_ABI;
  render.size = sizeof render;
  render.self = &render;
  render.ops = &ops;
  ops.abi = HBX_RENDER_ABI;
  ops.size = sizeof ops;
  ops.begin = begin;
  ops.rect = rect;
  ops.stroke = stroke;
  ops.text = draw_text;
  ops.text_width = text_width;
  ops.image = draw_image;
  ops.present = present;
  if (hbx_app_main(&ctx) != HBX_OK)
    return 3;
  if (images != 2u || presents != 5u || menu_titles != 3u ||
      !subtitle_seen || !author_seen || !subtitle_bullets ||
      control_label_mask != 0xffu ||
      control_action_mask != 0xffu || control_alignment_errors ||
      input_step != 7u || pauses != 1u)
    return 4;
  hold_mode = 1;
  input_step = images = presents = menu_titles = pauses = 0;
  if (hbx_app_main(&ctx) != HBX_OK)
    return 5;
  if (images != 44u || presents != 46u || menu_titles != 2u ||
      input_step != 48u || pauses != 0u)
    return 6;
  refresh_mode = 1;
  hold_mode = 0;
  input_step = images = presents = menu_titles = pauses = asset_reads = 0;
  if (hbx_app_main(&ctx) != HBX_OK)
    return 7;
  if (images || presents != 2u || menu_titles != 2u ||
      input_step != 3u || asset_reads != 2u || control.flags)
    return 8;
  auto_mode = 1;
  refresh_mode = 0;
  input_step = images = presents = menu_titles = pauses = automatic_starts =
      isolated_auto_start = 0;
  if (hbx_app_main(&ctx) != HBX_OK || automatic_starts != 1u ||
      isolated_auto_start != 1u || input_step < 149u)
    return 9;
  manual_start_mode = 1;
  input_step = images = presents = menu_titles = pauses = automatic_starts = 0;
  if (hbx_app_main(&ctx) != HBX_OK || automatic_starts != 0u ||
      input_step < 149u)
    return 10;
  rom[16] = 0x02u;
  rom[16 + 0x7ffcu] = 0x00u;
  rom[16 + 0x7ffdu] = 0x80u;
  auto_mode = manual_start_mode = 0;
  input_step = halt_reports = 0;
  if (hbx_app_main(&ctx) != HBX_ERR_INTERNAL || halt_reports != 1u ||
      input_step != 4u)
    return 11;
  printf("MintNES menu, B input, automatic Start and Minus exit passed\n");
  return 0;
}
