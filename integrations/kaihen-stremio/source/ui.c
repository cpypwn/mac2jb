#include "ui.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    StremioCanvas *canvas;
    int width;
    int height;
} Ui;

#include "ui_font.inc"

static uint8_t font_cache[95][STREMIO_FONT_WIDTH * STREMIO_FONT_HEIGHT];
static uint8_t font_cached[95];

static uint32_t color(unsigned r, unsigned g, unsigned b) {
    return (r & 255U) | ((g & 255U) << 8) | ((b & 255U) << 16) | 0xff000000U;
}

static uint32_t blend(uint32_t a, uint32_t b, unsigned amount) {
    unsigned inverse = 255U - amount;
    unsigned r = (((a & 255U) * inverse) + ((b & 255U) * amount)) / 255U;
    unsigned g = ((((a >> 8) & 255U) * inverse) + (((b >> 8) & 255U) * amount)) / 255U;
    unsigned blue = ((((a >> 16) & 255U) * inverse) + (((b >> 16) & 255U) * amount)) / 255U;
    return color(r, g, blue);
}

static int xcoord(const Ui *ui, int x) { return x * ui->width / 1280; }
static int ycoord(const Ui *ui, int y) { return y * ui->height / 720; }

static void fill(StremioCanvas *canvas, int x, int y, int width, int height, uint32_t fill_color) {
    if (x < 0) width += x, x = 0;
    if (y < 0) height += y, y = 0;
    if (x >= (int)canvas->width || y >= (int)canvas->height) return;
    if (width > (int)canvas->width - x) width = (int)canvas->width - x;
    if (height > (int)canvas->height - y) height = (int)canvas->height - y;
    if (width <= 0 || height <= 0) return;
    for (int row = y; row < y + height; row++) {
        uint32_t *pixels = canvas->pixels + (size_t)row * canvas->stride + x;
        for (int col = 0; col < width; col++) pixels[col] = fill_color;
    }
}

static void rect(Ui *ui, int x, int y, int width, int height, uint32_t fill_color) {
    int left = xcoord(ui, x), top = ycoord(ui, y);
    fill(ui->canvas, left, top, xcoord(ui, x + width) - left,
         ycoord(ui, y + height) - top, fill_color);
}

static void rounded(Ui *ui, int x, int y, int width, int height, int radius, uint32_t fill_color) {
    int left = xcoord(ui, x), top = ycoord(ui, y);
    int right = xcoord(ui, x + width), bottom = ycoord(ui, y + height);
    int r = xcoord(ui, radius);
    if (r < 1) r = 1;
    if (r > (right - left) / 2) r = (right - left) / 2;
    if (r > (bottom - top) / 2) r = (bottom - top) / 2;
    for (int py = top; py < bottom; py++) {
        int inset = 0;
        if (py < top + r || py >= bottom - r) {
            int dy = py < top + r ? top + r - py : py - (bottom - r - 1);
            while (inset < r && (r - inset) * (r - inset) + dy * dy > r * r) inset++;
        }
        fill(ui->canvas, left + inset, py, right - left - 2 * inset, 1, fill_color);
    }
}

static void outline(Ui *ui, int x, int y, int width, int height, int radius,
                    uint32_t edge, uint32_t inside) {
    rounded(ui, x, y, width, height, radius, edge);
    rounded(ui, x + 2, y + 2, width - 4, height - 4, radius - 2, inside);
}

static int text_scale(const Ui *ui, int base) {
    int value = base * ui->width / 1280;
    return value < 1 ? 1 : value;
}

static unsigned char font_index(unsigned char ch) {
    return ch >= 32 && ch <= 126 ? (unsigned char)(ch - 32) : (unsigned char)('?' - 32);
}

static int glyph_advance(const Ui *ui, unsigned char ch, int base) {
    int value = ((int)stremio_font_advance[font_index(ch)] + 1) * text_scale(ui, base) / 3;
    return value < 2 ? 2 : value;
}

static void cache_glyph(unsigned char index) {
    if (font_cached[index]) return;
    unsigned int start = stremio_font_offsets[index];
    unsigned int end = stremio_font_offsets[index + 1];
    size_t output = 0;
    while (start + 1 < end && output < STREMIO_FONT_WIDTH * STREMIO_FONT_HEIGHT) {
        unsigned count = stremio_font_rle[start++];
        unsigned value = stremio_font_rle[start++];
        for (unsigned i = 0; i < count && output < STREMIO_FONT_WIDTH * STREMIO_FONT_HEIGHT; i++)
            font_cache[index][output++] = (uint8_t)(value * 17);
    }
    font_cached[index] = 1;
}

