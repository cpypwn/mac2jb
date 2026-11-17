#include "catalog.h"

#include <ctype.h>
#include <stdint.h>
#include <string.h>

typedef struct {
    const char *text;
    size_t pos;
} Cursor;

static void space(Cursor *cursor) {
    while (cursor->text[cursor->pos] && isspace((unsigned char)cursor->text[cursor->pos]))
        cursor->pos++;
}

static int take(Cursor *cursor, char expected) {
    space(cursor);
    if (cursor->text[cursor->pos] != expected) return 0;
    cursor->pos++;
    return 1;
}

static int hex(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static int append_utf8(char *output, size_t size, size_t *used, uint32_t code) {
    char bytes[3];
    size_t count;
    if (code < 0x80) {
        bytes[0] = (char)code;
        count = 1;
    } else if (code < 0x800) {
        bytes[0] = (char)(0xc0 | (code >> 6));
        bytes[1] = (char)(0x80 | (code & 0x3f));
        count = 2;
    } else {
        bytes[0] = (char)(0xe0 | (code >> 12));
        bytes[1] = (char)(0x80 | ((code >> 6) & 0x3f));
        bytes[2] = (char)(0x80 | (code & 0x3f));
        count = 3;
    }
    if (*used + count < size) {
        memcpy(output + *used, bytes, count);
        *used += count;
    }
    return 1;
}

static int string(Cursor *cursor, char *output, size_t size) {
    size_t used = 0;
    if (!take(cursor, '"')) return 0;
    while (cursor->text[cursor->pos]) {
        unsigned char ch = (unsigned char)cursor->text[cursor->pos++];
        if (ch == '"') {
            if (size) output[used] = 0;
            return 1;
        }
        if (ch < 0x20) return 0;
        if (ch == '\\') {
            ch = (unsigned char)cursor->text[cursor->pos++];
            if (!ch) return 0;
            if (ch == 'u') {
                uint32_t code = 0;
                for (int i = 0; i < 4; i++) {
                    if (!cursor->text[cursor->pos]) return 0;
                    int digit = hex(cursor->text[cursor->pos++]);
                    if (digit < 0) return 0;
                    code = (code << 4) | (unsigned int)digit;
                }
                if (code >= 0xd800 && code <= 0xdfff) code = '?';
                append_utf8(output, size, &used, code);
                continue;
            }
            if (ch == 'n' || ch == 'r' || ch == 't') ch = ' ';
            else if (ch != '"' && ch != '\\' && ch != '/') return 0;
        }
        if (used + 1 < size) output[used++] = (char)ch;
    }
    return 0;
}

static int skip(Cursor *cursor, unsigned depth) {
    char ch;
    if (depth > 32) return 0;
    space(cursor);
    ch = cursor->text[cursor->pos];
    if (ch == '"') {
        char unused[1];
        return string(cursor, unused, sizeof unused);
    }
    if (ch == '[' || ch == '{') {
        const char end = ch == '[' ? ']' : '}';
        cursor->pos++;
        if (take(cursor, end)) return 1;
        do {
            if (ch == '{') {
                char key[1];
                if (!string(cursor, key, sizeof key) || !take(cursor, ':')) return 0;
            }
            if (!skip(cursor, depth + 1)) return 0;
            if (take(cursor, end)) return 1;
        } while (take(cursor, ','));
        return 0;
    }
    if (ch == '-' || isdigit((unsigned char)ch) || ch == 't' || ch == 'f' || ch == 'n') {
        while (cursor->text[cursor->pos] &&
               !strchr(",]} \t\r\n", cursor->text[cursor->pos])) cursor->pos++;
        return 1;
    }
    return 0;
}

static int card(Cursor *cursor, StremioCard *result) {
    memset(result, 0, sizeof *result);
    if (!take(cursor, '{')) return 0;
    if (take(cursor, '}')) return 1;
    do {
        char key[40];
        char *target = NULL;
        size_t size = 0;
        if (!string(cursor, key, sizeof key) || !take(cursor, ':')) return 0;
        if (!strcmp(key, "id")) target = result->id, size = sizeof result->id;
        else if (!strcmp(key, "name")) target = result->name, size = sizeof result->name;
        else if (!strcmp(key, "type")) target = result->type, size = sizeof result->type;
        else if (!strcmp(key, "year")) target = result->year, size = sizeof result->year;
        else if (!strcmp(key, "description")) target = result->description, size = sizeof result->description;
        else if (!strcmp(key, "poster")) target = result->poster, size = sizeof result->poster;
        else if (!strcmp(key, "background")) target = result->background, size = sizeof result->background;
        else if (!strcmp(key, "logo")) target = result->logo, size = sizeof result->logo;
        if (target) {
            space(cursor);
            if (cursor->text[cursor->pos] == '"') {
                if (!string(cursor, target, size)) return 0;
            } else if (!skip(cursor, 1)) return 0;
        } else if (!skip(cursor, 1)) return 0;
        if (take(cursor, '}')) return 1;
    } while (take(cursor, ','));
    return 0;
}

int stremio_parse_catalog(const char *json, StremioCatalog *catalog) {
    Cursor cursor = {json, 0};
    int found = 0;
    if (!json || !catalog) return 0;
    memset(catalog, 0, sizeof *catalog);
    if (!take(&cursor, '{')) return 0;
    do {
        char key[40];
        if (!string(&cursor, key, sizeof key) || !take(&cursor, ':')) return 0;
        if (!strcmp(key, "metas")) {
            int closed = 0;
            found = 1;
            if (!take(&cursor, '[')) return 0;
            if (take(&cursor, ']')) closed = 1;
            else {
                do {
                    StremioCard item;
                    if (!card(&cursor, &item)) return 0;
                    if (catalog->count < STREMIO_MAX_CARDS && item.id[0] && item.name[0])
                        catalog->cards[catalog->count++] = item;
                    if (take(&cursor, ']')) {
                        closed = 1;
                        break;
                    }
                } while (take(&cursor, ','));
            }
            if (!closed) return 0;
        } else if (!skip(&cursor, 1)) return 0;
        if (take(&cursor, '}')) return found;
    } while (take(&cursor, ','));
    return 0;
}

int stremio_parse_meta(const char *json, StremioCard *result) {
    Cursor cursor = {json, 0};
    if (!json || !result || !take(&cursor, '{')) return 0;
    do {
        char key[40];
        if (!string(&cursor, key, sizeof key) || !take(&cursor, ':')) return 0;
        if (!strcmp(key, "meta")) return card(&cursor, result) && result->id[0];
        if (!skip(&cursor, 1)) return 0;
        if (take(&cursor, '}')) break;
    } while (take(&cursor, ','));
    return 0;
}

static int unsigned_value(Cursor *cursor, unsigned *value) {
    unsigned parsed = 0;
    space(cursor);
    if (!isdigit((unsigned char)cursor->text[cursor->pos])) return 0;
    do {
        unsigned digit = (unsigned)(cursor->text[cursor->pos++] - '0');
        if (parsed > (UINT32_MAX - digit) / 10) return 0;
        parsed = parsed * 10 + digit;
    } while (isdigit((unsigned char)cursor->text[cursor->pos]));
    *value = parsed;
    return 1;
}

static int episode_entry(Cursor *cursor, StremioEpisode *result) {
    memset(result, 0, sizeof *result);
    if (!take(cursor, '{')) return 0;
    if (take(cursor, '}')) return 1;
    do {
        char key[40];
        if (!string(cursor, key, sizeof key) || !take(cursor, ':')) return 0;
        if (!strcmp(key, "id")) {
            if (!string(cursor, result->id, sizeof result->id)) return 0;
        } else if (!strcmp(key, "title")) {
            if (!string(cursor, result->title, sizeof result->title)) return 0;
        } else if (!strcmp(key, "season")) {
            if (!unsigned_value(cursor, &result->season)) return 0;
        } else if (!strcmp(key, "episode")) {
            if (!unsigned_value(cursor, &result->episode)) return 0;
        } else if (!skip(cursor, 1)) return 0;
        if (take(cursor, '}')) return 1;
    } while (take(cursor, ','));
    return 0;
}

static int episode_list(Cursor *cursor, StremioEpisodes *episodes) {
    if (!take(cursor, '[')) return 0;
    if (take(cursor, ']')) return 1;
    do {
        StremioEpisode item;
        if (!episode_entry(cursor, &item)) return 0;
        if (episodes->count < STREMIO_MAX_EPISODES && item.id[0])
            episodes->entries[episodes->count++] = item;
        if (take(cursor, ']')) return 1;
    } while (take(cursor, ','));
    return 0;
}

int stremio_parse_episodes(const char *json, StremioEpisodes *episodes) {
    Cursor cursor = {json, 0};
    if (!json || !episodes) return 0;
    memset(episodes, 0, sizeof *episodes);
    if (!take(&cursor, '{')) return 0;
    do {
        char key[40];
        if (!string(&cursor, key, sizeof key) || !take(&cursor, ':')) return 0;
        if (!strcmp(key, "meta")) {
            if (!take(&cursor, '{')) return 0;
            do {
                if (!string(&cursor, key, sizeof key) || !take(&cursor, ':')) return 0;
                if (!strcmp(key, "videos")) {
                    if (!episode_list(&cursor, episodes)) return 0;
                } else if (!skip(&cursor, 1)) return 0;
                if (take(&cursor, '}')) return 1;
            } while (take(&cursor, ','));
            return 0;
        }
        if (!skip(&cursor, 1)) return 0;
        if (take(&cursor, '}')) return 1;
    } while (take(&cursor, ','));
    return 0;
}

static int addon_entry(Cursor *cursor, StremioCatalogEntry *result) {
    memset(result, 0, sizeof *result);
    if (!take(cursor, '{')) return 0;
    do {
        char key[40];
        char *target = NULL;
        size_t size = 0;
        if (!string(cursor, key, sizeof key) || !take(cursor, ':')) return 0;
        if (!strcmp(key, "id")) target = result->id, size = sizeof result->id;
        else if (!strcmp(key, "name")) target = result->name, size = sizeof result->name;
        else if (!strcmp(key, "type")) target = result->type, size = sizeof result->type;
        if (target) {
            space(cursor);
            if (cursor->text[cursor->pos] == '"') {
                if (!string(cursor, target, size)) return 0;
            } else if (!skip(cursor, 1)) return 0;
        } else if (!skip(cursor, 1)) return 0;
        if (take(cursor, '}')) return 1;
    } while (take(cursor, ','));
    return 0;
}

int stremio_parse_manifest(const char *json, StremioAddon *addon) {
    Cursor cursor = {json, 0};
    if (!json || !addon || !take(&cursor, '{')) return 0;
    memset(addon, 0, sizeof *addon);
    do {
        char key[40];
        if (!string(&cursor, key, sizeof key) || !take(&cursor, ':')) return 0;
        if (!strcmp(key, "catalogs")) {
            if (!take(&cursor, '[')) return 0;
            if (take(&cursor, ']')) return 0;
            do {
                StremioCatalogEntry entry;
                if (!addon_entry(&cursor, &entry)) return 0;
                if (addon->count < STREMIO_MAX_CATALOGS && entry.id[0] && entry.type[0])
                    addon->entries[addon->count++] = entry;
                if (take(&cursor, ']')) return addon->count > 0;
            } while (take(&cursor, ','));
            return 0;
        }
        if (!skip(&cursor, 1)) return 0;
        if (take(&cursor, '}')) break;
    } while (take(&cursor, ','));
    return 0;
}

static int stream_entry(Cursor *cursor, StremioStream *result) {
    memset(result, 0, sizeof *result);
    if (!take(cursor, '{')) return 0;
    do {
        char key[40];
        char *target = NULL;
        size_t size = 0;
        if (!string(cursor, key, sizeof key) || !take(cursor, ':')) return 0;
        if (!strcmp(key, "name")) target = result->name, size = sizeof result->name;
        else if (!strcmp(key, "title")) target = result->title, size = sizeof result->title;
        else if (!strcmp(key, "url")) target = result->url, size = sizeof result->url;
        if (target) {
            space(cursor);
            if (cursor->text[cursor->pos] == '"') {
                if (!string(cursor, target, size)) return 0;
            } else if (!skip(cursor, 1)) return 0;
        } else if (!skip(cursor, 1)) return 0;
        if (take(cursor, '}')) return 1;
    } while (take(cursor, ','));
    return 0;
}

int stremio_parse_streams(const char *json, StremioStreams *streams) {
    Cursor cursor = {json, 0};
    if (!json || !streams || !take(&cursor, '{')) return 0;
    memset(streams, 0, sizeof *streams);
    do {
        char key[40];
        if (!string(&cursor, key, sizeof key) || !take(&cursor, ':')) return 0;
        if (!strcmp(key, "streams")) {
            if (!take(&cursor, '[')) return 0;
            if (take(&cursor, ']')) return 1;
            do {
                StremioStream entry;
                if (!stream_entry(&cursor, &entry)) return 0;
                if (streams->count < STREMIO_MAX_STREAMS &&
                    (entry.name[0] || entry.title[0] || entry.url[0]))
                    streams->entries[streams->count++] = entry;
                if (take(&cursor, ']')) return 1;
            } while (take(&cursor, ','));
            return 0;
        }
        if (!skip(&cursor, 1)) return 0;
        if (take(&cursor, '}')) break;
    } while (take(&cursor, ','));
    return 0;
}
