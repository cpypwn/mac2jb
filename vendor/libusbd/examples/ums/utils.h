#ifndef _UTILS_H_
#define _UTILS_H_

#include "types.h"

#define BIT(x) (1 << (x))

#define max(a, b) \
    ({ __typeof__ (a) _a = (a); \
       __typeof__ (b) _b = (b); \
       _a > _b ? _a : _b; })

#define min(a, b) \
    ({ __typeof__ (a) _a = (a); \
       __typeof__ (b) _b = (b); \
       _a < _b ? _a : _b; })

#define clamp(x, low, high) \
    ({ __typeof__(x) __x = (x); \
       __typeof__(low) __low = (low); \
       __typeof__(high) __high = (high); \
       __x > __high ? __high : (__x < __low ? __low : __x); })

u64 getle64(const u8* p);
u64 getle48(const u8* p);
u32 getle32(const u8* p);
u32 getle16(const u8* p);
u64 getbe64(const u8* p);
u64 getbe48(const u8* p);
u32 getbe32(const u8* p);
u32 getbe16(const u8* p);
void putle16(u8* p, u16 n);
void putle24(u8* p, u32 n);
void putle32(u8* p, u32 n);
void putle48(u8* p, u64 n);
void putle64(u8* p, u64 n);
void putbe16(u8* p, u16 n);
void putbe24(u8* p, u32 n);
void putbe32(u8* p, u32 n);
void putbe48(u8* p, u64 n);
void putbe64(u8* p, u64 n);

#endif // _UTILS_H_