static void glyph(Ui *ui, int left, int top, unsigned char ch, int base, uint32_t ink) {
    unsigned char index = font_index(ch);
    int scale = text_scale(ui, base);
    int width = STREMIO_FONT_WIDTH * scale / 3;
    int height = STREMIO_FONT_HEIGHT * scale / 3;
    if (width < 1) width = 1;
    if (height < 1) height = 1;
    cache_glyph(index);
    for (int y = 0; y < height; y++) {
        int py = top + y;
        if (py < 0 || py >= ui->height) continue;
        uint32_t *row = ui->canvas->pixels + (size_t)py * ui->canvas->stride;
        int sy = STREMIO_FONT_HEIGHT - 1 - y * STREMIO_FONT_HEIGHT / height;
        for (int x = 0; x < width; x++) {
            int px = left + x;
            if (px < 0 || px >= ui->width) continue;
            int sx = x * STREMIO_FONT_WIDTH / width;
            unsigned alpha = font_cache[index][sy * STREMIO_FONT_WIDTH + sx];
            if (alpha) row[px] = blend(row[px], ink, alpha);
        }
    }
}

static int text_width(const Ui *ui, const unsigned char *value, int base) {
    int width = 0;
    while (*value) width += glyph_advance(ui, *value++, base);
    return width;
}

static void text(Ui *ui, int x, int y, const char *value, int base, int max_width,
                 uint32_t ink) {
    int left = xcoord(ui, x), end = left + xcoord(ui, max_width);
    int top = ycoord(ui, y);
    const unsigned char *current = (const unsigned char *)(value ? value : "");
    int truncate = text_width(ui, current, base) > end - left;
    int dot = glyph_advance(ui, '.', base);
    while (*current) {
        int advance = glyph_advance(ui, *current, base);
        if (truncate && left + advance + 3 * dot > end) break;
        if (left + advance > end) break;
        glyph(ui, left, top, *current++, base, ink);
        left += advance;
    }
    if (truncate) {
        for (int i = 0; i < 3 && left + dot <= end; i++, left += dot)
            glyph(ui, left, top, '.', base, ink);
    }
}

static void text_lines(Ui *ui, int x, int y, const char *value, int base,
                       int max_width, int max_lines, uint32_t ink) {
    char line[160];
    const char *cursor = value ? value : "";
    int chars_per_line = xcoord(ui, max_width) / (5 * text_scale(ui, base));
    if (chars_per_line >= (int)sizeof line) chars_per_line = (int)sizeof line - 1;
    if (chars_per_line < 1) return;
    for (int number = 0; number < max_lines && *cursor; number++) {
        int count = 0, last_space = -1;
        while (cursor[count] && cursor[count] != '\n' && count < chars_per_line) {
            if (cursor[count] == ' ') last_space = count;
            count++;
        }
        if (cursor[count] && cursor[count] != '\n' && last_space > 0) count = last_space;
        if (!count && *cursor == '\n') cursor++;
        else if (count) {
            memcpy(line, cursor, (size_t)count);
            line[count] = 0;
            text(ui, x, y + number * (base * 12 + 5), line, base, max_width, ink);
            cursor += count;
            while (*cursor == ' ' || *cursor == '\n') cursor++;
        }
    }
}

