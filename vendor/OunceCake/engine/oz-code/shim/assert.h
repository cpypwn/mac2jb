/**
 * @file assert.h
 * @brief Freestanding stand-in for <assert.h>: there is nothing to abort to on the console.
 *
 * picohttpparser only asserts inside phr_decode_chunked, which this server never calls.
 */
#ifndef OUNCECAKE_SHIM_ASSERT_H
#define OUNCECAKE_SHIM_ASSERT_H
#define assert(condition) ((void) 0)
#endif
