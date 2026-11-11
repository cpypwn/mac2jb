#include "lazy.h"
void *memcpy(void *to,const void *from,size_t size){lfs_copy(to,from,size);return to;}
void *memmove(void *to,const void *from,size_t size){
 uint8_t *d=to;const uint8_t *s=from;
 if((uintptr_t)d<=(uintptr_t)s)lfs_copy(to,from,size);else for(size_t i=size;i;i--)d[i-1]=s[i-1];return to;
}
void *memset(void *to,int value,size_t size){uint8_t *d=to;for(size_t i=0;i<size;i++)d[i]=(uint8_t)value;return to;}
int memcmp(const void *left,const void *right,size_t size){
 const uint8_t *a=left,*b=right;for(size_t i=0;i<size;i++)if(a[i]!=b[i])return (int)a[i]-(int)b[i];return 0;
}
void *memchr(const void *data,int value,size_t size){const uint8_t *p=data;for(size_t i=0;i<size;i++)if(p[i]==(uint8_t)value)return (void *)(p+i);return 0;}
size_t strlen(const char *text){size_t n=0;while(text[n])n++;return n;}
void *malloc(size_t size){return lfs_system_allocate(size?size:1);}
void free(void *pointer){lfs_system_free(pointer);}
void *calloc(size_t count,size_t size){if(size&&count>SIZE_MAX/size)return 0;void *p=malloc(count*size);if(p)lfs_zero(p,count*size);return p;}