static void image_crop(Ui *ui, int x, int y, int width, int height,
                       const StremioArtwork *artwork) {
    int left, top, right, bottom;
    uint64_t source_width, source_height, offset_x = 0, offset_y = 0;
    if (!artwork || !artwork->pixels || !artwork->width || !artwork->height ||
        artwork->stride < artwork->width) return;
    left = xcoord(ui, x), top = ycoord(ui, y);
    right = xcoord(ui, x + width), bottom = ycoord(ui, y + height);
    if (right <= left || bottom <= top) return;
    source_width = artwork->width;
    source_height = artwork->height;
    if (source_width * (uint64_t)(bottom - top) > source_height * (uint64_t)(right - left)) {
        source_width = source_height * (uint64_t)(right - left) / (uint64_t)(bottom - top);
        offset_x = (artwork->width - source_width) / 2;
    } else {
        source_height = source_width * (uint64_t)(bottom - top) / (uint64_t)(right - left);
        offset_y = (artwork->height - source_height) / 2;
    }
    for (int py = top; py < bottom && py < ui->height; py++) {
        if (py < 0) continue;
        uint64_t sy = offset_y + (uint64_t)(py - top) * source_height / (uint64_t)(bottom - top);
        uint32_t *target = ui->canvas->pixels + (size_t)py * ui->canvas->stride;
        for (int px = left; px < right && px < ui->width; px++) {
            if (px < 0) continue;
            uint64_t sx = offset_x + (uint64_t)(px - left) * source_width / (uint64_t)(right - left);
            uint32_t source = artwork->pixels[sy * artwork->stride + sx];
            unsigned alpha = source >> 24;
            if (alpha == 255) target[px] = source;
            else if (alpha) target[px] = blend(target[px], source, alpha);
        }
    }
}

static void background(Ui *ui) {
    uint32_t top = color(6, 22, 19), bottom = color(12, 34, 31);
    for (int y = 0; y < ui->height; y++)
        fill(ui->canvas, 0, y, ui->width, 1,
             blend(top, bottom, (unsigned)(y * 255 / ui->height)));
    rect(ui, 0, 0, 232, 720, color(6, 20, 18));
    rect(ui, 231, 0, 1, 720, color(45, 78, 70));
}

static void app_mark(Ui *ui) {
    rounded(ui, 28, 28, 48, 48, 13, color(15, 20, 32));
    for (int row = 0; row < 38; row++) {
        int span = row < 19 ? row : 37 - row;
        rect(ui, 52 - span, 33 + row, span * 2 + 1, 1,
             blend(color(86, 110, 232), color(119, 72, 237), (unsigned)(row * 5)));
    }
    for (int col = 0; col < 15; col++) {
        int span = (14 - col) * 8 / 14;
        rect(ui, 46 + col, 52 - span, 1, span * 2 + 1, color(244, 244, 255));
    }
}

static void sidebar(Ui *ui, const StremioUIState *state) {
    uint32_t white = color(232, 248, 240), muted = color(148, 184, 171);
    if (state->logo && state->logo->pixels) image_crop(ui, 28, 28, 48, 48, state->logo);
    else app_mark(ui);
    text(ui, 89, 43, "Stremio", 3, 125, white);
    rect(ui, 24, 104, 184, 1, color(45, 78, 70));
    rounded(ui, 16, 130, 200, 45, 9, color(25, 62, 50));
    rect(ui, 16, 140, 4, 25, color(145, 246, 199));
    text(ui, 39, 145, "Discover", 2, 160, white);
    text(ui, 33, 205, "CATALOGS", 2, 175, muted);
    if (state->addon) {
        size_t count = state->addon->count;
        size_t first = state->selected_catalog > 3 ? state->selected_catalog - 3 : 0;
        if (count > 7 && first > count - 7) first = count - 7;
        for (size_t row = 0; row < 7 && first + row < count; row++) {
            size_t i = first + row;
            int y = 240 + (int)row * 49;
            if (i == state->selected_catalog) rounded(ui, 16, y - 9, 200, 40, 8, color(23, 53, 45));
            text(ui, 35, y, state->addon->entries[i].name, 2, 175,
                 i == state->selected_catalog ? white : muted);
        }
        if (first > 0) text(ui, 191, 205, "^", 2, 20, muted);
        if (first + 7 < count) text(ui, 191, 597, "v", 2, 20, muted);
    }
    rect(ui, 24, 637, 184, 1, color(45, 78, 70));
    text(ui, 35, 660, "Nintendo Switch 2", 2, 180, muted);
}

