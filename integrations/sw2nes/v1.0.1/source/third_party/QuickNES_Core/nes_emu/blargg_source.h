/* Included at the beginning of library source files, AFTER all other #include
lines. Sets up helpful macros and services used in my source code. Since this
is only "active" in my source code, I don't have to worry about polluting the
global namespace with unprefixed names. */

// File_Extractor 1.0.0
#ifndef BLARGG_SOURCE_H
#define BLARGG_SOURCE_H

#ifndef BLARGG_COMMON_H // optimization only
	#include "blargg_common.h"
#endif

#include <string.h> /* memcpy(), memset(), memmove() */
#include <stddef.h> /* offsetof() */

/* If expr yields non-NULL error string, returns it from current function,
otherwise continues normally. */
#undef  RETURN_ERR
#define RETURN_ERR( expr ) \
	do {\
		const char *blargg_return_err_ = (expr);\
		if ( blargg_return_err_ )\
			return blargg_return_err_;\
	} while ( 0 )

/* If ptr is NULL, returns out-of-memory error, otherwise continues normally. */
#undef  CHECK_ALLOC
#define CHECK_ALLOC( ptr ) \
	do {\
		if ( !(ptr) )\
			return "Out of memory";\
	} while ( 0 )

/* The usual min/max functions for built-in types. */

template<typename T> T min( T x, T y ) { return x < y ? x : y; }
template<typename T> T max( T x, T y ) { return x > y ? x : y; }

#endif
