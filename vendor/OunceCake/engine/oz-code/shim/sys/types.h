/**
 * @file types.h
 * @brief Freestanding stand-in for <sys/types.h>: picohttpparser.h only needs ssize_t.
 */
#ifndef OUNCECAKE_SHIM_SYS_TYPES_H
#define OUNCECAKE_SHIM_SYS_TYPES_H
#include <stddef.h>
typedef __PTRDIFF_TYPE__ ssize_t;
#endif