static void bottom(Ui *ui, const StremioUIState *state) {
    int y = 664, x = 270;
    struct Control { const char *key; const char *label; } controls[5];
    int count = 0;
    if (state->view == STREMIO_UI_CATALOG) {
        controls[count++] = (struct Control){"A", "Details"};
        controls[count++] = (struct Control){"X", "Catalog"};
    } else if (state->view == STREMIO_UI_DETAIL) {
        controls[count++] = (struct Control){"A", "Open"};
        controls[count++] = (struct Control){"B", "Back"};
    } else if (state->view == STREMIO_UI_STREAMS) {
        controls[count++] = (struct Control){"A", "Play"};
        controls[count++] = (struct Control){"B", "Back"};
    } else if (state->view == STREMIO_UI_SIGN_IN) {
        controls[count++] = (struct Control){"B", "Back"};
    } else {
        controls[count++] = (struct Control){"A", "Select"};
        controls[count++] = (struct Control){"B", "Back"};
    }
    controls[count++] = (struct Control){"Y", "Refresh"};
    if (state->view != STREMIO_UI_SIGN_IN)
        controls[count++] = (struct Control){"-", "Sign in"};
    controls[count++] = (struct Control){"+", "Exit"};
    rect(ui, 232, 648, 1048, 1, color(45, 78, 70));
    for (int i = 0; i < count; i++) {
        rounded(ui, x, y - 4, 30, 28, 7, color(27, 65, 54));
        text(ui, x + 9, y + 2, controls[i].key, 2, 17, color(240, 239, 249));
        text(ui, x + 40, y + 2, controls[i].label, 2, 155, color(174, 210, 192));
        x += 194;
    }
}

static void status(Ui *ui, const StremioUIState *state) {
    if (!state->status || !*state->status) return;
    rounded(ui, 744, 17, 501, 44, 9, color(24, 54, 45));
    text(ui, 760, 30, state->status, 2, 465, color(215, 245, 225));
}

static void poster(Ui *ui, int x, int y, int width, int height,
                   const StremioArtwork *artwork, const char *title, size_t index) {
    uint32_t palette[] = {
        color(34, 78, 68), color(32, 71, 80), color(57, 82, 67),
        color(43, 86, 78), color(39, 74, 93), color(69, 82, 55)
    };
    rounded(ui, x, y, width, height, 8, palette[index % 6]);
    if (artwork && artwork->pixels) {
        image_crop(ui, x + 2, y + 2, width - 4, height - 4, artwork);
    } else {
        rect(ui, x + 12, y + 20, width - 24, 1, color(142, 182, 164));
        text(ui, x + 27, y + 66, title, 4, width - 44, color(244, 237, 248));
        rect(ui, x + 12, y + height - 28, width - 24, 2, color(142, 182, 164));
    }
}

static void hero(Ui *ui, int x, int y, int width, int height,
                 const StremioArtwork *backdrop) {
    rounded(ui, x, y, width, height, 14, color(22, 49, 43));
    if (backdrop && backdrop->pixels) image_crop(ui, x + 2, y + 2, width - 4, height - 4, backdrop);
    else {
        for (int strip = 0; strip < 10; strip++)
            rect(ui, x + width / 2 + strip * 51, y + 2, 51, height - 4,
                 blend(color(24, 53, 47), color(40, 96, 77), (unsigned)(strip * 20)));
    }
    int left = xcoord(ui, x), top = ycoord(ui, y);
    int right = xcoord(ui, x + width), bottom = ycoord(ui, y + height);
    uint32_t dark = color(8, 24, 21);
    for (int py = top; py < bottom && py < ui->height; py++) {
        uint32_t *row = ui->canvas->pixels + (size_t)py * ui->canvas->stride;
        for (int px = left; px < right && px < ui->width; px++) {
            unsigned fade = px < left + (right - left) / 2
                ? 245U - (unsigned)((px - left) * 145 / ((right - left) / 2))
                : 100U - (unsigned)((px - left - (right - left) / 2) * 100 / ((right - left) / 2));
            unsigned bottom_fade = (unsigned)((py - top) * 60 / (bottom - top));
            fade = fade + bottom_fade > 255 ? 255 : fade + bottom_fade;
            row[px] = blend(row[px], dark, fade);
        }
    }
}

