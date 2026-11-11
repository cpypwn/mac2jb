#include "namespace.h"

struct probe_sample {
 uint64_t offset,length,source_offset,file_size;
 const char *name,*path;
 const uint8_t *expected;
};
struct probe {
 void *object,*source_fs;
 uint32_t (*storage_read)(void *,int64_t,const struct ns_buffer *,int64_t);
 ns_open_fn open;
 ns_read_fn read;
 ns_size_fn size;
 ns_ref_fn release;
 ns_type_fn type;
 const struct probe_sample *samples;
 uint64_t count,completed,failed;
 uint32_t result,reserved;
};
_Static_assert(sizeof(struct probe_sample)==56,"Probe sample ABI");
_Static_assert(sizeof(struct probe)==104,"Probe ABI");

// Compare small routing samples locally. No mod bodies or per-sample IPC
// replies travel through SmileBASIC's transport.
uint64_t lfs_verify_samples(struct probe *p){
 if(!p||!p->object||!p->source_fs||p->completed||p->result)return 0xd401;
 uint8_t actual[768],expected[768];
 for(uint64_t i=0;i<p->count;i++){
  const struct probe_sample *s=&p->samples[i];
  void *file=0,*source=0;uint32_t result=0;uint64_t count=0;
  struct ns_out out={&file};struct ns_buffer buffer={actual,sizeof(actual)};
  p->failed=i;
  if(s->length>sizeof(actual)||s->offset>INT64_MAX||s->source_offset>INT64_MAX||(!s->expected&&!s->path)){result=0xd401;goto done;}
  if(s->name){
   uint32_t type=0;uint64_t size=0;
   result=p->type(p->object,&type,s->name);if(result)goto done;
   if(type!=1){result=0xd401;goto done;}
   result=p->open(p->object,&out,s->name,1);if(result)goto done;
   if(!file){result=0xd401;goto done;}
   result=p->size(file,&size);if(result)goto done;
   if(size!=s->file_size||s->offset>size||s->length>size-s->offset){result=0xd401;goto done;}
   if(s->length){result=p->read(file,&count,s->offset,&buffer,s->length,0);if(!result&&count!=s->length)result=0xd401;}
  }else if(s->length)result=p->storage_read(p->object,s->offset,&buffer,s->length);
  if(result)goto done;
  if(s->length){
   const uint8_t *bytes=s->expected;
   if(!bytes){
    out.value=&source;result=p->open(p->source_fs,&out,s->path,1);if(result)goto done;
    if(!source){result=0xd401;goto done;}
    buffer.data=expected;count=0;result=p->read(source,&count,s->source_offset,&buffer,s->length,0);
    if(!result&&count!=s->length)result=0xd401;
    if(result)goto done;
    bytes=expected;
   }
   if(!lfs_equal(actual,bytes,s->length))result=0xd401;
  }
 done:
  if(source)p->release(source);
  if(file)p->release(file);
  if(result){p->result=result;return result;}
  p->completed++;
 }
 return 0;
}
