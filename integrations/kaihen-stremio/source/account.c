#include "account.h"

#include <curl/curl.h>

#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

enum { RESPONSE_LIMIT = 256 * 1024, JSON_DEPTH_LIMIT = 32 };

typedef struct {
    char *data;
    size_t length;
} Response;

static void clear_secret(char *value, size_t length) {
    volatile char *p = (volatile char *)value;
    while (length--) *p++ = 0;
}

static uint64_t now_seconds(void) {
    time_t now = time(NULL);
    return now > 0 ? (uint64_t)now : 0;
}

static size_t receive(char *bytes, size_t width, size_t count, void *context) {
    Response *response = context;
    if (width && count > SIZE_MAX / width) return 0;
    size_t length = width * count;
    if (length > RESPONSE_LIMIT - response->length) return 0;
    memcpy(response->data + response->length, bytes, length);
    response->length += length;
    response->data[response->length] = 0;
    return length;
}

static int request_json(const char *url, const char *body, Response *response) {
    CURL *curl = curl_easy_init();
    struct curl_slist *headers = NULL;
    CURLcode result;
    long status = 0;
    if (!curl) return 0;
    response->data = malloc(RESPONSE_LIMIT + 1);
    response->length = 0;
    if (!response->data) {
        curl_easy_cleanup(curl);
        return 0;
    }
    response->data[0] = 0;
    curl_easy_setopt(curl, CURLOPT_URL, url);
#if LIBCURL_VERSION_NUM >= 0x075500
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "https");
#else
    curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
#endif
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 8L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "kaihen-stremio/0.1");
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    headers = curl_slist_append(headers, "Accept: application/json");
    if (body) {
        headers = curl_slist_append(headers, "Content-Type: application/json");
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
    }
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    result = curl_easy_perform(curl);
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    if (result != CURLE_OK || status != 200 || response->length == 0) {
        free(response->data);
        response->data = NULL;
        response->length = 0;
        return 0;
    }
    return 1;
}

static void json_space(const char **cursor) {
    while (**cursor == ' ' || **cursor == '\n' || **cursor == '\r' || **cursor == '\t') (*cursor)++;
}

static int json_string(const char **cursor, char *output, size_t capacity) {
    size_t length = 0;
    if (**cursor != '"') return 0;
    (*cursor)++;
    while (**cursor && **cursor != '"') {
        unsigned char ch = (unsigned char)*(*cursor)++;
        if (ch == '\\') {
            ch = (unsigned char)*(*cursor)++;
            switch (ch) {
                case '"': case '\\': case '/': break;
                case 'b': ch = '\b'; break;
                case 'f': ch = '\f'; break;
                case 'n': ch = '\n'; break;
                case 'r': ch = '\r'; break;
                case 't': ch = '\t'; break;
                default: return 0;
            }
        } else if (ch < 32) {
            return 0;
        }
        if (length + 1 >= capacity) return 0;
        output[length++] = (char)ch;
    }
    if (**cursor != '"') return 0;
    (*cursor)++;
    output[length] = 0;
    return 1;
}

