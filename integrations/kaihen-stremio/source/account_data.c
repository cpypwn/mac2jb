#include "account_data.h"

#include <curl/curl.h>

#include <ctype.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

enum { RESPONSE_LIMIT = 8 * 1024 * 1024, JSON_DEPTH_LIMIT = 32 };

typedef struct {
    const char *start;
    const char *end;
} Span;

typedef struct {
    const char *p;
    const char *end;
} Cursor;

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} Response;

static void clear_secret(char *value, size_t length) {
    volatile char *p = (volatile char *)value;
    while (length--) *p++ = 0;
}

static void set_error(char *error, size_t capacity, const char *message) {
    if (error && capacity) snprintf(error, capacity, "%s", message);
}

static void space(Cursor *cursor) {
    while (cursor->p < cursor->end &&
           (*cursor->p == ' ' || *cursor->p == '\n' ||
            *cursor->p == '\r' || *cursor->p == '\t')) cursor->p++;
}

static int hex_digit(char digit) {
    if (digit >= '0' && digit <= '9') return digit - '0';
    if (digit >= 'a' && digit <= 'f') return digit - 'a' + 10;
    if (digit >= 'A' && digit <= 'F') return digit - 'A' + 10;
    return -1;
}

static int hex_quad(Cursor *cursor, unsigned *codepoint) {
    unsigned value = 0;
    if (cursor->end - cursor->p < 4) return 0;
    for (int i = 0; i < 4; i++) {
        int digit = hex_digit(*cursor->p++);
        if (digit < 0) return 0;
        value = (value << 4) | (unsigned)digit;
    }
    *codepoint = value;
    return 1;
}

static int append_utf8(unsigned codepoint, char *output, size_t capacity, size_t *length) {
    unsigned char bytes[4];
    size_t count;
    if (codepoint <= 0x7f) {
        bytes[0] = (unsigned char)codepoint;
        count = 1;
    } else if (codepoint <= 0x7ff) {
        bytes[0] = (unsigned char)(0xc0 | (codepoint >> 6));
        bytes[1] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 2;
    } else if (codepoint <= 0xffff) {
        bytes[0] = (unsigned char)(0xe0 | (codepoint >> 12));
        bytes[1] = (unsigned char)(0x80 | ((codepoint >> 6) & 0x3f));
        bytes[2] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 3;
    } else if (codepoint <= 0x10ffff) {
        bytes[0] = (unsigned char)(0xf0 | (codepoint >> 18));
        bytes[1] = (unsigned char)(0x80 | ((codepoint >> 12) & 0x3f));
        bytes[2] = (unsigned char)(0x80 | ((codepoint >> 6) & 0x3f));
        bytes[3] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 4;
    } else return 0;
    if (output) {
        if (*length > capacity || count >= capacity - *length) return 0;
        memcpy(output + *length, bytes, count);
    }
    *length += count;
    return 1;
}

static int string(Cursor *cursor, char *output, size_t capacity) {
    size_t length = 0;
    if (cursor->p >= cursor->end || *cursor->p++ != '"') return 0;
    while (cursor->p < cursor->end) {
        unsigned char byte = (unsigned char)*cursor->p++;
        unsigned codepoint = byte;
        if (byte == '"') {
            if (output) {
                if (length >= capacity) return 0;
                output[length] = 0;
            }
            return 1;
        }
        if (byte < 32) return 0;
        if (byte >= 128) {
            if (output) {
                if (length + 1 >= capacity) return 0;
                output[length] = (char)byte;
            }
            length++;
            continue;
        }
        if (byte == '\\') {
            if (cursor->p >= cursor->end) return 0;
            switch (*cursor->p++) {
                case '"': codepoint = '"'; break;
                case '\\': codepoint = '\\'; break;
                case '/': codepoint = '/'; break;
                case 'b': codepoint = '\b'; break;
                case 'f': codepoint = '\f'; break;
                case 'n': codepoint = '\n'; break;
                case 'r': codepoint = '\r'; break;
                case 't': codepoint = '\t'; break;
                case 'u': {
                    if (!hex_quad(cursor, &codepoint)) return 0;
                    if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
                        unsigned low;
                        if (cursor->end - cursor->p < 2 ||
                            cursor->p[0] != '\\' || cursor->p[1] != 'u') return 0;
                        cursor->p += 2;
                        if (!hex_quad(cursor, &low) || low < 0xdc00 || low > 0xdfff) return 0;
                        codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
                    } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) return 0;
                    break;
                }
                default: return 0;
            }
        }
        if (!append_utf8(codepoint, output, capacity, &length)) return 0;
    }
    return 0;
}

