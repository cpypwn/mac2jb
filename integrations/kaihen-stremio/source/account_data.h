#ifndef KAIHEN_STREMIO_ACCOUNT_DATA_H
#define KAIHEN_STREMIO_ACCOUNT_DATA_H

#include <stddef.h>
#include <stdint.h>

#include "catalog.h"

#define STREMIO_ACCOUNT_MAX_ADDONS 32
#define STREMIO_ACCOUNT_ADDON_URL_LENGTH 1024

enum {
    STREMIO_ACCOUNT_LOADED_ADDONS = 1,
    STREMIO_ACCOUNT_LOADED_LIBRARY = 2
};

typedef struct {
    char video_id[256];
    uint64_t position_ms;
    uint64_t duration_ms;
    unsigned season;
    unsigned episode;
} StremioAccountLibraryState;

typedef struct {
    char addon_urls[STREMIO_ACCOUNT_MAX_ADDONS][STREMIO_ACCOUNT_ADDON_URL_LENGTH];
    size_t addon_count;
    size_t addon_total;
    size_t addon_skipped;
    StremioCatalog library;
    StremioAccountLibraryState library_state[STREMIO_MAX_CARDS];
    size_t library_total;
} StremioAccountData;

int stremio_account_data_load(const char *auth_key, StremioAccountData *out,
                              char *error, size_t error_capacity);
int stremio_account_data_parse_addons(const char *json, StremioAccountData *out);
int stremio_account_data_parse_library(const char *json, StremioAccountData *out);

#endif
