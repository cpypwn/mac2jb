#include "doomgeneric.h"
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

#define FRAME_BYTES (DOOMGENERIC_RESX * DOOMGENERIC_RESY * 2)
#define KEY_QUEUE 128

static unsigned char input_buffer[4096];
static size_t input_length;
static unsigned char keys[KEY_QUEUE][2];
static unsigned int key_read, key_write;
static int frame_requested;

static void poll_input(void) {
    unsigned char chunk[512];
    for (;;) {
        ssize_t size = read(STDIN_FILENO, chunk, sizeof(chunk));
        if (size == 0) exit(0);
        if (size < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            if (errno == EINTR) continue;
            exit(1);
        }
        if (input_length + (size_t)size > sizeof(input_buffer)) exit(1);
        for (ssize_t index = 0; index < size; index++) input_buffer[input_length++] = chunk[index];
    }
    size_t offset = 0;
    while (input_length - offset >= 3) {
        unsigned char type = input_buffer[offset], key = input_buffer[offset + 1], pressed = input_buffer[offset + 2];
        if (type == 1 && pressed <= 1) {
            unsigned int next = (key_write + 1) % KEY_QUEUE;
            if (next != key_read) {
                keys[key_write][0] = key;
                keys[key_write][1] = pressed;
                key_write = next;
            }
        } else if (type == 2) frame_requested = 1;
        else exit(1);
        offset += 3;
    }
    if (offset) {
        input_length -= offset;
        for (size_t index = 0; index < input_length; index++) input_buffer[index] = input_buffer[offset + index];
    }
}

void DG_Init(void) {
    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) exit(1);
}

void DG_DrawFrame(void) {
    poll_input();
    if (!frame_requested) return;
    frame_requested = 0;
    const unsigned char *bytes = (const unsigned char *)DG_ScreenBuffer;
    size_t offset = 0;
    while (offset < FRAME_BYTES) {
        ssize_t size = write(3, bytes + offset, FRAME_BYTES - offset);
        if (size < 0 && errno == EINTR) continue;
        if (size <= 0) exit(1);
        offset += (size_t)size;
    }
}

void DG_SleepMs(uint32_t milliseconds) {
    struct timespec delay = { milliseconds / 1000, (milliseconds % 1000) * 1000000L };
    while (nanosleep(&delay, &delay) < 0 && errno == EINTR) {}
}

uint32_t DG_GetTicksMs(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint32_t)(now.tv_sec * 1000 + now.tv_nsec / 1000000);
}

int DG_GetKey(int *pressed, unsigned char *key) {
    poll_input();
    if (key_read == key_write) return 0;
    *key = keys[key_read][0];
    *pressed = keys[key_read][1];
    key_read = (key_read + 1) % KEY_QUEUE;
    return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

int main(int argc, char **argv) {
    doomgeneric_Create(argc, argv);
    for (;;) doomgeneric_Tick();
}
