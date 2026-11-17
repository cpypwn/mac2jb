#include "account.h"
#include "account_data.h"
#include "artwork.h"
#include "catalog.h"
#include "media.h"
#include "qr.h"
#include "session.h"
#include "ui.h"

#include <curl/curl.h>
#include <switch.h>

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_RESPONSE (1024 * 1024)
#define DEFAULT_MANIFEST "https://v3-cinemeta.strem.io/manifest.json"

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} Response;

static StremioCatalog catalog;
static StremioCard details;
static StremioEpisodes episodes;
static StremioAddon addon;
static StremioStreams streams;
static char catalog_base[STREMIO_ACCOUNT_ADDON_URL_LENGTH];
static char stream_base[STREMIO_ACCOUNT_ADDON_URL_LENGTH];
static char catalog_bases[STREMIO_MAX_CATALOGS][STREMIO_ACCOUNT_ADDON_URL_LENGTH];
static char status_text[160];
static StremioArtwork posters[STREMIO_MAX_CARDS];
static uint8_t poster_attempted[STREMIO_MAX_CARDS];
static StremioArtwork catalog_backdrop;
static StremioArtwork detail_poster;
static StremioArtwork detail_backdrop;
static StremioAccountAuth account;
static StremioAccountData account_data;
static int account_data_flags;
static StremioQr sign_in_qr;
static char account_stream_bases[STREMIO_ACCOUNT_MAX_ADDONS][STREMIO_ACCOUNT_ADDON_URL_LENGTH];
static size_t account_stream_count;
static size_t backdrop_catalog = SIZE_MAX;
static size_t backdrop_card = SIZE_MAX;
static uint8_t detail_poster_attempted;
static uint8_t detail_backdrop_attempted;

static void clear_catalog_artwork(void) {
    for (size_t i = 0; i < STREMIO_MAX_CARDS; i++)
        stremio_artwork_release(&posters[i]);
    memset(poster_attempted, 0, sizeof poster_attempted);
    stremio_artwork_release(&catalog_backdrop);
    backdrop_catalog = SIZE_MAX;
    backdrop_card = SIZE_MAX;
}

static void clear_detail_artwork(void) {
    stremio_artwork_release(&detail_poster);
    stremio_artwork_release(&detail_backdrop);
    detail_poster_attempted = 0;
    detail_backdrop_attempted = 0;
}

static size_t receive(char *bytes, size_t width, size_t count, void *context) {
    Response *response = context;
    size_t length;
    char *next;
    if (width && count > SIZE_MAX / width) return 0;
    length = width * count;
    if (response->length > MAX_RESPONSE || length > MAX_RESPONSE - response->length) return 0;
    if (response->length + length + 1 > response->capacity) {
        size_t capacity = response->capacity ? response->capacity * 2 : 8192;
        while (capacity < response->length + length + 1) {
            if (capacity > (MAX_RESPONSE + 1) / 2) {
                capacity = MAX_RESPONSE + 1;
                break;
            }
            capacity *= 2;
        }
        next = realloc(response->data, capacity);
        if (!next) return 0;
        response->data = next;
        response->capacity = capacity;
    }
    memcpy(response->data + response->length, bytes, length);
    response->length += length;
    response->data[response->length] = 0;
    return length;
}

