#include "hbx_app.h"
#include "hbx_ui.h"
#include "mintnes_core.h"
#include "mintnes_audio.h"
#include "mintnes_output.h"
#include "palette.h"

#define MAX_ROMS 64u
#define VISIBLE_ROMS 8u

struct rom_entry {
  const uint8_t *data;
  uint32_t size;
  char title[48];
};

static struct rom_entry roms[MAX_ROMS];
static uint32_t rom_count;
static uint8_t indices[MINTNES_PIXELS];
static uint32_t rgba[MINTNES_PIXELS];
static int16_t pcm[MINTNES_AUDIO_FRAME_SAMPLES * 2u];

static char lowercase(char value) {
  return value >= 'A' && value <= 'Z' ? (char)(value + ('a' - 'A')) : value;
}

static uint32_t name_length(const char *name, uint32_t maximum) {
  uint32_t length = 0;
  while (length < maximum && name[length])
    length++;
  return length;
}

static int nes_name(const char *name, uint32_t length) {
  return length >= 5u && lowercase(name[length - 4u]) == '.' &&
         lowercase(name[length - 3u]) == 'n' &&
         lowercase(name[length - 2u]) == 'e' &&
         lowercase(name[length - 1u]) == 's';
}

static void copy_title(char *target, const char *name, uint32_t length) {
  uint32_t start = 0;
  uint32_t copied = 0;
  for (uint32_t i = 0; i < length; i++) {
    if (name[i] == '/' || name[i] == '\\')
      start = i + 1u;
  }
  length -= 4u;
  for (uint32_t i = start; i < length && copied < 43u; i++) {
    unsigned char character = (unsigned char)name[i];
    target[copied++] =
        character >= 32u && character < 127u ? (char)character : '_';
  }
  if (copied == 43u && length - start > 43u) {
    target[40] = '.';
    target[41] = '.';
    target[42] = '.';
  }
  target[copied] = 0;
}

static void discover_roms(const struct hbx_ctx *ctx) {
  const struct hbx_asset_table *table =
      (const struct hbx_asset_table *)(uintptr_t)ctx->assets;
  rom_count = 0;
  if (!table || table->magic != HBX_ASSET_MAGIC ||
      table->count > HBX_MAX_ASSETS)
    return;
  for (uint32_t i = 0; i < table->count && rom_count < MAX_ROMS; i++) {
    const struct hbx_asset_entry *entry = &table->entries[i];
    const char *name;
    uint32_t remaining, length, size;
    const uint8_t *data;
    if (entry->name_off >= ctx->data_size)
      continue;
    name = (const char *)(uintptr_t)(ctx->data_base + entry->name_off);
    remaining = (uint32_t)(ctx->data_size - entry->name_off);
    length =
        name_length(name, remaining < HBX_PATH_MAX ? remaining : HBX_PATH_MAX);
    if (length == 0 || length == HBX_PATH_MAX || length >= remaining ||
        !nes_name(name, length))
      continue;
    data = hbx_asset(ctx, name, &size);
    if (!mintnes_supported_rom(data, size))
      continue;
    roms[rom_count].data = data;
    roms[rom_count].size = size;
    copy_title(roms[rom_count].title, name, length);
    rom_count++;
  }
}

static void number(char *out, uint32_t value) {
  char reversed[12];
  uint32_t count = 0;
  do {
    reversed[count++] = (char)('0' + value % 10u);
    value /= 10u;
  } while (value && count < 12u);
  for (uint32_t i = 0; i < count; i++)
    out[i] = reversed[count - 1u - i];
  out[count] = 0;
}

static void control_row(const struct hbx_ctx *ctx, float y,
                        const char *control, const char *action) {
  const float action_x = 1728.0f - hbx_ui_text_width(ctx, HBX_FONT_BODY, action);
  hbx_ui_text(ctx, 1352, y, HBX_FONT_BODY, control, HBX_RGB(226, 252, 235));
  hbx_ui_text(ctx, action_x, y, HBX_FONT_BODY, action,
              HBX_RGB(162, 198, 179));
}