static int literal(Cursor *cursor, const char *value) {
    size_t length = strlen(value);
    if ((size_t)(cursor->end - cursor->p) < length ||
        memcmp(cursor->p, value, length)) return 0;
    cursor->p += length;
    return 1;
}

static int number(Cursor *cursor) {
    const char *p = cursor->p;
    if (p < cursor->end && *p == '-') p++;
    if (p >= cursor->end) return 0;
    if (*p == '0') p++;
    else if (*p >= '1' && *p <= '9') {
        do { p++; } while (p < cursor->end && isdigit((unsigned char)*p));
    } else return 0;
    if (p < cursor->end && *p == '.') {
        p++;
        if (p >= cursor->end || !isdigit((unsigned char)*p)) return 0;
        do { p++; } while (p < cursor->end && isdigit((unsigned char)*p));
    }
    if (p < cursor->end && (*p == 'e' || *p == 'E')) {
        p++;
        if (p < cursor->end && (*p == '+' || *p == '-')) p++;
        if (p >= cursor->end || !isdigit((unsigned char)*p)) return 0;
        do { p++; } while (p < cursor->end && isdigit((unsigned char)*p));
    }
    cursor->p = p;
    return 1;
}

static int value(Cursor *cursor, unsigned depth) {
    if (depth > JSON_DEPTH_LIMIT) return 0;
    space(cursor);
    if (cursor->p >= cursor->end) return 0;
    if (*cursor->p == '"') return string(cursor, NULL, 0);
    if (*cursor->p == '{' || *cursor->p == '[') {
        int object = *cursor->p++ == '{';
        space(cursor);
        if (cursor->p < cursor->end && *cursor->p == (object ? '}' : ']')) {
            cursor->p++;
            return 1;
        }
        for (;;) {
            if (object) {
                if (!string(cursor, NULL, 0)) return 0;
                space(cursor);
                if (cursor->p >= cursor->end || *cursor->p++ != ':') return 0;
            }
            if (!value(cursor, depth + 1)) return 0;
            space(cursor);
            if (cursor->p >= cursor->end) return 0;
            if (*cursor->p == (object ? '}' : ']')) {
                cursor->p++;
                return 1;
            }
            if (*cursor->p++ != ',') return 0;
            space(cursor);
        }
    }
    if (*cursor->p == 't') return literal(cursor, "true");
    if (*cursor->p == 'f') return literal(cursor, "false");
    if (*cursor->p == 'n') return literal(cursor, "null");
    return number(cursor);
}

static int next_span(Cursor *cursor, Span *span) {
    space(cursor);
    span->start = cursor->p;
    if (!value(cursor, 0)) return 0;
    span->end = cursor->p;
    return 1;
}

static int document(const char *json, Span *root) {
    Cursor cursor;
    if (!json) return 0;
    cursor.p = json;
    cursor.end = json + strlen(json);
    if (!next_span(&cursor, root)) return 0;
    space(&cursor);
    return cursor.p == cursor.end;
}

static int field(Span object, const char *name, Span *found) {
    Cursor cursor = {object.start, object.end};
    char key[128];
    if (cursor.p >= cursor.end || *cursor.p++ != '{') return 0;
    space(&cursor);
    while (cursor.p < cursor.end && *cursor.p != '}') {
        if (!string(&cursor, key, sizeof key)) return 0;
        space(&cursor);
        if (cursor.p >= cursor.end || *cursor.p++ != ':') return 0;
        if (!next_span(&cursor, found)) return 0;
        if (!strcmp(key, name)) return 1;
        space(&cursor);
        if (cursor.p < cursor.end && *cursor.p == ',') {
            cursor.p++;
            space(&cursor);
        } else break;
    }
    return 0;
}

