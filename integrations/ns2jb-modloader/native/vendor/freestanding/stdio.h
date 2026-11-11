#ifndef LFS_STDIO_H
#define LFS_STDIO_H
#include <stddef.h>
typedef struct lfs_unused_file FILE;
extern FILE *stderr;
int printf(const char *,...);
int fprintf(FILE *,const char *,...);
int snprintf(char *,size_t,const char *,...);
int fflush(FILE *);
#endif
