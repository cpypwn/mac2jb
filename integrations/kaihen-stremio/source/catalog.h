#ifndef KAIHEN_STREMIO_CATALOG_H
#define KAIHEN_STREMIO_CATALOG_H

#include <stddef.h>

#define STREMIO_MAX_CARDS 48
#define STREMIO_MAX_CATALOGS 32
#define STREMIO_MAX_STREAMS 24
#define STREMIO_MAX_EPISODES 256

typedef struct {
    char id[64];
    char name[96];
    char type[24];
} StremioCatalogEntry;

typedef struct {
    StremioCatalogEntry entries[STREMIO_MAX_CATALOGS];
    size_t count;
} StremioAddon;

typedef struct {
    char name[128];
    char title[256];
    char url[768];
} StremioStream;

typedef struct {
    StremioStream entries[STREMIO_MAX_STREAMS];
    size_t count;
} StremioStreams;

typedef struct {
    char id[128];
    char name[160];
    char type[24];
    char year[16];
    char description[768];
    char poster[1024];
    char background[1024];
    char logo[1024];
} StremioCard;

typedef struct {
    StremioCard cards[STREMIO_MAX_CARDS];
    size_t count;
} StremioCatalog;

typedef struct {
    char id[128];
    char title[160];
    unsigned season;
    unsigned episode;
} StremioEpisode;

typedef struct {
    StremioEpisode entries[STREMIO_MAX_EPISODES];
    size_t count;
} StremioEpisodes;

int stremio_parse_catalog(const char *json, StremioCatalog *catalog);
int stremio_parse_meta(const char *json, StremioCard *card);
int stremio_parse_episodes(const char *json, StremioEpisodes *episodes);
int stremio_parse_manifest(const char *json, StremioAddon *addon);
int stremio_parse_streams(const char *json, StremioStreams *streams);

#endif