static int draw_menu(const struct hbx_ctx *ctx, uint32_t selected,
                     uint32_t refresh_state) {
  char count[12];
  uint32_t top = selected >= VISIBLE_ROMS ? selected - VISIBLE_ROMS + 1u : 0u;
  number(count, rom_count);
  hbx_ui_begin(ctx, HBX_RGB(5, 23, 19));
  hbx_ui_rect(ctx, 96, 68, 1728, 944, 28, HBX_RGB(14, 43, 35));
  hbx_ui_stroke(ctx, 96, 68, 1728, 944, 28, 2, HBX_RGB(42, 95, 75));
  hbx_ui_rect(ctx, 150, 116, 12, 100, 6, HBX_RGB(145, 246, 191));
  hbx_ui_text(ctx, 188, 92, HBX_FONT_TITLE, "MintNES", HBX_RGB(235, 255, 242));
  hbx_ui_text(ctx, 191, 188, HBX_FONT_BODY, "by cpypwn",
              HBX_RGB(162, 198, 179));
  const float bullet_x = 204.0f + hbx_ui_text_width(ctx, HBX_FONT_BODY, "by cpypwn");
  hbx_ui_rect(ctx, bullet_x, 199, 6, 6, 3, HBX_RGB(162, 198, 179));
  hbx_ui_text(ctx, bullet_x + 18.0f, 188, HBX_FONT_BODY, "experimental",
              HBX_RGB(162, 198, 179));
  hbx_ui_rect(ctx, 1455, 129, 305, 62, 14, HBX_RGB(29, 79, 61));
  hbx_ui_stroke(ctx, 1455, 129, 305, 62, 14, 2, HBX_RGB(91, 176, 129));
  hbx_ui_text(ctx, 1482, 146, HBX_FONT_H2,
              refresh_state == 1u ? "REFRESHING" :
              refresh_state == 2u ? "LIST UPDATED" :
              refresh_state == 3u ? "X  TRY AGAIN" : "X  REFRESH ROMS",
              HBX_RGB(197, 255, 217));
  hbx_ui_rect(ctx, 152, 244, 1132, 680, 20, HBX_RGB(10, 32, 27));
  hbx_ui_stroke(ctx, 152, 244, 1132, 680, 20, 2, HBX_RGB(40, 83, 65));
  hbx_ui_text(ctx, 192, 273, HBX_FONT_H2, "ROM LIBRARY", HBX_RGB(226, 252, 235));
  hbx_ui_text(ctx, 1180, 281, HBX_FONT_SMALL, count, HBX_RGB(154, 235, 183));
  hbx_ui_rect(ctx, 192, 327, 1052, 2, 0, HBX_RGB(40, 83, 65));
  if (!rom_count) {
    hbx_ui_text(ctx, 240, 430, HBX_FONT_H1, "No compatible ROMs yet",
                HBX_RGB(226, 252, 235));
    hbx_ui_text(ctx, 240, 488, HBX_FONT_BODY,
                "Add .nes files on your Mac, then press X to refresh",
                HBX_RGB(162, 198, 179));
  }
  for (uint32_t row = 0; row < VISIBLE_ROMS && top + row < rom_count; row++) {
    const uint32_t index = top + row;
    const float y = 355.0f + 70.0f * (float)row;
    if (index == selected) {
      hbx_ui_rect(ctx, 184, y - 10, 1068, 59, 12, HBX_RGB(27, 78, 59));
      hbx_ui_stroke(ctx, 184, y - 10, 1068, 59, 12, 2, HBX_RGB(151, 246, 197));
      hbx_ui_rect(ctx, 184, y - 10, 8, 59, 4, HBX_RGB(151, 246, 197));
    }
    hbx_ui_text(ctx, 222, y + 2, HBX_FONT_H2, roms[index].title,
                index == selected ? HBX_RGB(237, 255, 244)
                                  : HBX_RGB(190, 216, 200));
  }
  hbx_ui_rect(ctx, 1312, 244, 456, 680, 20, HBX_RGB(10, 32, 27));
  hbx_ui_stroke(ctx, 1312, 244, 456, 680, 20, 2, HBX_RGB(40, 83, 65));
  hbx_ui_text(ctx, 1352, 273, HBX_FONT_H2, "CONTROLS", HBX_RGB(226, 252, 235));
  hbx_ui_rect(ctx, 1352, 327, 376, 2, 0, HBX_RGB(40, 83, 65));
  control_row(ctx, 370, "A", "Play selected game");
  control_row(ctx, 424, "Up / Down", "Choose game");
  control_row(ctx, 478, "X", "Refresh ROM list");
  control_row(ctx, 532, "B", "Return to launcher");
  hbx_ui_rect(ctx, 1352, 610, 376, 2, 0, HBX_RGB(40, 83, 65));
  hbx_ui_text(ctx, 1352, 641, HBX_FONT_H2, "IN GAME", HBX_RGB(226, 252, 235));
  control_row(ctx, 691, "Plus / X", "Start / Select");
  control_row(ctx, 737, "D-pad / stick", "Move");
  control_row(ctx, 783, "A / B", "NES A / B");
  control_row(ctx, 829, "Minus", "Return to list");
  hbx_ui_text(ctx, 1352, 886, HBX_FONT_SMALL, ".nes  /  Mapper 0 (NROM)",
              HBX_RGB(162, 198, 179));
  hbx_ui_text(ctx, 154, 956, HBX_FONT_SMALL,
              "Add or remove ROMs on your Mac while this session is open",
              HBX_RGB(158, 199, 172));
  return hbx_ui_present(ctx);
}

