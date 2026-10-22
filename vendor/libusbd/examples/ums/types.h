#ifndef _TYPES_H_
#define _TYPES_H_

#include <inttypes.h>
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <sys/types.h>

#define U8_MIN  (0x00)
#define U8_MAX  (0xFF)
#define U16_MIN (0x0000)
#define U16_MAX (0xFFFF)
#define U32_MIN (0x00000000)
#define U32_MAX (0xFFFFFFFF)
#define U64_MIN (0x0000000000000000)
#define U64_MAX (0xFFFFFFFFFFFFFFFF)
#define S8_MIN  (0x80)
#define S8_MAX  (0x7F)
#define S16_MIN (0x8000)
#define S16_MAX (0x7FFF)
#define S32_MIN (0x80000000)
#define S32_MAX (0x7FFFFFFF)
#define S64_MIN (0x8000000000000000)
#define S64_MAX (0x7FFFFFFFFFFFFFFF)

#ifndef SSIZE_MAX
#ifdef SIZE_MAX
#define SSIZE_MAX ((SIZE_MAX) >> 1)
#endif
#endif

#define SIZE_KB (1024)
#define SIZE_MB (SIZE_KB * 1024)
#define SIZE_GB (SIZE_MB * 1024)

#define ALIGNED(x) __attribute__((aligned(x)))
#define PACKED __attribute__((packed))
#define NORETURN __attribute__((noreturn))
#define NOINLINE __attribute__((noinline))

typedef uint8_t  u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;

typedef int8_t   s8;
typedef int16_t  s16;
typedef int32_t  s32;
typedef int64_t  s64;

typedef volatile u8  vu8;
typedef volatile u16 vu16;
typedef volatile u32 vu32;
typedef volatile u64 vu64;

typedef volatile s8  vs8;
typedef volatile s16 vs16;
typedef volatile s32 vs32;
typedef volatile s64 vs64;

typedef __CHAR16_TYPE__ char16_t;

#endif // _TYPES_H_