static int read_string(Span span, char *output, size_t capacity) {
    Cursor cursor = {span.start, span.end};
    return string(&cursor, output, capacity) && cursor.p == cursor.end;
}

static int read_bool(Span span, int *output) {
    size_t length = (size_t)(span.end - span.start);
    if (length == 4 && !memcmp(span.start, "true", 4)) { *output = 1; return 1; }
    if (length == 5 && !memcmp(span.start, "false", 5)) { *output = 0; return 1; }
    return 0;
}

static int read_uint(Span span, uint64_t *output) {
    uint64_t value = 0;
    if (span.start == span.end) return 0;
    for (const char *p = span.start; p < span.end; p++) {
        unsigned digit = (unsigned)(*p - '0');
        if (digit > 9 || value > (UINT64_MAX - digit) / 10) return 0;
        value = value * 10 + digit;
    }
    *output = value;
    return 1;
}

static int string_field(Span object, const char *name, char *output, size_t capacity) {
    Span span;
    return field(object, name, &span) && read_string(span, output, capacity);
}

static int result(Span root, char expected, Span *out) {
    Span error;
    if (root.start >= root.end || *root.start != '{') return 0;
    if (field(root, "error", &error) &&
        ((size_t)(error.end - error.start) != 4 ||
         memcmp(error.start, "null", 4))) return 0;
    if (!field(root, "result", out)) return 0;
    return out->start < out->end && *out->start == expected;
}

static int valid_manifest_url(const char *url) {
    const char *host;
    const char *path;
    const char *end;
    size_t length = strlen(url);
    if (!length || length >= STREMIO_ACCOUNT_ADDON_URL_LENGTH) return 0;
    if (!strncasecmp(url, "https://", 8)) host = url + 8;
    else if (!strncasecmp(url, "http://", 7)) host = url + 7;
    else return 0;
    path = strchr(host, '/');
    if (!path || path == host) return 0;
    for (const char *p = host; p < path; p++) {
        if (*p == '@' || *p == '#' || *p == '\\' || (unsigned char)*p <= 32) return 0;
    }
    end = strchr(path, '?');
    if (!end) end = url + length;
    if (end - path < 14 || memcmp(end - 14, "/manifest.json", 14)) return 0;
    for (const unsigned char *p = (const unsigned char *)path; *p; p++) {
        if (*p <= 32 || *p == 127 || *p == '#' || *p == '\\') return 0;
    }
    return 1;
}

static int array_start(Span array, Cursor *cursor) {
    if (array.start >= array.end || *array.start != '[') return 0;
    cursor->p = array.start + 1;
    cursor->end = array.end;
    space(cursor);
    return 1;
}

static int array_next(Cursor *cursor, Span *item) {
    if (cursor->p >= cursor->end || *cursor->p == ']') return 0;
    if (!next_span(cursor, item)) return -1;
    space(cursor);
    if (cursor->p >= cursor->end) return -1;
    if (*cursor->p == ',') {
        cursor->p++;
        space(cursor);
    } else if (*cursor->p != ']') return -1;
    return 1;
}

int stremio_account_data_parse_addons(const char *json, StremioAccountData *out) {
    Span root, collection, addons, item, manifest;
    Cursor cursor;
    size_t examined = 0;
    if (!out || !document(json, &root) || !result(root, '{', &collection) ||
        !field(collection, "addons", &addons) || !array_start(addons, &cursor)) return 0;
    out->addon_count = 0;
    out->addon_total = 0;
    out->addon_skipped = 0;
    for (;;) {
        int next = array_next(&cursor, &item);
        char url[STREMIO_ACCOUNT_ADDON_URL_LENGTH];
        char id[256];
        if (next < 0) return 0;
        if (next == 0) break;
        if (++examined > 2048) return 0;
        if (!field(item, "manifest", &manifest) ||
            !string_field(manifest, "id", id, sizeof id) || !id[0] ||
            !string_field(item, "transportUrl", url, sizeof url) ||
            !valid_manifest_url(url)) {
            out->addon_skipped++;
            continue;
        }
        int duplicate = 0;
        for (size_t i = 0; i < out->addon_count; i++) {
            if (!strcmp(out->addon_urls[i], url)) { duplicate = 1; break; }
        }
        if (duplicate) continue;
        out->addon_total++;
        if (out->addon_count < STREMIO_ACCOUNT_MAX_ADDONS)
            snprintf(out->addon_urls[out->addon_count++], STREMIO_ACCOUNT_ADDON_URL_LENGTH, "%s", url);
    }
    return 1;
}