static uint8_t nes_buttons(const struct hbx_input_state *input) {
  uint32_t held = input->buttons;
  uint8_t result = 0;
  if (held & HBX_A)
    result |= 1u;
  if (held & (HBX_B | HBX_Y))
    result |= 2u;
  if (held & HBX_X)
    result |= 4u;
  if (held & HBX_PLUS)
    result |= 8u;
  if ((held & HBX_UP) || input->stick_ly > 40)
    result |= 16u;
  if ((held & HBX_DOWN) || input->stick_ly < -40)
    result |= 32u;
  if ((held & HBX_LEFT) || input->stick_lx < -40)
    result |= 64u;
  if ((held & HBX_RIGHT) || input->stick_lx > 40)
    result |= 128u;
  return result;
}

static int trace_frame(uint32_t frame) {
  return frame == 0u || (frame < 1800u && frame % 120u == 0u) ||
         (frame >= 1800u && frame < 7200u && frame % 600u == 0u);
}

static uint32_t frame_hash(const uint8_t *pixels) {
  uint32_t hash = 2166136261u;
  for (uint32_t i = 0; i < MINTNES_PIXELS; i++)
    hash = (hash ^ pixels[i]) * 16777619u;
  return hash;
}

static int draw_game(const struct hbx_ctx *ctx, uint32_t selected,
                     uint32_t halted) {
  (void)selected;
  (void)halted;
  hbx_ui_begin(ctx, HBX_RGB(0, 0, 0));
  hbx_ui_image(ctx, 240, 0, 1440, 1080, rgba, MINTNES_WIDTH, MINTNES_HEIGHT);
  return hbx_ui_present(ctx);
}