static int skip_value(const char **cursor, int depth) {
    char key[256];
    if (depth > JSON_DEPTH_LIMIT) return 0;
    json_space(cursor);
    if (**cursor == '"') {
        (*cursor)++;
        while (**cursor && **cursor != '"') {
            if (**cursor == '\\') {
                (*cursor)++;
                if (!**cursor) return 0;
            }
            (*cursor)++;
        }
        if (**cursor != '"') return 0;
        (*cursor)++;
        return 1;
    }
    if (**cursor == '{') {
        (*cursor)++;
        json_space(cursor);
        if (**cursor == '}') { (*cursor)++; return 1; }
        for (;;) {
            if (!json_string(cursor, key, sizeof key)) return 0;
            json_space(cursor);
            if (*(*cursor)++ != ':') return 0;
            if (!skip_value(cursor, depth + 1)) return 0;
            json_space(cursor);
            if (**cursor == '}') { (*cursor)++; return 1; }
            if (*(*cursor)++ != ',') return 0;
            json_space(cursor);
        }
    }
    if (**cursor == '[') {
        (*cursor)++;
        json_space(cursor);
        if (**cursor == ']') { (*cursor)++; return 1; }
        for (;;) {
            if (!skip_value(cursor, depth + 1)) return 0;
            json_space(cursor);
            if (**cursor == ']') { (*cursor)++; return 1; }
            if (*(*cursor)++ != ',') return 0;
        }
    }
    if (**cursor == '-' || isdigit((unsigned char)**cursor)) {
        do { (*cursor)++; } while (isdigit((unsigned char)**cursor) ||
                                  **cursor == '.' || **cursor == 'e' || **cursor == 'E' ||
                                  **cursor == '+' || **cursor == '-');
        return 1;
    }
    const char *literal = !strncmp(*cursor, "true", 4) ? "true" :
                          !strncmp(*cursor, "false", 5) ? "false" :
                          !strncmp(*cursor, "null", 4) ? "null" : NULL;
    if (!literal) return 0;
    *cursor += strlen(literal);
    return 1;
}

static int object_field(const char *object, const char *name, const char **value) {
    const char *cursor = object;
    char key[256];
    json_space(&cursor);
    if (*cursor++ != '{') return 0;
    json_space(&cursor);
    while (*cursor && *cursor != '}') {
        if (!json_string(&cursor, key, sizeof key)) return 0;
        json_space(&cursor);
        if (*cursor++ != ':') return 0;
        json_space(&cursor);
        if (!strcmp(key, name)) {
            *value = cursor;
            return 1;
        }
        if (!skip_value(&cursor, 1)) return 0;
        json_space(&cursor);
        if (*cursor == '}') break;
        if (*cursor++ != ',') return 0;
        json_space(&cursor);
    }
    return 0;
}

static int result_string(const char *json, const char *name, char *output, size_t capacity) {
    const char *result;
    const char *value;
    if (!object_field(json, "result", &result) ||
        !object_field(result, name, &value)) return 0;
    return json_string(&value, output, capacity);
}

static int valid_value(const char *value, size_t maximum) {
    size_t length = strlen(value);
    if (!length || length > maximum) return 0;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++)
        if (*p < 32 || *p == 127) return 0;
    return 1;
}

static int valid_link(const char *url) {
    size_t length = strlen(url);
    if (length < 10 || length >= 4096 || strncasecmp(url, "https://", 8)) return 0;
    const char *host = url + 8;
    const char *end = host;
    while (*end && *end != '/' && *end != '?' && *end != '#') end++;
    size_t host_length = (size_t)(end - host);
    if (host_length > 4 && !strncasecmp(end - 4, ":443", 4)) host_length -= 4;
    if (!((host_length == 16 && !strncasecmp(host, "link.stremio.com", 16)) ||
          (host_length == 15 && !strncasecmp(host, "www.stremio.com", 15)) ||
          (host_length == 11 && !strncasecmp(host, "stremio.com", 11)))) return 0;
    for (const unsigned char *p = (const unsigned char *)url; *p; p++)
        if (*p <= 32 || *p >= 127 || *p == '\\' || *p == '#') return 0;
    return 1;
}

static int json_quote(const char *value, char *output, size_t capacity) {
    size_t length = 0;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        if (*p < 32 || *p == 127) return 0;
        if (*p == '"' || *p == '\\') {
            if (length + 2 >= capacity) return 0;
            output[length++] = '\\';
        } else if (length + 1 >= capacity) return 0;
        output[length++] = (char)*p;
    }
    output[length] = 0;
    return 1;
}

static int fail(StremioAccountAuth *account, const char *message) {
    clear_secret(account->code, sizeof account->code);
    clear_secret(account->auth_key, sizeof account->auth_key);
    account->url[0] = 0;
    account->state = STREMIO_AUTH_FAILED;
    snprintf(account->message, sizeof account->message, "%s", message);
    return -1;
}

void stremio_account_init(StremioAccountAuth *account) {
    if (!account) return;
    memset(account, 0, sizeof *account);
    account->state = STREMIO_AUTH_IDLE;
}

