#ifndef KAIHEN_STREMIO_ARTWORK_H
#define KAIHEN_STREMIO_ARTWORK_H

#include "ui.h"

#include <stdint.h>

/* call release before reusing an artwork slot. */
int stremio_artwork_fetch(const char *url, uint32_t max_width, uint32_t max_height,
                          StremioArtwork *out);
void stremio_artwork_release(StremioArtwork *artwork);

#endif