static int valid_image_url(const char *url) {
    if (!url[0]) return 0;
    if (strncasecmp(url, "https://", 8) && strncasecmp(url, "http://", 7)) return 0;
    for (const unsigned char *p = (const unsigned char *)url; *p; p++)
        if (*p <= 32 || *p == 127 || *p == '\\') return 0;
    return 1;
}

static void state_field_uint(Span state, const char *name, uint64_t *output) {
    Span span;
    if (field(state, name, &span)) read_uint(span, output);
}

static int library_item(Span item, StremioCard *card, StremioAccountLibraryState *state,
                        char *modified, size_t modified_capacity) {
    Span flag, record_state;
    int removed, temp;
    memset(card, 0, sizeof *card);
    memset(state, 0, sizeof *state);
    modified[0] = 0;
    if (!field(item, "removed", &flag) || !read_bool(flag, &removed) || removed ||
        !string_field(item, "_id", card->id, sizeof card->id) || !card->id[0] ||
        !string_field(item, "name", card->name, sizeof card->name) || !card->name[0] ||
        !string_field(item, "type", card->type, sizeof card->type) || !card->type[0]) return 0;
    if (field(item, "temp", &flag) && read_bool(flag, &temp) && temp) return 0;
    if (!string_field(item, "poster", card->poster, sizeof card->poster) ||
        !valid_image_url(card->poster)) card->poster[0] = 0;
    string_field(item, "_mtime", modified, modified_capacity);
    if (field(item, "state", &record_state) && *record_state.start == '{') {
        string_field(record_state, "video_id", state->video_id, sizeof state->video_id);
        state_field_uint(record_state, "timeOffset", &state->position_ms);
        state_field_uint(record_state, "duration", &state->duration_ms);
        uint64_t number_value = 0;
        state_field_uint(record_state, "season", &number_value);
        if (number_value <= UINT32_MAX) state->season = (unsigned)number_value;
        number_value = 0;
        state_field_uint(record_state, "episode", &number_value);
        if (number_value <= UINT32_MAX) state->episode = (unsigned)number_value;
    }
    return 1;
}

int stremio_account_data_parse_library(const char *json, StremioAccountData *out) {
    Span root, items, item;
    Cursor cursor;
    char *sort_keys;
    size_t examined = 0;
    if (!out || !document(json, &root) || !result(root, '[', &items) ||
        !array_start(items, &cursor)) return 0;
    sort_keys = calloc(STREMIO_MAX_CARDS, 64);
    if (!sort_keys) return 0;
    out->library.count = 0;
    out->library_total = 0;
    for (;;) {
        StremioCard card;
        StremioAccountLibraryState state;
        char modified[64];
        int next = array_next(&cursor, &item);
        if (next < 0) { free(sort_keys); return 0; }
        if (next == 0) break;
        if (++examined > 50000) { free(sort_keys); return 0; }
        if (!library_item(item, &card, &state, modified, sizeof modified)) continue;
        out->library_total++;
        size_t count = out->library.count;
        size_t place = 0;
        while (place < count && strcmp(modified, sort_keys + place * 64) <= 0) place++;
        if (place >= STREMIO_MAX_CARDS) continue;
        if (count < STREMIO_MAX_CARDS) out->library.count++;
        for (size_t i = out->library.count - 1; i > place; i--) {
            out->library.cards[i] = out->library.cards[i - 1];
            out->library_state[i] = out->library_state[i - 1];
            memcpy(sort_keys + i * 64, sort_keys + (i - 1) * 64, 64);
        }
        out->library.cards[place] = card;
        out->library_state[place] = state;
        snprintf(sort_keys + place * 64, 64, "%s", modified);
    }
    free(sort_keys);
    return 1;
}