static void catalog(Ui *ui, const StremioUIState *state) {
    const StremioCatalog *catalog_data = state->catalog;
    const StremioCard *selected = NULL;
    const char *section = "Discover";
    size_t count = catalog_data ? catalog_data->count : 0;
    if (state->addon && state->selected_catalog < state->addon->count)
        section = state->addon->entries[state->selected_catalog].name;
    if (catalog_data && state->selected_card < count) selected = &catalog_data->cards[state->selected_card];
    hero(ui, 260, 76, 992, 244, state->backdrop);
    text(ui, 288, 102, section, 2, 480, color(161, 232, 193));
    text(ui, 288, 150, selected ? selected->name : "Discover movies and shows",
         4, 800, color(249, 248, 254));
    if (selected && selected->year[0])
        text(ui, 288, 196, selected->year, 2, 200, color(177, 210, 192));
    text_lines(ui, 288, 235, selected && selected->description[0]
               ? selected->description : "Choose a title to see more",
               2, 790, 2, color(194, 223, 205));
    text(ui, 266, 343, "Browse titles", 3, 650, color(240, 239, 250));
    if (!count) {
        text(ui, 280, 427, "No titles available", 3, 800, color(169, 169, 190));
        return;
    }
    size_t first = 0;
    if (count > 5 && state->selected_card >= 5) {
        first = state->selected_card - 4;
        if (first + 5 > count) first = count - 5;
    }
    for (size_t slot = 0; slot < 5 && first + slot < count; slot++) {
        size_t index = first + slot;
        int x = 266 + (int)slot * 198;
        const StremioArtwork *artwork = state->posters ? &state->posters[index] : NULL;
        if (index == state->selected_card)
            outline(ui, x + 4, 378, 162, 228, 11,
                    color(154, 250, 203), color(19, 43, 35));
        poster(ui, x + 9, 383, 152, 218, artwork, catalog_data->cards[index].name, index);
        text(ui, x, 609, catalog_data->cards[index].name, 2, 178,
             index == state->selected_card ? color(236, 251, 241) : color(181, 213, 193));
    }
    char count_text[64];
    snprintf(count_text, sizeof count_text, "%zu-%zu of %zu", first + 1,
             first + 5 < count ? first + 5 : count, count);
    text(ui, 1085, 346, count_text, 2, 160, color(152, 192, 171));
}

static void detail(Ui *ui, const StremioUIState *state) {
    const StremioCard *card = state->details;
    const char *name = card && card->name[0] ? card->name : "Title details";
    hero(ui, 260, 79, 992, 466, state->backdrop);
    poster(ui, 289, 155, 182, 274, state->detail_poster, name, 0);
    text(ui, 498, 158, name, 4, 710, color(249, 248, 254));
    if (card && card->year[0]) text(ui, 500, 218, card->year, 2, 120, color(177, 210, 192));
    if (card && card->type[0]) text(ui, 633, 218, card->type, 2, 240, color(177, 210, 192));
    text_lines(ui, 500, 271, card && card->description[0] ? card->description
               : "No description available", 2, 694, 5, color(215, 237, 220));
    rounded(ui, 289, 476, 226, 51, 9, color(87, 205, 152));
    text(ui, 319, 493, card && !strcmp(card->type, "series") ? "See episodes" : "Choose stream",
         2, 195, color(8, 36, 25));
}

static void list(Ui *ui, const StremioUIState *state, int streams_view) {
    const char *heading = streams_view ? "Choose a stream" : "Episodes";
    size_t count = streams_view ? (state->streams ? state->streams->count : 0)
                                : (state->episodes ? state->episodes->count : 0);
    size_t selected = streams_view ? state->selected_stream : state->selected_episode;
    size_t first = selected > 6 ? selected - 6 : 0;
    char subtitle[190];
    text(ui, 266, 53, heading, 4, 900, color(248, 247, 253));
    snprintf(subtitle, sizeof subtitle, "%s", state->details ? state->details->name : "");
    text(ui, 270, 111, subtitle, 2, 850, color(164, 202, 181));
    rect(ui, 265, 150, 984, 1, color(45, 78, 70));
    if (!count) {
        text(ui, 287, 206, streams_view ? "No streams available" : "No episodes available",
             3, 800, color(177, 176, 194));
        return;
    }
    for (size_t slot = 0; slot < 7 && first + slot < count; slot++) {
        size_t index = first + slot;
        int y = 170 + (int)slot * 66;
        char label[320];
        const char *sub = "";
        if (streams_view) {
            const StremioStream *stream = &state->streams->entries[index];
            snprintf(label, sizeof label, "%s", stream->name[0] ? stream->name : stream->title);
            sub = stream->title;
        } else {
            const StremioEpisode *episode = &state->episodes->entries[index];
            snprintf(label, sizeof label, "S%u E%u  %s", episode->season,
                     episode->episode, episode->title);
        }
        if (index == selected)
            outline(ui, 267, y, 979, 59, 8, color(143, 241, 189), color(27, 65, 50));
        else rounded(ui, 267, y, 979, 59, 8, color(20, 42, 38));
        text(ui, 287, y + (streams_view ? 9 : 19), label, 2, 930,
             index == selected ? color(249, 248, 255) : color(204, 202, 217));
        if (streams_view && sub[0]) text(ui, 287, y + 33, sub, 2, 930, color(160, 197, 176));
    }
}

