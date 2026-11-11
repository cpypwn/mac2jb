/* ZBIC uses the bundled decoder's normal streaming API. Only its current
 * window and input block are retained, never a second complete executable. */
#define __EMSCRIPTEN__ 1
#define ZSTD_ZBIC_SUPPORT 1
#define NDEBUG 1
#include "vendor/zstd/zstd.inc"
#include <stdint.h>
struct lfs_zbic {
 ZSTD_DStream *stream;
 uint64_t cursor,position;
 size_t begin,end;
 uint32_t error,finished;
 uint8_t input[0x10000],discard[0x10000];
};
void lfs_zbic_release(void *memory){
 struct lfs_zbic *s=memory;if(s){ZSTD_freeDStream(s->stream);free(s);}
}
void *lfs_zbic_create(void){
 struct lfs_zbic *s=calloc(1,sizeof(*s));if(!s)return 0;
 s->stream=ZSTD_createDStream();
 if(!s->stream||ZSTD_isError(ZSTD_initDStream(s->stream))){lfs_zbic_release(s);return 0;}return s;
}
uint32_t lfs_zbic_read(void *memory,void *file,uint32_t (*read)(void *,uint64_t,void *,uint64_t),uint64_t offset,uint64_t packed,uint64_t size,uint64_t at,void *data,uint64_t length){
 struct lfs_zbic *s=memory;
 if(!s||s->error||at<s->position||at>size||length>size-at)return s&&s->error?s->error:0xd401;
 uint64_t end=at+length;
 while(s->position<end){
  if(s->finished)return s->error=0xd401;
  if(s->begin==s->end&&s->cursor<packed){
   uint64_t n=packed-s->cursor;if(n>sizeof(s->input))n=sizeof(s->input);
   uint32_t result=read(file,offset+s->cursor,s->input,n);if(result)return s->error=result;
   s->begin=0;s->end=(size_t)n;s->cursor+=n;
  }
  uint64_t n=s->position<at?at-s->position:end-s->position;
  void *out=s->position<at?s->discard:(uint8_t *)data+s->position-at;
  if(s->position<at&&n>sizeof(s->discard))n=sizeof(s->discard);
  ZSTD_inBuffer input={s->input,s->end,s->begin};ZSTD_outBuffer output={out,(size_t)n,0};
  size_t result=ZSTD_decompressStream(s->stream,&output,&input);
  if(ZSTD_isError(result)||(!output.pos&&input.pos==s->begin))return s->error=0xd401;
  s->begin=input.pos;s->position+=output.pos;
  if(!result){s->finished=1;if(s->position!=size)return s->error=0xd401;}
 }
 return 0;
}