static size_t receive(char *bytes, size_t width, size_t count, void *context) {
    Response *response = context;
    if (width && count > SIZE_MAX / width) return 0;
    size_t length = width * count;
    if (length > RESPONSE_LIMIT - response->length) return 0;
    if (response->length + length + 1 > response->capacity) {
        size_t capacity = response->capacity ? response->capacity * 2 : 65536;
        while (capacity < response->length + length + 1) capacity *= 2;
        if (capacity > RESPONSE_LIMIT + 1) capacity = RESPONSE_LIMIT + 1;
        char *expanded = realloc(response->data, capacity);
        if (!expanded) return 0;
        response->data = expanded;
        response->capacity = capacity;
    }
    memcpy(response->data + response->length, bytes, length);
    response->length += length;
    response->data[response->length] = 0;
    return length;
}

static int request_json(const char *endpoint, const char *body, Response *response) {
    CURL *curl = curl_easy_init();
    struct curl_slist *headers = NULL;
    CURLcode status;
    long http_status = 0;
    char url[128];
    if (!curl) return 0;
    memset(response, 0, sizeof *response);
    if (snprintf(url, sizeof url, "https://api.strem.io/api/%s", endpoint) >= (int)sizeof url) {
        curl_easy_cleanup(curl);
        return 0;
    }
    curl_easy_setopt(curl, CURLOPT_URL, url);
#if LIBCURL_VERSION_NUM >= 0x075500
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");
#else
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
#endif
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 8L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 25L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "kaihen-stremio/0.1");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
    headers = curl_slist_append(headers, "Accept: application/json");
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    status = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    if (status != CURLE_OK || http_status != 200 || !response->length) {
        free(response->data);
        memset(response, 0, sizeof *response);
        return 0;
    }
    return 1;
}

static int quote_key(const char *key, char *quoted, size_t capacity) {
    size_t length = 0;
    if (!key || !*key) return 0;
    for (const unsigned char *p = (const unsigned char *)key; *p; p++) {
        if (*p < 32 || *p == 127) return 0;
        if (*p == '"' || *p == '\\') {
            if (length + 2 >= capacity) return 0;
            quoted[length++] = '\\';
        } else if (length + 1 >= capacity) return 0;
        quoted[length++] = (char)*p;
    }
    quoted[length] = 0;
    return length <= 8192;
}

int stremio_account_data_load(const char *auth_key, StremioAccountData *out,
                              char *error, size_t error_capacity) {
    Response response;
    char quoted[8193];
    char body[8300];
    int loaded = 0;
    if (!out) return 0;
    memset(out, 0, sizeof *out);
    set_error(error, error_capacity, "");
    if (!auth_key || strlen(auth_key) > 4096 ||
        !quote_key(auth_key, quoted, sizeof quoted)) {
        set_error(error, error_capacity, "Invalid Stremio account key");
        return 0;
    }
    snprintf(body, sizeof body,
             "{\"type\":\"AddonCollectionGet\",\"authKey\":\"%s\",\"update\":true}", quoted);
    if (request_json("addonCollectionGet", body, &response)) {
        if (stremio_account_data_parse_addons(response.data, out)) loaded |= STREMIO_ACCOUNT_LOADED_ADDONS;
        free(response.data);
    }
    snprintf(body, sizeof body,
             "{\"authKey\":\"%s\",\"collection\":\"libraryItem\",\"ids\":[],\"all\":true}", quoted);
    if (request_json("datastoreGet", body, &response)) {
        if (stremio_account_data_parse_library(response.data, out)) loaded |= STREMIO_ACCOUNT_LOADED_LIBRARY;
        free(response.data);
    }
    clear_secret(body, sizeof body);
    clear_secret(quoted, sizeof quoted);
    if (loaded == 0) set_error(error, error_capacity, "Could not load Stremio account data");
    else if (!(loaded & STREMIO_ACCOUNT_LOADED_ADDONS))
        set_error(error, error_capacity, "Stremio add-ons could not be loaded");
    else if (!(loaded & STREMIO_ACCOUNT_LOADED_LIBRARY))
        set_error(error, error_capacity, "Stremio library could not be loaded");
    return loaded;
}
