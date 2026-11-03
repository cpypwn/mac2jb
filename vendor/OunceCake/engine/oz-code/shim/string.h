/**
 * @file string.h
 * @brief Freestanding stand-in for the <string.h> subset vendor/picohttpparser includes.
 *
 * aarch64-none-elf has no libc headers; these functions are implemented in native.c.
 */
#ifndef OUNCECAKE_SHIM_STRING_H
#define OUNCECAKE_SHIM_STRING_H
#include <stddef.h>
void* memcpy(void* destination, const void* source, size_t bytes);
void* memmove(void* destination, const void* source, size_t bytes);
void* memset(void* destination, int value, size_t bytes);
#endif