void stremio_account_cancel(StremioAccountAuth *account) {
    if (!account) return;
    clear_secret(account->code, sizeof account->code);
    clear_secret(account->auth_key, sizeof account->auth_key);
    account->url[0] = 0;
    account->deadline_seconds = 0;
    account->next_poll_seconds = 0;
    account->state = STREMIO_AUTH_IDLE;
    account->message[0] = 0;
}

int stremio_account_start(StremioAccountAuth *account) {
    Response response = {0};
    if (!account) return -1;
    stremio_account_cancel(account);
    if (!request_json("https://link.stremio.com/api/v2/create?type=Create", NULL, &response))
        return fail(account, "Could not start Stremio sign-in");
    int valid = result_string(response.data, "code", account->code, sizeof account->code) &&
                result_string(response.data, "link", account->url, sizeof account->url) &&
                valid_value(account->code, 256) && valid_link(account->url);
    free(response.data);
    if (!valid) return fail(account, "Stremio returned an invalid sign-in link");
    account->deadline_seconds = now_seconds() + 300;
    account->next_poll_seconds = now_seconds() + 5;
    account->state = STREMIO_AUTH_WAITING;
    snprintf(account->message, sizeof account->message, "Scan the QR code and approve sign-in");
    return 0;
}

int stremio_account_poll(StremioAccountAuth *account) {
    Response response = {0};
    char url[1024];
    char body[8192];
    char escaped[8192];
    char token[4097] = {0};
    if (!account) return -1;
    if (account->state == STREMIO_AUTH_SIGNED_IN) return 1;
    if (account->state != STREMIO_AUTH_WAITING) return -1;
    uint64_t now = now_seconds();
    if (now >= account->deadline_seconds) {
        stremio_account_cancel(account);
        account->state = STREMIO_AUTH_EXPIRED;
        snprintf(account->message, sizeof account->message, "Sign-in timed out. Start again for a new QR code");
        return -1;
    }
    if (now < account->next_poll_seconds) return 0;
    account->next_poll_seconds = now + 5;
    CURL *curl = curl_easy_init();
    if (!curl) return fail(account, "Could not prepare Stremio sign-in check");
    char *code = curl_easy_escape(curl, account->code, 0);
    int url_ok = code && snprintf(url, sizeof url,
        "https://link.stremio.com/api/v2/read?type=Read&code=%s", code) < (int)sizeof url;
    curl_free(code);
    curl_easy_cleanup(curl);
    if (!url_ok) return fail(account, "Stremio sign-in code is invalid");
    if (!request_json(url, NULL, &response)) return 0;
    int has_token = result_string(response.data, "authKey", token, sizeof token);
    clear_secret(response.data, response.length);
    free(response.data);
    if (!has_token) return 0;
    if (!valid_value(token, 4096) || !json_quote(token, escaped, sizeof escaped)) {
        clear_secret(token, sizeof token);
        return fail(account, "Stremio sign-in token is invalid");
    }
    clear_secret(token, sizeof token);
    if (snprintf(body, sizeof body, "{\"type\":\"LoginWithToken\",\"token\":\"%s\"}", escaped) >= (int)sizeof body) {
        clear_secret(escaped, sizeof escaped);
        return fail(account, "Stremio sign-in token is too long");
    }
    clear_secret(escaped, sizeof escaped);
    if (!request_json("https://api.strem.io/api/loginWithToken", body, &response)) {
        clear_secret(body, sizeof body);
        return fail(account, "Could not finish Stremio sign-in");
    }
    clear_secret(body, sizeof body);
    int valid = result_string(response.data, "authKey", account->auth_key, sizeof account->auth_key) &&
                valid_value(account->auth_key, 4096);
    clear_secret(response.data, response.length);
    free(response.data);
    if (!valid) return fail(account, "Stremio returned an invalid account key");
    clear_secret(account->code, sizeof account->code);
    account->url[0] = 0;
    account->state = STREMIO_AUTH_SIGNED_IN;
    snprintf(account->message, sizeof account->message, "Signed in to Stremio");
    return 1;
}
