#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <libusbd.h>

#define MAX_PAYLOAD_BYTES 131072
#define MAX_PAYLOAD_LINES 256
#define MAX_LINE_BYTES 254

enum {
    KEY_HOLD_MS = 40,
    KEY_GAP_MS = 40,
    ENTER_HOLD_MS = 40,
    ENTER_GAP_MS = 200,
    PRE_A_WAIT_MS = 800,
    POST_A_WAIT_MS = 1200,
    A_PRESS_MS = 50,
    PREAMBLE_A_COUNT = 5,
    PREAMBLE_GAP_MS = 800,
    ESC_TO_A_WAIT_MS = 800
};

static volatile sig_atomic_t interrupted;

static const uint8_t gamepad_report_descriptor[] = {
    0x05,0x01,0x09,0x05,0xa1,0x01,0x15,0x00,0x25,0x01,0x35,0x00,0x45,0x01,
    0x75,0x01,0x95,0x10,0x05,0x09,0x19,0x01,0x29,0x10,0x81,0x02,0x05,0x01,
    0x25,0x07,0x46,0x3b,0x01,0x75,0x04,0x95,0x01,0x65,0x14,0x09,0x39,
    0x81,0x42,0x65,0x00,0x95,0x01,0x81,0x01,0x26,0xff,0x00,0x46,0xff,
    0x00,0x09,0x30,0x09,0x31,0x09,0x32,0x09,0x35,0x75,0x08,0x95,0x04,
    0x81,0x02,0x06,0x00,0xff,0x09,0x20,0x95,0x01,0x81,0x02,0x0a,0x21,
    0x26,0x95,0x08,0x91,0x02,0xc0
};

static const uint8_t keyboard_report_descriptor[] = {
    0x05,0x01,0x09,0x06,0xa1,0x01,0x75,0x01,0x95,0x08,0x05,0x07,0x19,0xe0,
    0x29,0xe7,0x15,0x00,0x25,0x01,0x81,0x02,0x95,0x01,0x75,0x08,0x81,0x01,
    0x95,0x05,0x75,0x01,0x05,0x08,0x19,0x01,0x29,0x05,0x91,0x02,0x95,0x01,
    0x75,0x03,0x91,0x01,0x95,0x06,0x75,0x08,0x15,0x00,0x25,0x65,0x05,0x07,
    0x19,0x00,0x29,0x65,0x81,0x00,0xc0
};

_Static_assert(sizeof(gamepad_report_descriptor) == 86, "gamepad report length");
_Static_assert(sizeof(keyboard_report_descriptor) == 63, "keyboard report length");

static const uint8_t neutral_pad[8] = {0,0,8,128,128,128,128,0};
static const uint8_t neutral_keyboard[8] = {0};
static uint8_t pad_interface_number;
static uint8_t keyboard_interface_number;

typedef struct {
    char *text;
    size_t length;
} Line;

typedef struct {
    Line lines[MAX_PAYLOAD_LINES];
    size_t count;
    size_t characters;
    uint64_t estimated_ms;
    char *storage;
} Payload;

typedef struct {
    libusbd_ctx_t *ctx;
    uint8_t pad_iface;
    uint8_t keyboard_iface;
    uint64_t pad_endpoint;
    uint64_t keyboard_endpoint;
    uint8_t pad[8];
    uint8_t keyboard[8];
    bool pad_ready;
    bool keyboard_ready;
} HID;

static void on_signal(int number) { (void)number; interrupted = 1; }

static void emit_failure(const char *message) {
    printf("MAC2JB_CIVSWITCH {\"type\":\"failed\",\"message\":\"%s\"}\n", message);
    fflush(stdout);
}

static void emit_progress(const char *type, size_t line, size_t total, size_t completed) {
    printf("MAC2JB_CIVSWITCH {\"type\":\"%s\",\"line\":%zu,\"total\":%zu,\"completed\":%zu}\n",
           type, line, total, completed);
    fflush(stdout);
}

static int number_option(const char *text, int low, int high) {
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 10);
    if (errno || end == text || *end || value < low || value > high) return -1;
    return (int)value;
}

