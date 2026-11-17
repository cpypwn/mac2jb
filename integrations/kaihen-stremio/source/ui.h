#ifndef KAIHEN_STREMIO_UI_H
#define KAIHEN_STREMIO_UI_H

#include "catalog.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
    const uint32_t *pixels;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
} StremioArtwork;

typedef struct {
    uint32_t *pixels;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
} StremioCanvas;

typedef enum {
    STREMIO_UI_CATALOG,
    STREMIO_UI_DETAIL,
    STREMIO_UI_EPISODES,
    STREMIO_UI_STREAMS,
    STREMIO_UI_SIGN_IN
} StremioUIView;

typedef struct {
    StremioUIView view;
    const StremioAddon *addon;
    const StremioCatalog *catalog;
    const StremioCard *details;
    const StremioEpisodes *episodes;
    const StremioStreams *streams;
    const StremioArtwork *posters;
    const StremioArtwork *detail_poster;
    const StremioArtwork *backdrop;
    const StremioArtwork *logo;
    const uint8_t *qr_modules;
    uint32_t qr_size;
    size_t selected_catalog;
    size_t selected_card;
    size_t selected_episode;
    size_t selected_stream;
    const char *sign_in_url;
    const char *status;
} StremioUIState;

int stremio_ui_draw(StremioCanvas *canvas, const StremioUIState *state);

#ifdef __SWITCH__
#include <switch.h>

typedef struct {
    Framebuffer framebuffer;
    uint32_t width;
    uint32_t height;
    int ready;
} StremioBrowseScreen;

Result stremio_browse_open(StremioBrowseScreen *screen);
void stremio_browse_close(StremioBrowseScreen *screen);
int stremio_browse_present(StremioBrowseScreen *screen, const StremioUIState *state);
#endif

#endif
