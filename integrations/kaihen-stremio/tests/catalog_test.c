#include "catalog.h"

#include <assert.h>
#include <string.h>

int main(void) {
    StremioCatalog catalog;
    StremioCard card;
    StremioAddon addon;
    StremioStreams streams;
    StremioEpisodes episodes;
    assert(stremio_parse_catalog("{\"metas\":[{\"id\":\"tt1\",\"name\":\"One\",\"poster\":\"https://img.example/poster.jpg\",\"background\":\"https://img.example/backdrop.jpg\"},{\"id\":\"tt2\",\"name\":\"Two\\nAgain\"}]}", &catalog));
    assert(catalog.count == 2);
    assert(strcmp(catalog.cards[0].id, "tt1") == 0);
    assert(strcmp(catalog.cards[0].poster, "https://img.example/poster.jpg") == 0);
    assert(strcmp(catalog.cards[0].background, "https://img.example/backdrop.jpg") == 0);
    assert(strcmp(catalog.cards[1].name, "Two Again") == 0);
    assert(stremio_parse_meta("{\"meta\":{\"id\":\"tt1\",\"name\":\"One\",\"description\":\"Hello\\u0020world\",\"poster\":\"https://img.example/poster.jpg\",\"background\":\"https://img.example/backdrop.jpg\",\"logo\":\"https://img.example/logo.png\"}}", &card));
    assert(strcmp(card.description, "Hello world") == 0);
    assert(strcmp(card.logo, "https://img.example/logo.png") == 0);
    assert(stremio_parse_episodes("{\"meta\":{\"id\":\"tt1\",\"videos\":[{\"id\":\"tt1:1:1\",\"title\":\"Pilot\",\"season\":1,\"episode\":1},{\"id\":\"tt1:1:2\",\"title\":\"Next\",\"season\":1,\"episode\":2}]}}", &episodes));
    assert(episodes.count == 2 && strcmp(episodes.entries[1].id, "tt1:1:2") == 0);
    assert(episodes.entries[1].season == 1 && episodes.entries[1].episode == 2);
    assert(!stremio_parse_episodes("{\"meta\":{\"videos\":[{\"id\":\"tt1:1:1\"}", &episodes));
    assert(!stremio_parse_catalog("{\"metas\":[{\"id\":\"tt1\",\"name\":\"One\"}", &catalog));
    assert(!stremio_parse_catalog("{\"metas\":[{\"id\":\"tt1\"}", &catalog));
    assert(!stremio_parse_catalog("{\"unrelated\":[]}", &catalog));
    assert(!stremio_parse_catalog("{\"metas\":[{\"id\":\"tt1\",\"name\":\"broken\\u", &catalog));
    assert(stremio_parse_manifest("{\"id\":\"test\",\"catalogs\":[{\"type\":\"movie\",\"id\":\"top\",\"name\":\"Popular\"},{\"type\":\"series\",\"id\":\"new\"}]}", &addon));
    assert(addon.count == 2);
    assert(strcmp(addon.entries[0].name, "Popular") == 0);
    assert(strcmp(addon.entries[1].type, "series") == 0);
    assert(!stremio_parse_manifest("{\"catalogs\":[]}", &addon));
    assert(!stremio_parse_manifest("{\"catalogs\":[{\"type\":\"movie\",\"id\":\"top\"}", &addon));
    assert(stremio_parse_streams("{\"streams\":[{\"name\":\"Provider\",\"title\":\"1080p\",\"url\":\"https://example.org/a.mp4\"},{\"name\":\"Other\"}]}", &streams));
    assert(streams.count == 2);
    assert(strcmp(streams.entries[0].url, "https://example.org/a.mp4") == 0);
    assert(stremio_parse_streams("{\"streams\":[]}", &streams));
    assert(streams.count == 0);
    assert(stremio_parse_streams("{\"streams\":[{\"name\":\"Provider\",\"url\":null}]}", &streams));
    assert(streams.count == 1);
    assert(!stremio_parse_streams("{\"streams\":[{\"name\":\"broken\"}", &streams));
    return 0;
}