static bool valid_controller(const char *name) {
    if (strcmp(name, "auto") == 0) return true;
    if (strncmp(name, "usb-drd", 7) != 0 || !name[7]) return false;
    if (name[7] == '0' && name[8]) return false;
    for (const char *p = name + 7; *p; p++) if (*p < '0' || *p > '9') return false;
    return number_option(name + 7, 0, 15) >= 0;
}

static bool key_for_ascii(unsigned char c, uint8_t *modifier, uint8_t *key) {
    *modifier = 0;
    if (c >= 'a' && c <= 'z') { *key = (uint8_t)(4 + c - 'a'); return true; }
    if (c >= 'A' && c <= 'Z') { *modifier = 2; *key = (uint8_t)(4 + c - 'A'); return true; }
    if (c >= '1' && c <= '9') { *key = (uint8_t)(30 + c - '1'); return true; }
    if (c == '0') { *key = 39; return true; }
    if (c == ' ') { *key = 44; return true; }
    if (c == '\t') { *key = 43; return true; }
    const char *plain = "-=[]\\;',./`";
    const char *shifted = "_+{}|:\"<>?~";
    const uint8_t punct_keys[] = {45,46,47,48,49,51,52,54,55,56,53};
    for (size_t i = 0; i < sizeof(punct_keys); i++) {
        if (c == (unsigned char)plain[i] || c == (unsigned char)shifted[i]) {
            *modifier = c == (unsigned char)shifted[i] ? 2 : 0;
            *key = punct_keys[i];
            return true;
        }
    }
    const char *shift_digits = "!@#$%^&*()";
    for (int i = 0; i < 10; i++) {
        if (c == (unsigned char)shift_digits[i]) {
            *modifier = 2;
            *key = (uint8_t)(i == 9 ? 39 : 30 + i);
            return true;
        }
    }
    return false;
}