static void sign_in(Ui *ui, const StremioUIState *state) {
    text(ui, 275, 69, "Sign in to Stremio", 4, 920, color(247, 246, 254));
    text(ui, 277, 128, "Scan this code with your phone", 2, 890, color(181, 216, 191));
    rounded(ui, 656, 188, 308, 308, 15, color(255, 255, 255));
    if (state->qr_modules && state->qr_size > 0 && state->qr_size <= 177) {
        int size = (int)state->qr_size;
        int pixel = 268 / size;
        if (pixel < 1) pixel = 1;
        int side = pixel * size;
        int left = 656 + (308 - side) / 2;
        int top = 188 + (308 - side) / 2;
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                if (state->qr_modules[(size_t)y * size + x])
                    rect(ui, left + x * pixel, top + y * pixel, pixel, pixel, color(15, 13, 27));
            }
        }
    } else {
        text(ui, 685, 326, "Waiting for sign in code", 2, 250, color(43, 39, 58));
    }
    text(ui, 291, 534, "Or open this address on your phone", 2, 900, color(177, 211, 188));
    if (state->sign_in_url)
        text(ui, 291, 570, state->sign_in_url, 2, 900, color(153, 245, 192));
}

int stremio_ui_draw(StremioCanvas *canvas, const StremioUIState *state) {
    Ui ui;
    if (!canvas || !state || !canvas->pixels || !canvas->width || !canvas->height ||
        canvas->stride < canvas->width) return 0;
    ui.canvas = canvas;
    ui.width = (int)canvas->width;
    ui.height = (int)canvas->height;
    background(&ui);
    sidebar(&ui, state);
    switch (state->view) {
        case STREMIO_UI_CATALOG: catalog(&ui, state); break;
        case STREMIO_UI_DETAIL: detail(&ui, state); break;
        case STREMIO_UI_EPISODES: list(&ui, state, 0); break;
        case STREMIO_UI_STREAMS: list(&ui, state, 1); break;
        case STREMIO_UI_SIGN_IN: sign_in(&ui, state); break;
        default: return 0;
    }
    bottom(&ui, state);
    status(&ui, state);
    return 1;
}

#ifdef __SWITCH__
Result stremio_browse_open(StremioBrowseScreen *screen) {
    Result rc;
    if (!screen) return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    memset(screen, 0, sizeof(*screen));
    screen->width = 1280;
    screen->height = 720;
    rc = framebufferCreate(&screen->framebuffer, nwindowGetDefault(),
                           screen->width, screen->height, PIXEL_FORMAT_RGBA_8888, 2);
    if (R_FAILED(rc)) return rc;
    rc = framebufferMakeLinear(&screen->framebuffer);
    if (R_FAILED(rc)) {
        framebufferClose(&screen->framebuffer);
        return rc;
    }
    screen->ready = 1;
    return 0;
}

void stremio_browse_close(StremioBrowseScreen *screen) {
    if (!screen || !screen->ready) return;
    framebufferClose(&screen->framebuffer);
    memset(screen, 0, sizeof(*screen));
}

int stremio_browse_present(StremioBrowseScreen *screen, const StremioUIState *state) {
    uint32_t stride = 0;
    uint8_t *pixels;
    StremioCanvas canvas;
    if (!screen || !screen->ready) return 0;
    pixels = framebufferBegin(&screen->framebuffer, &stride);
    if (!pixels || stride < screen->width * 4 || stride % 4) return 0;
    canvas.pixels = (uint32_t *)pixels;
    canvas.width = screen->width;
    canvas.height = screen->height;
    canvas.stride = stride / 4;
    int result = stremio_ui_draw(&canvas, state);
    framebufferEnd(&screen->framebuffer);
    return result;
}
#endif