static char *get_json(const char *url) {
    CURL *handle = curl_easy_init();
    Response response = {0};
    long status = 0;
    CURLcode result;
    if (!handle) return NULL;
    curl_easy_setopt(handle, CURLOPT_URL, url);
#if LIBCURL_VERSION_NUM >= 0x075500
    curl_easy_setopt(handle, CURLOPT_PROTOCOLS_STR, "http,https");
#else
    curl_easy_setopt(handle, CURLOPT_PROTOCOLS, CURLPROTO_HTTP | CURLPROTO_HTTPS);
#endif
    curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT, 4L);
    curl_easy_setopt(handle, CURLOPT_TIMEOUT, 8L);
    curl_easy_setopt(handle, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(handle, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(handle, CURLOPT_USERAGENT, "kaihen-stremio/0.1");
    curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(handle, CURLOPT_WRITEDATA, &response);
    result = curl_easy_perform(handle);
    curl_easy_getinfo(handle, CURLINFO_RESPONSE_CODE, &status);
    curl_easy_cleanup(handle);
    if (result != CURLE_OK || status != 200 || !response.data) {
        free(response.data);
        return NULL;
    }
    return response.data;
}

static int safe_id(const char *value) {
    if (!value || !*value) return 0;
    for (; *value; value++) {
        if (!isalnum((unsigned char)*value) && *value != '_' && *value != '-' && *value != ':') return 0;
    }
    return 1;
}

static int manifest_base(const char *url, char *base, size_t capacity) {
    const char *host;
    const char *path;
    const char *query;
    const char *end;
    size_t length, suffix_length;
    if (!strncmp(url, "https://", 8)) host = url + 8;
    else if (!strncmp(url, "http://", 7)) host = url + 7;
    else return 0;
    path = strchr(host, '/');
    if (!path || path == host || strpbrk(url, " \t\r\n#@\\")) return 0;
    for (const char *p = host; p < path; p++) {
        if (!isalnum((unsigned char)*p) && *p != '.' && *p != '-' && *p != ':') return 0;
    }
    query = strchr(path, '?');
    end = query ? query : url + strlen(url);
    if (end - path < 14 || memcmp(end - 14, "/manifest.json", 14)) return 0;
    length = (size_t)(end - 14 - url);
    suffix_length = query ? strlen(query) : 0;
    if (length + suffix_length >= capacity) return 0;
    memcpy(base, url, length);
    if (query) memcpy(base + length, query, suffix_length);
    base[length + suffix_length] = 0;
    return 1;
}

static int endpoint_url(const char *base, const char *endpoint, char *url, size_t capacity) {
    const char *query = strchr(base, '?');
    size_t prefix_length = query ? (size_t)(query - base) : strlen(base);
    size_t endpoint_length = strlen(endpoint);
    size_t query_length = query ? strlen(query) : 0;
    if (prefix_length + 1 + endpoint_length + query_length >= capacity) return 0;
    memcpy(url, base, prefix_length);
    url[prefix_length] = '/';
    memcpy(url + prefix_length + 1, endpoint, endpoint_length);
    if (query) memcpy(url + prefix_length + 1 + endpoint_length, query, query_length);
    url[prefix_length + 1 + endpoint_length + query_length] = 0;
    return 1;
}

static int configure_base(const char *path, const char *fallback, char *base, size_t capacity) {
    char url[1400];
    FILE *file = fopen(path, "rb");
    size_t length;
    if (file) {
        if (!fgets(url, sizeof url, file)) {
            fclose(file);
            return 0;
        }
        length = strlen(url);
        if (!feof(file) && length == sizeof url - 1 && url[length - 1] != '\n') {
            fclose(file);
            return 0;
        }
        fclose(file);
        while (length && isspace((unsigned char)url[length - 1])) url[--length] = 0;
    } else {
        if (snprintf(url, sizeof url, "%s", fallback) >= (int)sizeof url) return 0;
    }
    return manifest_base(url, base, capacity);
}

static int append_addon(const char *base) {
    char url[1400];
    char *json;
    StremioAddon found = {0};
    if (!base || !base[0]) return 0;
    if (!endpoint_url(base, "manifest.json", url, sizeof url)) return 0;
    json = get_json(url);
    if (!json) return 0;
    int valid = stremio_parse_manifest(json, &found);
    free(json);
    if (!valid) return 0;
    for (size_t i = 0; i < found.count && addon.count < STREMIO_MAX_CATALOGS; i++) {
        addon.entries[addon.count] = found.entries[i];
        snprintf(catalog_bases[addon.count], sizeof catalog_bases[addon.count], "%s", base);
        addon.count++;
    }
    return found.count != 0;
}

static int load_addon(void) {
    memset(&addon, 0, sizeof addon);
    memset(catalog_bases, 0, sizeof catalog_bases);
    account_stream_count = 0;
    if (account_data_flags & STREMIO_ACCOUNT_LOADED_LIBRARY) {
        StremioCatalogEntry *entry = &addon.entries[addon.count];
        snprintf(entry->name, sizeof entry->name, "My library");
        snprintf(entry->id, sizeof entry->id, "library");
        snprintf(entry->type, sizeof entry->type, "movie");
        snprintf(catalog_bases[addon.count], sizeof catalog_bases[addon.count], "%s", catalog_base);
        addon.count++;
    }
    for (size_t i = 0; i < account_data.addon_count; i++) {
        char base[STREMIO_ACCOUNT_ADDON_URL_LENGTH];
        if (!manifest_base(account_data.addon_urls[i], base, sizeof base)) continue;
        if (strcmp(base, catalog_base) && strcmp(base, stream_base) &&
            account_stream_count < STREMIO_ACCOUNT_MAX_ADDONS) {
            int duplicate = 0;
            for (size_t j = 0; j < account_stream_count; j++)
                if (!strcmp(base, account_stream_bases[j])) duplicate = 1;
            if (!duplicate)
                snprintf(account_stream_bases[account_stream_count++],
                         STREMIO_ACCOUNT_ADDON_URL_LENGTH, "%s", base);
        }
        int catalog_added = 0;
        for (size_t j = 0; j < addon.count; j++)
            if (!strcmp(base, catalog_bases[j])) catalog_added = 1;
        if (!catalog_added && addon.count < STREMIO_MAX_CATALOGS) append_addon(base);
    }
    int has_default = 0;
    for (size_t i = 0; i < addon.count; i++)
        if (!strcmp(catalog_bases[i], catalog_base)) has_default = 1;
    if (!has_default && addon.count < STREMIO_MAX_CATALOGS) append_addon(catalog_base);
    return addon.count != 0;
}

static int load_catalog(size_t selected_catalog) {
    char url[1400];
    char endpoint[256];
    char *json;
    StremioCatalogEntry *entry;
    clear_catalog_artwork();
    memset(&catalog, 0, sizeof catalog);
    if (selected_catalog >= addon.count) return 0;
    entry = &addon.entries[selected_catalog];
    if ((account_data_flags & STREMIO_ACCOUNT_LOADED_LIBRARY) && selected_catalog == 0) {
        catalog = account_data.library;
        return 1;
    }
    if (!safe_id(entry->type) || !safe_id(entry->id)) return 0;
    if (snprintf(endpoint, sizeof endpoint, "catalog/%s/%s.json", entry->type, entry->id) >=
        (int)sizeof endpoint ||
        !endpoint_url(catalog_bases[selected_catalog], endpoint, url, sizeof url)) return 0;
    json = get_json(url);
    if (!json) return 0;
    int valid = stremio_parse_catalog(json, &catalog);
    free(json);
    return valid;
}

static int load_details(size_t source_index, const char *type, const char *id) {
    char url[1400];
    char endpoint[320];
    char *json;
    if (source_index >= addon.count || !safe_id(type) || !safe_id(id)) return 0;
    if (snprintf(endpoint, sizeof endpoint, "meta/%s/%s.json", type, id) >=
        (int)sizeof endpoint) return 0;
    for (size_t i = 0; i < addon.count; i++) {
        size_t source = i == 0 ? source_index : i <= source_index ? i - 1 : i;
        int duplicate = 0;
        for (size_t previous = 0; previous < i; previous++) {
            size_t checked = previous == 0 ? source_index :
                             previous <= source_index ? previous - 1 : previous;
            if (!strcmp(catalog_bases[checked], catalog_bases[source])) {
                duplicate = 1;
                break;
            }
        }
        if (duplicate) continue;
        if (!endpoint_url(catalog_bases[source], endpoint, url, sizeof url)) continue;
        json = get_json(url);
        if (!json) continue;
        StremioCard found;
        StremioEpisodes found_episodes;
        int valid = stremio_parse_meta(json, &found) &&
                    stremio_parse_episodes(json, &found_episodes);
        free(json);
        if (!valid) continue;
        clear_detail_artwork();
        details = found;
        episodes = found_episodes;
        return 1;
    }
    return 0;
}

static int load_streams(const char *type, const char *id) {
    char url[1400];
    char endpoint[320];
    char *json;
    memset(&streams, 0, sizeof streams);
    if (!safe_id(type) || !safe_id(id) ||
        snprintf(endpoint, sizeof endpoint, "stream/%s/%s.json", type, id) >=
        (int)sizeof endpoint) return 0;
    for (size_t source = 0; source <= account_stream_count; source++) {
        const char *base = source == 0 ? stream_base : account_stream_bases[source - 1];
        if (!base[0] || !endpoint_url(base, endpoint, url, sizeof url)) continue;
        json = get_json(url);
        if (!json) continue;
        StremioStreams found;
        int valid = stremio_parse_streams(json, &found);
        free(json);
        if (!valid) continue;
        for (size_t i = 0; i < found.count && streams.count < STREMIO_MAX_STREAMS; i++) {
            if (!found.entries[i].url[0]) continue;
            int duplicate = 0;
            for (size_t j = 0; j < streams.count; j++) {
                if (!strcmp(found.entries[i].url, streams.entries[j].url)) {
                    duplicate = 1;
                    break;
                }
            }
            if (!duplicate) streams.entries[streams.count++] = found.entries[i];
        }
        if (streams.count == STREMIO_MAX_STREAMS) break;
    }
    return streams.count != 0;
}

static const StremioAccountLibraryState *saved_state_for(const char *id) {
    if (!id || !(account_data_flags & STREMIO_ACCOUNT_LOADED_LIBRARY)) return NULL;
    for (size_t i = 0; i < account_data.library.count; i++) {
        if (!strcmp(account_data.library.cards[i].id, id))
            return &account_data.library_state[i];
    }
    return NULL;
}

static size_t saved_episode_index(const char *id) {
    const StremioAccountLibraryState *saved = saved_state_for(id);
    if (!saved) return 0;
    for (size_t i = 0; i < episodes.count; i++) {
        if ((saved->video_id[0] && !strcmp(saved->video_id, episodes.entries[i].id)) ||
            (saved->season && saved->episode &&
             saved->season == episodes.entries[i].season &&
             saved->episode == episodes.entries[i].episode)) return i;
    }
    return 0;
}

static uint64_t saved_resume_ms(const char *video_id) {
    const StremioAccountLibraryState *saved = saved_state_for(details.id);
    if (!saved || !saved->position_ms || !video_id) return 0;
    if (saved->video_id[0] && strcmp(saved->video_id, video_id)) return 0;
    if (saved->duration_ms &&
        (saved->position_ms >= saved->duration_ms ||
         saved->duration_ms - saved->position_ms < 30000)) return 0;
    return saved->position_ms;
}

static void present(StremioBrowseScreen *screen, StremioUIView view,
                    size_t selected_catalog, size_t selected_card,
                    size_t selected_episode, size_t selected_stream) {
    const StremioArtwork *backdrop = view == STREMIO_UI_CATALOG
        ? &catalog_backdrop : detail_backdrop.pixels ? &detail_backdrop : &catalog_backdrop;
    StremioUIState state = {
        .view = view,
        .addon = &addon,
        .catalog = &catalog,
        .details = &details,
        .episodes = &episodes,
        .streams = &streams,
        .posters = posters,
        .detail_poster = &detail_poster,
        .backdrop = backdrop,
        .qr_modules = sign_in_qr.size ? sign_in_qr.modules : NULL,
        .qr_size = sign_in_qr.size,
        .selected_catalog = selected_catalog,
        .selected_card = selected_card,
        .selected_episode = selected_episode,
        .selected_stream = selected_stream,
        .sign_in_url = account.url[0] ? account.url : NULL,
        .status = view == STREMIO_UI_SIGN_IN ? account.message : status_text,
    };
    stremio_browse_present(screen, &state);
}

static int load_one_artwork(StremioUIView view, size_t selected_catalog, size_t selected_card) {
    if (view == STREMIO_UI_CATALOG && selected_card < catalog.count) {
        if (backdrop_catalog != selected_catalog || backdrop_card != selected_card) {
            stremio_artwork_release(&catalog_backdrop);
            backdrop_catalog = selected_catalog;
            backdrop_card = selected_card;
            if (catalog.cards[selected_card].background[0])
                stremio_artwork_fetch(catalog.cards[selected_card].background, 1024, 480,
                                      &catalog_backdrop);
            return 1;
        }
        size_t first = selected_card / 5 * 5;
        for (size_t i = first; i < catalog.count && i < first + 5; i++) {
            if (poster_attempted[i]) continue;
            poster_attempted[i] = 1;
            if (catalog.cards[i].poster[0])
                stremio_artwork_fetch(catalog.cards[i].poster, 240, 360, &posters[i]);
            return 1;
        }
    } else if (view == STREMIO_UI_DETAIL) {
        if (!detail_poster_attempted) {
            detail_poster_attempted = 1;
            if (details.poster[0]) stremio_artwork_fetch(details.poster, 280, 420, &detail_poster);
            return 1;
        }
        if (!detail_backdrop_attempted) {
            detail_backdrop_attempted = 1;
            if (details.background[0])
                stremio_artwork_fetch(details.background, 1024, 480, &detail_backdrop);
            return 1;
        }
    }
    return 0;
}

int main(void) {
    size_t selected_catalog = 0, selected_card = 0, selected_episode = 0, selected_stream = 0;
    StremioUIView view = STREMIO_UI_CATALOG;
    StremioUIView previous_view = STREMIO_UI_CATALOG;
    StremioBrowseScreen screen = {0};
    char stream_fallback[1400];
    PadState pad;
    int network_ready;
    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    padInitializeDefault(&pad);
    fsdevMountSdmc();
    stremio_account_init(&account);
    if (R_FAILED(stremio_browse_open(&screen))) return 1;
    snprintf(status_text, sizeof status_text, "Loading catalog");
    present(&screen, view, selected_catalog, selected_card, selected_episode, selected_stream);
    if (!configure_base("sdmc:/switch/kaihen-stremio/addon.url", DEFAULT_MANIFEST,
                        catalog_base, sizeof catalog_base))
        snprintf(status_text, sizeof status_text, "Invalid addon.url: use an HTTP(S) manifest URL");
    if (!endpoint_url(catalog_base, "manifest.json", stream_fallback, sizeof stream_fallback))
        stream_fallback[0] = 0;
    if (!configure_base("sdmc:/switch/kaihen-stremio/stream-addon.url", stream_fallback,
                        stream_base, sizeof stream_base))
        snprintf(status_text, sizeof status_text, "Invalid stream-addon.url: use an HTTP(S) manifest URL");
    Result network = socketInitializeDefault();
    network_ready = R_SUCCEEDED(network) && curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK;
    if (!network_ready) {
        snprintf(status_text, sizeof status_text, "Network initialization failed");
    } else if (catalog_base[0] && (!load_addon() || !load_catalog(0))) {
        snprintf(status_text, sizeof status_text, "Catalog unavailable. Press Y to retry");
    } else if (catalog_base[0]) {
        status_text[0] = 0;
    }
    present(&screen, view, selected_catalog, selected_card, selected_episode, selected_stream);
    while (appletMainLoop()) {
        padUpdate(&pad);
        u64 buttons = padGetButtonsDown(&pad);
        if (buttons & HidNpadButton_Plus) break;
        int dirty = buttons != 0;
        if ((buttons & HidNpadButton_Minus) && view != STREMIO_UI_SIGN_IN) {
            previous_view = view;
            view = STREMIO_UI_SIGN_IN;
            if (network_ready && account.state != STREMIO_AUTH_SIGNED_IN) {
                sign_in_qr.size = 0;
                if (stremio_account_start(&account) == 0 &&
                    !stremio_qr_encode(&sign_in_qr, account.url)) {
                    stremio_account_cancel(&account);
                    snprintf(account.message, sizeof account.message, "Could not create sign-in QR code");
                }
            } else if (!network_ready) {
                snprintf(account.message, sizeof account.message, "Network is unavailable");
            }
        } else if (view == STREMIO_UI_SIGN_IN) {
            if (buttons & HidNpadButton_B) {
                if (account.state == STREMIO_AUTH_WAITING) stremio_account_cancel(&account);
                sign_in_qr.size = 0;
                view = previous_view;
            } else if ((buttons & (HidNpadButton_A | HidNpadButton_Y)) && network_ready &&
                       account.state != STREMIO_AUTH_SIGNED_IN) {
                sign_in_qr.size = 0;
                if (stremio_account_start(&account) == 0 &&
                    !stremio_qr_encode(&sign_in_qr, account.url)) {
                    stremio_account_cancel(&account);
                    snprintf(account.message, sizeof account.message, "Could not create sign-in QR code");
                }
            }
        } else if (view == STREMIO_UI_CATALOG) {
            if ((buttons & HidNpadButton_Up) && selected_card > 0) selected_card--;
            if ((buttons & HidNpadButton_Down) && selected_card + 1 < catalog.count) selected_card++;
            if ((buttons & HidNpadButton_X) && addon.count && network_ready) {
                selected_catalog = (selected_catalog + 1) % addon.count;
                selected_card = 0;
                if (!load_catalog(selected_catalog)) snprintf(status_text, sizeof status_text, "Catalog unavailable");
                else status_text[0] = 0;
            }
            if ((buttons & HidNpadButton_A) && selected_card < catalog.count && network_ready) {
                StremioCard *card = &catalog.cards[selected_card];
                const char *type = card->type[0] ? card->type : addon.entries[selected_catalog].type;
                if (load_details(selected_catalog, type, card->id)) {
                    view = STREMIO_UI_DETAIL;
                    selected_episode = saved_episode_index(details.id);
                    status_text[0] = 0;
                }
                else snprintf(status_text, sizeof status_text, "Title unavailable");
            }
        } else if (view == STREMIO_UI_DETAIL) {
            if (buttons & HidNpadButton_B) view = STREMIO_UI_CATALOG;
            if ((buttons & HidNpadButton_A) && network_ready) {
                const char *type = details.type[0] ? details.type : addon.entries[selected_catalog].type;
                if (!strcmp(type, "series")) {
                    if (episodes.count) view = STREMIO_UI_EPISODES, status_text[0] = 0;
                    else snprintf(status_text, sizeof status_text, "No episodes returned by the metadata addon");
                } else {
                    selected_stream = 0;
                    if (load_streams(type, details.id)) view = STREMIO_UI_STREAMS, status_text[0] = 0;
                    else snprintf(status_text, sizeof status_text, "No stream addon response; configure stream-addon.url");
                }
            }
        } else if (view == STREMIO_UI_EPISODES) {
            if (buttons & HidNpadButton_B) view = STREMIO_UI_DETAIL;
            if ((buttons & HidNpadButton_Up) && selected_episode > 0) selected_episode--;
            if ((buttons & HidNpadButton_Down) && selected_episode + 1 < episodes.count) selected_episode++;
            if ((buttons & HidNpadButton_A) && selected_episode < episodes.count && network_ready) {
                selected_stream = 0;
                if (load_streams("series", episodes.entries[selected_episode].id))
                    view = STREMIO_UI_STREAMS, status_text[0] = 0;
                else snprintf(status_text, sizeof status_text, "No stream addon response; configure stream-addon.url");
            }
        } else {
            if (buttons & HidNpadButton_B)
                view = !strcmp(details.type[0] ? details.type : addon.entries[selected_catalog].type,
                               "series") ? STREMIO_UI_EPISODES : STREMIO_UI_DETAIL;
            if ((buttons & HidNpadButton_Up) && selected_stream > 0) selected_stream--;
            if ((buttons & HidNpadButton_Down) && selected_stream + 1 < streams.count) selected_stream++;
            if ((buttons & HidNpadButton_A) && selected_stream < streams.count && network_ready) {
                snprintf(status_text, sizeof status_text, "Opening stream");
                present(&screen, view, selected_catalog, selected_card, selected_episode, selected_stream);
                stremio_browse_close(&screen);
                const char *type = details.type[0] ? details.type : addon.entries[selected_catalog].type;
                const char *video_id = !strcmp(type, "series") && selected_episode < episodes.count
                    ? episodes.entries[selected_episode].id : details.id;
                stremio_native_play(streams.entries[selected_stream].url,
                                    saved_resume_ms(video_id), &pad,
                                    status_text, sizeof status_text);
                if (R_FAILED(stremio_browse_open(&screen))) break;
                dirty = 1;
            }
        }
        if ((buttons & HidNpadButton_Y) && network_ready && view != STREMIO_UI_SIGN_IN) {
            int valid = 0;
            if (view == STREMIO_UI_CATALOG) {
                if (load_addon()) {
                    if (selected_catalog >= addon.count) selected_catalog = 0;
                    valid = load_catalog(selected_catalog);
                }
            } else if (view == STREMIO_UI_DETAIL) {
                valid = load_details(selected_catalog, details.type[0] ? details.type :
                                     addon.entries[selected_catalog].type, details.id);
            } else if (view == STREMIO_UI_EPISODES) {
                valid = load_details(selected_catalog, details.type[0] ? details.type :
                                     addon.entries[selected_catalog].type, details.id);
                if (selected_episode >= episodes.count) selected_episode = 0;
            } else {
                const char *type = details.type[0] ? details.type : addon.entries[selected_catalog].type;
                const char *id = !strcmp(type, "series") && selected_episode < episodes.count
                                 ? episodes.entries[selected_episode].id : details.id;
                valid = load_streams(type, id);
            }
            if (!valid) snprintf(status_text, sizeof status_text, "Request failed. Press Y to retry");
            else status_text[0] = 0;
        }
        if (view == STREMIO_UI_SIGN_IN && account.state == STREMIO_AUTH_WAITING) {
            int result = stremio_account_poll(&account);
            if (result != 0) {
                dirty = 1;
                if (result > 0) {
                    sign_in_qr.size = 0;
                    view = previous_view;
                    char error[160] = {0};
                    account_data_flags = stremio_account_data_load(account.auth_key, &account_data,
                                                                    error, sizeof error);
                    if (!load_addon() || !load_catalog(0))
                        snprintf(status_text, sizeof status_text, "Signed in; catalog unavailable");
                    else if (!account_data_flags && error[0])
                        snprintf(status_text, sizeof status_text, "Signed in; %s", error);
                    else snprintf(status_text, sizeof status_text, "Signed in to Stremio");
                    selected_catalog = 0;
                    selected_card = 0;
                    view = STREMIO_UI_CATALOG;
                }
            }
        }
        if (dirty) present(&screen, view, selected_catalog, selected_card, selected_episode, selected_stream);
        if (network_ready && load_one_artwork(view, selected_catalog, selected_card))
            present(&screen, view, selected_catalog, selected_card, selected_episode, selected_stream);
        svcSleepThread(33000000LL);
    }
    stremio_account_cancel(&account);
    clear_catalog_artwork();
    clear_detail_artwork();
    stremio_browse_close(&screen);
    if (network_ready) curl_global_cleanup();
    if (R_SUCCEEDED(network)) socketExit();
    return 0;
}