static bool load_payload(const char *path, Payload *payload) {
    struct stat info;
    if (stat(path, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
        info.st_size > MAX_PAYLOAD_BYTES) return false;
    FILE *file = fopen(path, "rb");
    if (!file) return false;
    size_t bytes = (size_t)info.st_size;
    char *data = malloc(bytes + 1);
    if (!data) { fclose(file); return false; }
    bool okay = fread(data, 1, bytes, file) == bytes && fgetc(file) == EOF;
    fclose(file);
    if (!okay) { free(data); return false; }
    data[bytes] = 0;
    payload->storage = data;
    size_t start = 0;
    for (size_t index = 0; index <= bytes; index++) {
        if (index < bytes && data[index] != '\n') continue;
        size_t end = index;
        if (end > start && data[end - 1] == '\r') end--;
        if (end == start && index == bytes && start == bytes) break;
        if (end == start || end - start > MAX_LINE_BYTES || payload->count == MAX_PAYLOAD_LINES) return false;
        for (size_t j = start; j < end; j++) {
            uint8_t modifier, key;
            if (!key_for_ascii((unsigned char)data[j], &modifier, &key)) return false;
        }
        data[end] = 0;
        payload->lines[payload->count++] = (Line){data + start, end - start};
        payload->characters += end - start;
        start = index + 1;
    }
    if (!payload->count) return false;
    payload->estimated_ms = PREAMBLE_A_COUNT * (A_PRESS_MS + PREAMBLE_GAP_MS);
    for (size_t line = 0; line < payload->count; line++) {
        const Line *row = &payload->lines[line];
        payload->estimated_ms += KEY_HOLD_MS + ESC_TO_A_WAIT_MS + A_PRESS_MS + POST_A_WAIT_MS +
                                 row->length * KEY_HOLD_MS + 2 * ENTER_HOLD_MS + ENTER_GAP_MS;
        uint8_t previous = 0;
        for (size_t j = 0; j < row->length; j++) {
            uint8_t modifier, key;
            key_for_ascii((unsigned char)row->text[j], &modifier, &key);
            if (j && key == previous) payload->estimated_ms += KEY_GAP_MS;
            previous = key;
        }
        if (line + 1 < payload->count)
            payload->estimated_ms += PRE_A_WAIT_MS + A_PRESS_MS + POST_A_WAIT_MS;
    }
    return true;
}

static void pause_ms(unsigned milliseconds) {
    struct timespec remaining = {milliseconds / 1000, (long)(milliseconds % 1000) * 1000000L};
    while (!interrupted && nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {}
}

static bool send_report(libusbd_ctx_t *ctx, uint8_t iface, uint64_t endpoint,
                        const uint8_t report[8]) {
    for (int attempt = 0; attempt < 2 && !interrupted; attempt++) {
        int32_t result = libusbd_ep_write(ctx, iface, endpoint, report, 8, 250);
        if (result == 8) return true;
        if (result != LIBUSBD_TIMEOUT) break;
    }
    return false;
}

static bool set_state(HID *hid, const uint8_t pad[8], const uint8_t keyboard[8]) {
    if (memcmp(hid->pad, pad, 8) != 0) {
        if (!send_report(hid->ctx, hid->pad_iface, hid->pad_endpoint, pad)) return false;
        memcpy(hid->pad, pad, 8);
    }
    if (memcmp(hid->keyboard, keyboard, 8) != 0) {
        if (!send_report(hid->ctx, hid->keyboard_iface, hid->keyboard_endpoint, keyboard)) return false;
        memcpy(hid->keyboard, keyboard, 8);
    }
    return !interrupted;
}

static bool neutral(HID *hid) { return set_state(hid, neutral_pad, neutral_keyboard); }

static bool step(HID *hid, const uint8_t pad[8], const uint8_t keyboard[8], unsigned duration) {
    if (interrupted || !set_state(hid, pad, keyboard)) return false;
    pause_ms(duration);
    return !interrupted;
}

static bool a_press(HID *hid) {
    uint8_t pad[8];
    memcpy(pad, neutral_pad, 8);
    pad[0] = 4;
    return step(hid, pad, neutral_keyboard, A_PRESS_MS);
}

static bool key_press(HID *hid, uint8_t modifier, uint8_t key, unsigned duration) {
    uint8_t keyboard[8] = {modifier,0,key,0,0,0,0,0};
    return step(hid, neutral_pad, keyboard, duration);
}

static bool wait_neutral(HID *hid, unsigned duration) {
    if (!neutral(hid)) return false;
    pause_ms(duration);
    return !interrupted;
}

static void release_all(HID *hid) {
    if (!hid->ctx) return;
    if (hid->keyboard_ready) {
        for (int i = 0; i < 3; i++)
            if (libusbd_ep_write(hid->ctx, hid->keyboard_iface, hid->keyboard_endpoint,
                                neutral_keyboard, 8, 250) == 8) break;
    }
    if (hid->pad_ready) {
        for (int i = 0; i < 3; i++)
            if (libusbd_ep_write(hid->ctx, hid->pad_iface, hid->pad_endpoint,
                                neutral_pad, 8, 250) == 8) break;
    }
}

static int hid_request(libusbd_setup_callback_info_t *request) {
    if (request->bmRequestType != 0xa1 || !request->out_data) return 0;
    const uint8_t *response = NULL;
    size_t length = 0;
    uint8_t zero = 0;
    if (request->bRequest == 1) {
        if (request->wIndex == pad_interface_number) {
            response = neutral_pad;
            length = sizeof(neutral_pad);
        } else if (request->wIndex == keyboard_interface_number) {
            response = neutral_keyboard;
            length = sizeof(neutral_keyboard);
        }
    } else if (request->bRequest == 2 || request->bRequest == 3) {
        response = &zero;
        length = 1;
    }
    if (response) {
        if (length > request->wLength) length = request->wLength;
        memcpy(request->out_data, response, length);
        request->out_len = length;
    }
    return 0;
}

static bool configure_interface(libusbd_ctx_t *ctx, uint8_t iface, bool keyboard, uint64_t *endpoint) {
    const uint8_t *report = keyboard ? keyboard_report_descriptor : gamepad_report_descriptor;
    size_t length = keyboard ? sizeof(keyboard_report_descriptor) : sizeof(gamepad_report_descriptor);
    uint8_t hid_descriptor[] = {9,0x21,0x11,0x01,0,1,0x22,(uint8_t)length,0};
    if (libusbd_iface_set_class_cmd_callback(ctx, iface, hid_request) != 0 ||
        libusbd_iface_set_class(ctx, iface, 3) != 0 ||
        libusbd_iface_set_subclass(ctx, iface, keyboard ? 1 : 0) != 0 ||
        libusbd_iface_set_protocol(ctx, iface, keyboard ? 1 : 0) != 0 ||
        libusbd_iface_standard_desc(ctx, iface, 0x21, 0x0f, hid_descriptor, sizeof(hid_descriptor)) != 0 ||
        libusbd_iface_nonstandard_desc(ctx, iface, 0x22, 0x0f, report, length) != 0) return false;
    if (!keyboard && libusbd_iface_add_endpoint(ctx, iface, USB_EPATTR_TTYPE_INTR,
        USB_EP_DIR_OUT, 64, 1, 0, NULL) != 0) return false;
    if (libusbd_iface_add_endpoint(ctx, iface, USB_EPATTR_TTYPE_INTR, USB_EP_DIR_IN,
        keyboard ? 8 : 64, 1, 0, endpoint) != 0) return false;
    if (keyboard && libusbd_iface_add_endpoint(ctx, iface, USB_EPATTR_TTYPE_INTR,
        USB_EP_DIR_OUT, 8, 1, 0, NULL) != 0) return false;
    return libusbd_iface_finalize(ctx, iface) == 0;
}

static bool open_hid(HID *hid, int enumeration_seconds) {
    memcpy(hid->pad, neutral_pad, 8);
    memcpy(hid->keyboard, neutral_keyboard, 8);
    if (libusbd_init(&hid->ctx) != 0 || !hid->ctx) return false;
    if (libusbd_set_vid(hid->ctx, 0x0f0d) != 0 ||
        libusbd_set_pid(hid->ctx, 0x0092) != 0 ||
        libusbd_set_version(hid->ctx, 0x0100) != 0 ||
        libusbd_set_class(hid->ctx, 0) != 0 ||
        libusbd_set_subclass(hid->ctx, 0) != 0 ||
        libusbd_set_protocol(hid->ctx, 0) != 0 ||
        libusbd_set_manufacturer_str(hid->ctx, "PICO SWITCH PRO.") != 0 ||
        libusbd_set_product_str(hid->ctx, "J24 CONTROLLER") != 0 ||
        libusbd_set_serial_str(hid->ctx, "MAC2JBCIVSWITCH") != 0 ||
        libusbd_iface_alloc(hid->ctx, &hid->pad_iface) != 0 ||
        libusbd_iface_alloc(hid->ctx, &hid->keyboard_iface) != 0) return false;
    pad_interface_number = hid->pad_iface;
    keyboard_interface_number = hid->keyboard_iface;
    if (libusbd_config_finalize(hid->ctx) != 0 ||
        !configure_interface(hid->ctx, hid->pad_iface, false, &hid->pad_endpoint) ||
        !configure_interface(hid->ctx, hid->keyboard_iface, true, &hid->keyboard_endpoint)) return false;
    double deadline;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    deadline = (double)now.tv_sec + (double)now.tv_nsec / 1e9 + enumeration_seconds;
    while (!interrupted) {
        clock_gettime(CLOCK_MONOTONIC, &now);
        if ((double)now.tv_sec + (double)now.tv_nsec / 1e9 >= deadline) break;
        if (!hid->pad_ready) {
            int32_t result = libusbd_ep_write(hid->ctx, hid->pad_iface, hid->pad_endpoint, neutral_pad, 8, 250);
            if (result == 8) hid->pad_ready = true;
            else if (result != LIBUSBD_NOT_ENUMERATED && result != LIBUSBD_TIMEOUT) break;
        }
        if (!hid->keyboard_ready) {
            int32_t result = libusbd_ep_write(hid->ctx, hid->keyboard_iface, hid->keyboard_endpoint,
                                             neutral_keyboard, 8, 250);
            if (result == 8) hid->keyboard_ready = true;
            else if (result != LIBUSBD_NOT_ENUMERATED && result != LIBUSBD_TIMEOUT) break;
        }
        if (hid->pad_ready && hid->keyboard_ready) return true;
        pause_ms(100);
    }
    return false;
}

static bool type_line(HID *hid, const Line *line) {
    if (!key_press(hid, 0, 41, KEY_HOLD_MS) || !wait_neutral(hid, ESC_TO_A_WAIT_MS) ||
        !a_press(hid) || !wait_neutral(hid, POST_A_WAIT_MS)) return false;
    uint8_t previous = 0;
    for (size_t j = 0; j < line->length; j++) {
        uint8_t modifier, key;
        if (!key_for_ascii((unsigned char)line->text[j], &modifier, &key)) return false;
        if (j && key == previous && !wait_neutral(hid, KEY_GAP_MS)) return false;
        if (!key_press(hid, modifier, key, KEY_HOLD_MS)) return false;
        previous = key;
    }
    if (!key_press(hid, 0, 40, ENTER_HOLD_MS) || !wait_neutral(hid, ENTER_GAP_MS) ||
        !key_press(hid, 0, 40, ENTER_HOLD_MS)) return false;
    return true;
}

static bool type_payload(HID *hid, const Payload *payload) {
    for (int i = 0; i < PREAMBLE_A_COUNT; i++)
        if (!a_press(hid) || !wait_neutral(hid, PREAMBLE_GAP_MS)) return false;
    for (size_t i = 0; i < payload->count; i++) {
        emit_progress("line-start", i + 1, payload->count, i);
        if (!type_line(hid, &payload->lines[i])) return false;
        emit_progress("line-complete", i + 1, payload->count, i + 1);
        if (i + 1 < payload->count &&
            (!wait_neutral(hid, PRE_A_WAIT_MS) || !a_press(hid) ||
             !wait_neutral(hid, POST_A_WAIT_MS))) return false;
    }
    return neutral(hid);
}

static void auto_ready(void) {
    const char *value = getenv("MAC2JB_READY_FD");
    if (!value) return;
    int fd = number_option(value, 0, 1048576);
    if (fd >= 0) { (void)write(fd, "Y", 1); close(fd); }
}

static void stop_worker(pid_t child) {
    kill(child, SIGTERM);
    int status = 0;
    for (int attempt = 0; attempt < 10; attempt++) {
        pid_t finished = waitpid(child, &status, WNOHANG);
        if (finished == child || (finished < 0 && errno == ECHILD)) return;
        struct timespec delay = {0, 100000000L};
        nanosleep(&delay, NULL);
    }
    kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
}

static int try_auto(char **argv, int enumeration_seconds) {
    const char *choices[] = {"usb-drd0", "usb-drd1", "usb-drd2", "usb-drd3"};
    for (size_t i = 0; i < sizeof(choices) / sizeof(choices[0]) && !interrupted; i++) {
        int fds[2];
        if (pipe(fds) != 0) break;
        pid_t child = fork();
        if (child == 0) {
            close(fds[0]);
            char descriptor[24];
            snprintf(descriptor, sizeof(descriptor), "%d", fds[1]);
            setenv("MAC2JB_CIVSWITCH_AUTO_WORKER", "1", 1);
            setenv("MAC2JB_CONTROLLER", choices[i], 1);
            setenv("MAC2JB_READY_FD", descriptor, 1);
            execvp(argv[0], argv);
            _exit(127);
        }
        close(fds[1]);
        if (child < 0) { close(fds[0]); break; }
        struct pollfd request = {.fd = fds[0], .events = POLLIN | POLLHUP};
        int state = poll(&request, 1, (enumeration_seconds + 2) * 1000);
        char ready = 0;
        ssize_t count = state > 0 ? read(fds[0], &ready, 1) : -1;
        close(fds[0]);
        if (interrupted) {
            stop_worker(child);
            puts("MAC2JB_CIVSWITCH {\"type\":\"cancelled\"}");
            fflush(stdout);
            return 130;
        }
        if (count == 1 && ready == 'Y') {
            int status = 0;
            while (!interrupted) {
                pid_t finished = waitpid(child, &status, WNOHANG);
                if (finished == child) return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
                if (finished < 0 && errno != EINTR) return 1;
                struct timespec delay = {0, 100000000L};
                nanosleep(&delay, NULL);
            }
            stop_worker(child);
            puts("MAC2JB_CIVSWITCH {\"type\":\"cancelled\"}");
            fflush(stdout);
            return 130;
        }
        stop_worker(child);
    }
    if (interrupted) {
        puts("MAC2JB_CIVSWITCH {\"type\":\"cancelled\"}");
        fflush(stdout);
        return 130;
    }
    emit_failure("No USB controller enumerated both gamepad and keyboard interfaces");
    return 1;
}

static void usage(void) {
    fputs("usage: mac2jb-civswitch-hid --payload FILE [--controller auto|usb-drdN] [--enumeration-timeout-seconds N] [--dry-run]\n", stderr);
}

int main(int argc, char **argv) {
    const char *path = NULL;
    const char *controller = getenv("MAC2JB_CONTROLLER");
    const char *timeout_text = getenv("MAC2JB_ENUMERATION_TIMEOUT_SECONDS");
    int enumeration_seconds = timeout_text && *timeout_text ? number_option(timeout_text, 1, 120) : 4;
    bool dry_run = false;
    for (int index = 1; index < argc; index++) {
        if (strcmp(argv[index], "--payload") == 0 && index + 1 < argc) path = argv[++index];
        else if (strcmp(argv[index], "--controller") == 0 && index + 1 < argc) controller = argv[++index];
        else if (strcmp(argv[index], "--enumeration-timeout-seconds") == 0 && index + 1 < argc)
            enumeration_seconds = number_option(argv[++index], 1, 120);
        else if (strcmp(argv[index], "--dry-run") == 0) dry_run = true;
        else if (strcmp(argv[index], "--help") == 0 && argc == 2) { usage(); return 0; }
        else { usage(); return 2; }
    }
    if (!path || enumeration_seconds < 0) { usage(); return 2; }
    if (!controller || !*controller) controller = "auto";
    if (!valid_controller(controller)) { usage(); return 2; }
    Payload payload = {0};
    if (!load_payload(path, &payload)) {
        emit_failure("CivSwitch chat payload is invalid or unreadable");
        free(payload.storage);
        return 2;
    }
    if (dry_run) {
        printf("MAC2JB_CIVSWITCH {\"type\":\"dry-run\",\"total\":%zu,\"characters\":%zu,\"estimatedMs\":%llu}\n",
               payload.count, payload.characters, (unsigned long long)payload.estimated_ms);
        free(payload.storage);
        return 0;
    }
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    signal(SIGPIPE, SIG_IGN);
    if (strcmp(controller, "auto") == 0 && !getenv("MAC2JB_CIVSWITCH_AUTO_WORKER")) {
        free(payload.storage);
        return try_auto(argv, enumeration_seconds);
    }
    if (getenv("MAC2JB_CIVSWITCH_AUTO_WORKER")) controller = getenv("MAC2JB_CONTROLLER");
    setenv("MAC2JB_CONTROLLER", controller, 1);
    HID hid = {0};
    bool ready = open_hid(&hid, enumeration_seconds);
    if (!ready) {
        if (interrupted) {
            puts("MAC2JB_CIVSWITCH {\"type\":\"cancelled\"}");
            fflush(stdout);
        } else if (!getenv("MAC2JB_CIVSWITCH_AUTO_WORKER"))
            emit_failure("USB gamepad and keyboard enumeration failed");
        release_all(&hid);
        if (hid.ctx) libusbd_free(hid.ctx);
        free(payload.storage);
        return interrupted ? 130 : 1;
    }
    auto_ready();
    printf("MAC2JB_CIVSWITCH {\"type\":\"ready\",\"controller\":\"%s\",\"total\":%zu}\n",
           controller, payload.count);
    fflush(stdout);
    bool finished = type_payload(&hid, &payload);
    release_all(&hid);
    libusbd_free(hid.ctx);
    if (finished && !interrupted) {
        printf("MAC2JB_CIVSWITCH {\"type\":\"complete\",\"total\":%zu,\"completed\":%zu}\n",
               payload.count, payload.count);
        fflush(stdout);
    } else if (interrupted) {
        puts("MAC2JB_CIVSWITCH {\"type\":\"cancelled\"}");
        fflush(stdout);
    } else {
        emit_failure("CivSwitch USB macro stopped before all lines were sent");
    }
    free(payload.storage);
    return finished && !interrupted ? 0 : interrupted ? 130 : 1;
}