int hbx_app_main(const struct hbx_ctx *ctx) {
  struct hbx_input_state input;
  uint32_t selected = 0;
  uint32_t menu = 1;
  uint32_t held_up = 0;
  uint32_t held_down = 0;
  uint32_t held_minus = 0;
  uint32_t ready_for_a = 0;
  uint32_t halted = 0;
  uint32_t audio_attempted = 0;
  uint32_t audio_enabled = 0;
  uint32_t refresh_state = 0;
  uint8_t last_nes_buttons = 0;
  uint32_t input_log_count = 0;
  uint32_t startup_frame = 0;
  uint32_t auto_start_pending = 0;
  uint64_t deadline = 0;
  int status = HBX_OK;
  if (hbx_ctx_check(ctx) != HBX_OK)
    return HBX_ERR_ABI;
  if (!hbx_ui_available(ctx))
    return HBX_ERR_GPU;
  discover_roms(ctx);
  hbx_memset(&input, 0, sizeof input);
  hbx_logf(ctx, "mintnes: %u mapper-0 roms", rom_count);

  while (!hbx_stop_requested(ctx)) {
    hbx_input_poll(ctx, &input);
    if (menu) {
      volatile struct hbx_control *control =
          (volatile struct hbx_control *)(uintptr_t)ctx->control;
      if (refresh_state == 1u && control) {
        uint32_t flags = control->flags;
        if (flags & (8u | 16u)) {
          refresh_state = (flags & 8u) ? 2u : 3u;
          control->flags = flags & ~(8u | 16u);
          if (refresh_state == 2u) {
            discover_roms(ctx);
            if (selected >= rom_count)
              selected = 0;
            hbx_logf(ctx, "mintnes: refreshed %u mapper-0 roms", rom_count);
          }
        }
      }
      if ((input.pressed & HBX_X) && refresh_state != 1u) {
        if (control) {
          control->flags = (control->flags & ~(8u | 16u)) | 4u;
          refresh_state = 1u;
        } else {
          refresh_state = 3u;
        }
      }
      if (!(input.buttons & HBX_A))
        ready_for_a = 1;
      uint32_t up = (input.buttons & HBX_UP) || input.stick_ly > 40;
      uint32_t down = (input.buttons & HBX_DOWN) || input.stick_ly < -40;
      held_up = up ? held_up + 1u : 0u;
      held_down = down ? held_down + 1u : 0u;
      if ((input.pressed & (HBX_B | HBX_MINUS | HBX_PLUS)) != 0) {
        hbx_logf(ctx, "mintnes: leaving rom list, button %x", input.pressed);
        break;
      }
      if (rom_count) {
        if (held_up == 1u || (held_up > 20u && held_up % 6u == 0u))
          selected = selected ? selected - 1u : rom_count - 1u;
        if (held_down == 1u || (held_down > 20u && held_down % 6u == 0u))
          selected = selected + 1u < rom_count ? selected + 1u : 0u;
        if (ready_for_a && (input.pressed & HBX_A)) {
          if (audio_enabled && !mintnes_output_pause(ctx)) {
            audio_enabled = 0;
            hbx_logf(ctx, "mintnes: audio stopped; continuing silently");
          }
          if (mintnes_load(roms[selected].data, roms[selected].size)) {
            menu = 0;
            refresh_state = 0;
            last_nes_buttons = 0;
            deadline = 0;
            held_minus = 0;
            halted = 0;
            startup_frame = 0;
            auto_start_pending = 1;
            if (!audio_attempted) {
              audio_attempted = 1;
              audio_enabled = mintnes_output_open(ctx);
              if (!audio_enabled)
                hbx_logf(ctx, "mintnes: audio unavailable; continuing silently");
            }
            hbx_logf(ctx, "mintnes: loaded %s", roms[selected].title);
          }
        }
      }
      if (menu && draw_menu(ctx, selected, refresh_state) != HBX_OK) {
        status = HBX_ERR_GPU;
        break;
      }
      if (menu)
        hbx_frame_end(ctx);
    } else {
      if (input.buttons & HBX_MINUS) {
        held_minus++;
        if (held_minus >= 45u) {
          hbx_logf(ctx, "mintnes: leaving game after held minus");
          break;
        }
      } else if (held_minus) {
        held_minus = 0;
        if (audio_enabled && !mintnes_output_pause(ctx)) {
          audio_enabled = 0;
          hbx_logf(ctx, "mintnes: audio stopped; continuing silently");
        }
        ready_for_a = 0;
        menu = 1;
        deadline = 0;
        auto_start_pending = 0;
        hbx_logf(ctx, "mintnes: returned to rom list");
      }
      if (!menu) {
        uint8_t mapped = nes_buttons(&input);
        uint32_t frame = mintnes_frame_count();
        int trace = trace_frame(frame);
        if (mapped & 8u)
          auto_start_pending = 0;
        if (auto_start_pending) {
          startup_frame++;
          if (startup_frame >= 90u && startup_frame < 93u) {
            mapped = 8u;
            if (startup_frame == 90u)
              hbx_logf(ctx, "mintnes: automatic start");
          } else if (startup_frame >= 93u) {
            auto_start_pending = 0;
          }
        }
        if (mapped != last_nes_buttons && mapped && input_log_count < 40u) {
          hbx_logf(ctx, "mintnes: pad %x -> nes %x, connected %u",
                   input.buttons, mapped, input.connected);
          input_log_count++;
        }
        last_nes_buttons = mapped;
        if (trace)
          hbx_logf(ctx, "mintnes: frame %u core begin, pad %x, audio %u",
                   frame + 1u, mapped, audio_enabled);
        halted = mintnes_frame(mapped, indices);
        if (trace)
          hbx_logf(ctx, "mintnes: frame %u core done, halt %x",
                   frame + 1u, halted);
        if (halted) {
          hbx_logf(ctx, "mintnes: emulator stopped at frame %u, code %x",
                   mintnes_frame_count(), halted);
          status = HBX_ERR_INTERNAL;
          break;
        }
        if (audio_enabled) {
          mintnes_audio_render(pcm, MINTNES_AUDIO_FRAME_SAMPLES);
          if (!mintnes_output_submit(ctx, pcm, MINTNES_AUDIO_FRAME_SAMPLES)) {
            audio_enabled = 0;
            hbx_logf(ctx, "mintnes: audio stopped; continuing silently");
          }
        }
        if (trace)
          hbx_logf(ctx, "mintnes: frame %u audio done", frame + 1u);
        for (uint32_t i = 0; i < MINTNES_PIXELS; i++)
          rgba[i] = mintnes_palette[indices[i] & 63u];
        if (draw_game(ctx, selected, halted) != HBX_OK) {
          status = HBX_ERR_GPU;
          break;
        }
        if (trace)
          hbx_logf(ctx, "mintnes: frame %u present done, image %x",
                   frame + 1u, frame_hash(indices));
        hbx_frame_end(ctx);
      } else {
        if (draw_menu(ctx, selected, refresh_state) != HBX_OK) {
          status = HBX_ERR_GPU;
          break;
        }
        hbx_frame_end(ctx);
      }
    }
    hbx_pace(ctx, &deadline, 60);
  }
  if (hbx_stop_requested(ctx))
    hbx_logf(ctx, "mintnes: host requested stop");
  hbx_logf(ctx, "mintnes: exit after %u emulated frames",
           mintnes_frame_count());
  if (audio_attempted && !mintnes_output_close(ctx))
    return HBX_ERR_INTERNAL;
  return status;
}
