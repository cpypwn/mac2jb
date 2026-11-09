/* Host-side NSO decompression; never loaded on the console. */
#define ZSTD_ZBIC_SUPPORT 1
#include "vendor/zstd/zstd.inc"
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv){
 if(argc!=3)return 2;
 char *end;unsigned long long out_size=strtoull(argv[1],&end,10);if(*end||out_size>512ull*1024*1024)return 2;
 unsigned long long in_size=strtoull(argv[2],&end,10);if(*end||in_size>512ull*1024*1024)return 2;
 void *in=malloc(in_size?in_size:1),*out=malloc(out_size?out_size:1);if(!in||!out)return 2;
 if(fread(in,1,in_size,stdin)!=in_size)return 2;
 size_t n=ZSTD_decompress(out,out_size,in,in_size);
 if(ZSTD_isError(n)||n!=out_size){fprintf(stderr,"ZBIC decompression failed: %s\n",ZSTD_getErrorName(n));return 2;}
 int ok=fwrite(out,1,n,stdout)==n;free(in);free(out);return ok?0:2;
}
