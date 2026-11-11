#include "namespace.h"
#include "lazy.h"
#include "trace.h"
static void add(uint64_t *p,int64_t n){ __atomic_fetch_add(p,n,__ATOMIC_RELAXED); }
int lfs_equal(const void *left,const void *right,uint64_t n){
 const uint8_t *a=left,*b=right;
 for(uint64_t i=0;i<n;i++)if(a[i]!=b[i])return 0;
 return 1;
}
void lfs_zero(void *data,uint64_t n){
 uint8_t *p=data;
 while(n&&((uintptr_t)p&7)){*p++=0;n--;}
 while(n>=8){*(uint64_t *)p=0;p+=8;n-=8;}
 while(n--)*p++=0;
}
struct lfs_life *lfs_lookup(void *object,uint32_t kind){
 for(struct lfs_life *n=__atomic_load_n(&lfs_context()->objects,__ATOMIC_ACQUIRE);n;n=__atomic_load_n(&n->next,__ATOMIC_ACQUIRE))
  if(__atomic_load_n(&n->active,__ATOMIC_ACQUIRE)==1&&__atomic_load_n(&n->object,__ATOMIC_RELAXED)==object&&(!kind||__atomic_load_n(&n->kind,__ATOMIC_RELAXED)==kind))return n;
 return 0;
}
/* Contended FS work must sleep through the SDK arbiter: a CPU YIELD hint
 * does not let a preempted lower-priority owner run. The existing qualified
 * mutex helpers preserve Horizon priority inheritance and waiter handoff. */
void lfs_mutex_lock(uint32_t *mutex){
#if defined(__aarch64__)
 uintptr_t tls;__asm__ volatile("mrs %0, tpidrro_el0":"=r"(tls));
 uint32_t tag=*(const uint32_t *)(tls+0x110),expected=0;
 if(!__atomic_compare_exchange_n(mutex,&expected,tag,0,__ATOMIC_ACQUIRE,__ATOMIC_RELAXED)){
  uintptr_t base=(uintptr_t)lfs_context()->original_read-0x1077b0;
  ((void (*)(uint32_t *,uint32_t,uint32_t))(base+0x2187d0))(mutex,expected,tag);
 }
#else
 while(__atomic_exchange_n(mutex,1,__ATOMIC_ACQUIRE))lfs_pause();
#endif
}
void lfs_mutex_unlock(uint32_t *mutex){
#if defined(__aarch64__)
 uintptr_t tls;__asm__ volatile("mrs %0, tpidrro_el0":"=r"(tls));
 uint32_t tag=*(const uint32_t *)(tls+0x110),expected=tag;
 if(!__atomic_compare_exchange_n(mutex,&expected,0,0,__ATOMIC_RELEASE,__ATOMIC_RELAXED)){
  uintptr_t base=(uintptr_t)lfs_context()->original_read-0x1077b0;
  ((void (*)(uint32_t *,uint32_t,uint32_t))(base+0x218870))(mutex,expected,tag);
 }
#else
 __atomic_store_n(mutex,0,__ATOMIC_RELEASE);
#endif
}
/* A retained reference keeps the SDK object alive during its normal reference
 * decrement. Final destruction and every owner/log cleanup run after unlock. */
void lfs_release(void *object,ns_ref_fn original){
 struct lfs_life *n=lfs_lookup(object,0);
 if(!n){original(object);return;}
 uint64_t trace=lfs_trace_begin(LFS_T_OBJECT_RELEASE,object,0,n->kind,0);
 uint64_t wait=lfs_trace_begin(LFS_T_OBJECT_LOCK,&n->release_mutex,0,n->kind,(uintptr_t)object);
 lfs_mutex_lock(&n->release_mutex);
 lfs_trace_end(wait,0,0,0,0);
 uint64_t held=lfs_trace_begin(LFS_T_OBJECT_LOCK_HELD,&n->release_mutex,0,n->kind,(uintptr_t)object);
 original(object);
 if(__atomic_load_n((uint32_t *)((uint8_t *)object+n->ref_offset),__ATOMIC_ACQUIRE)==1){
  uint32_t active=1;
  if(__atomic_compare_exchange_n(&n->active,&active,2,0,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)){
   struct lfs_context *c=lfs_context();
   const void *owner=n->plan_owner;void *stream=n->stream,*filesystem=n->filesystem;
   /* With only our retained reference left, there can be no other valid
    * external Release. Unlock before destruction, re-entry or owner cleanup. */
   lfs_trace_end(held,0,0,0,0);lfs_mutex_unlock(&n->release_mutex);
   original(object);
   if(stream)lfs_lazy_stream_release(stream);
   if(filesystem)lfs_filesystem_release(filesystem);
   if(owner)lfs_lazy_owner_release(owner);
   if(owner||stream)lfs_lazy_log_flush();
   if(c->log_file&&!__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)&&__atomic_load_n(&c->revision,__ATOMIC_RELAXED)!=__atomic_load_n(&c->flushed_revision,__ATOMIC_RELAXED))lfs_flush();
   __atomic_store_n(&n->active,0,__ATOMIC_RELEASE);
   lfs_trace_end(trace,0,0,0,0);return;
  }
 }
 lfs_trace_end(held,0,0,0,0);lfs_mutex_unlock(&n->release_mutex);
 lfs_trace_end(trace,0,0,0,0);
}
void lfs_file_release(void *object){lfs_release(object,lfs_context()->sdk.file_release);}
void lfs_filesystem_release(void *object){lfs_release(object,lfs_context()->sdk.filesystem_release);}
void lfs_storage_release(void *object){lfs_release(object,lfs_context()->sdk.storage_release);}
void lfs_directory_release(void *object){lfs_release(object,lfs_context()->sdk.directory_release);}
struct lfs_life *lfs_track(void *object,const void *owner,uint32_t kind){
 /* These are adapters of the qualified SDK Release functions. Probe only
  * through their reference counter: storage/directory +0x18, file +0x20,
  * filesystem +0x28. Reading 64 bytes crosses the 0x20/0x28/0x30-byte SDK
  * allocations and can also mistake an adjacent object's counter for ours. */
 unsigned words=kind==LFS_CODEFS?11:kind==LFS_SLICE?9:kind==LFS_STORAGE||kind==LFS_DIRECTORY?7:0;
 if(!words)return 0;
 struct lfs_context *c=lfs_context();
 uint64_t wait=lfs_trace_begin(LFS_T_OBJECT_LOCK,&c->lock,0,kind,0);
 lfs_mutex_lock(&c->lock);
 lfs_trace_end(wait,0,0,0,0);
 uint64_t held=lfs_trace_begin(LFS_T_OBJECT_LOCK_HELD,&c->lock,0,kind,(uintptr_t)object);
 struct lfs_life *n=lfs_lookup(object,kind);
 if(n){lfs_trace_end(held,0,0,0,0);lfs_mutex_unlock(&c->lock);return n;}
 for(n=__atomic_load_n(&c->objects,__ATOMIC_ACQUIRE);n;n=n->next)if(!__atomic_load_n(&n->active,__ATOMIC_ACQUIRE))break;
 int fresh=!n;
 if(fresh)n=c->allocate(sizeof(*n));
 if(!n){lfs_trace_end(held,0xd401,0,0,0);lfs_mutex_unlock(&c->lock);return 0;}
 if(fresh)lfs_zero(n,sizeof(*n));
 __atomic_store_n(&n->object,object,__ATOMIC_RELAXED);n->original=*(void ***)object;n->owner=owner;__atomic_store_n(&n->kind,kind,__ATOMIC_RELAXED);n->cursor=n->mode=0;
 n->plan_owner=0;n->stream=0;n->filesystem=0;n->release_mutex=0;
 uint32_t before[16],after[16],offset=0,candidates=0;
 for(unsigned i=0;i<words;i++)before[i]=__atomic_load_n((uint32_t *)object+i,__ATOMIC_RELAXED);
 uint64_t retain=lfs_trace_begin(LFS_T_OBJECT_RETAIN,object,0,kind,0);
 ((ns_ref_fn)n->original[0])(object);
 lfs_trace_end(retain,0,0,0,0);
 for(unsigned i=0;i<words;i++)after[i]=__atomic_load_n((uint32_t *)object+i,__ATOMIC_RELAXED);
 for(unsigned i=2;i<words;i++)if(before[i]&&before[i]<0x100000&&after[i]==before[i]+1){offset=i*4;candidates++;}
 if(candidates!=1){
  uint64_t drop=lfs_trace_begin(LFS_T_OBJECT_DROP,object,0,kind,0);((ns_ref_fn)n->original[1])(object);lfs_trace_end(drop,0,0,0,0);if(fresh)c->free(n,sizeof(*n));n=0;
 }else{
  n->ref_offset=offset;
  if(fresh){n->next=__atomic_load_n(&c->objects,__ATOMIC_RELAXED);__atomic_store_n(&c->objects,n,__ATOMIC_RELEASE);}
  __atomic_store_n(&n->active,1,__ATOMIC_RELEASE);
 }
 lfs_trace_end(held,0,0,0,0);lfs_mutex_unlock(&c->lock);return n;
}
uint32_t lfs_source_read(const char *path,uint64_t offset,void *data,uint64_t size){
 struct lfs_context *c=lfs_context();void *file=0;uint32_t result;
 if(!path||(uintptr_t)path==1){
  if(!path&&(offset>c->payload_size||size>c->payload_size-offset))return 0xd401;
  const uint8_t *from=(const uint8_t *)(path?(uintptr_t)offset:(uintptr_t)c->metadata+offset);uint8_t *to=data;
  for(uint64_t i=0;i<size;i++)to[i]=from[i];return 0;
 }
 if(path){
  struct ns_out out={&file};file=0;
  result=c->open_file((uint8_t *)c->source_fs+8,&out,((const struct lfs_source *)path)->path,1);
  if(result){lfs_note((struct lfs_source *)path,0,result);return result;}
  if(!file)return 0xd401;
 }
 result=lfs_source_read_file(file,(struct lfs_source *)path,offset,data,size);
 c->sdk.file_release(file);
 return result;
}
uint32_t lfs_source_read_file(void *file,struct lfs_source *source,uint64_t offset,void *data,uint64_t size){
 struct lfs_context *c=lfs_context();struct ns_buffer buffer={data,size};uint64_t read=0;
 uint64_t trace=lfs_trace_begin(LFS_T_SOURCE_READ,file,source->reserved,offset,size);
 uint32_t result=c->read(file,&read,(int64_t)offset,&buffer,(int64_t)size,0);
 add(&c->source_reads,1);
 result=result?result:(read==size?0:0xd401);
 if(!result)lfs_trace_pak(source,offset,data,read);
 lfs_trace_end(trace,result,read,data,read);
 if(!result&&read&&lfs_lazy_config()&&c->log_file&&!__atomic_exchange_n(&source->reads,1,__ATOMIC_ACQ_REL)){
  uint64_t fingerprint=UINT64_C(14695981039346656037),sample=read<64?read:64;
  for(uint64_t i=0;i<sample;i++){fingerprint^=((const uint8_t *)data)[i];fingerprint*=UINT64_C(1099511628211);}
  lfs_lazy_log("Source first read",0,read,0,source->path);
  lfs_lazy_log("Source offset",0,offset,0,source->path);
  lfs_lazy_log("Source sample FNV64",0,fingerprint,0,source->path);
 }else lfs_note(source,result?0:read,result);
 return result;
}
static void identity_mismatch(uint64_t stage){
 struct lfs_context *c=lfs_context();uint64_t empty=0;
 if(c->log_file&&!__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)&&__atomic_compare_exchange_n(&c->reserved2,&empty,stage,0,__ATOMIC_RELAXED,__ATOMIC_RELAXED)){
  __atomic_store_n(&c->identity_mismatches,1,__ATOMIC_RELAXED);__atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);
 }
}
static const struct lfs_view *identify(void *object,uint64_t size){
 struct lfs_context *c=lfs_context();uint8_t bytes[128];
 for(uint32_t i=0;i<c->count;i++){
  const struct lfs_view *v=&c->views[i];if(v->original_size!=size)continue;
  struct ns_buffer buffer={bytes,sizeof(bytes)};
  if(lfs_trace_original_read((uint8_t *)object+8,0,&buffer,80)||!lfs_equal(bytes,v->header,80)){identity_mismatch(1);continue;}
  if(lfs_trace_original_read((uint8_t *)object+8,v->entry_offset,&buffer,32)||!lfs_equal(bytes,v->entry,32)){identity_mismatch(2);continue;}
  if(lfs_trace_original_read((uint8_t *)object+8,v->prefix_offset,&buffer,v->prefix_length)||!lfs_equal(bytes,v->prefix,v->prefix_length)){identity_mismatch(3);continue;}
  lfs_track(object,v,LFS_STORAGE);return v;
 }
 if(c->log_file&&!__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)&&!__atomic_load_n(&c->unmatched_count,__ATOMIC_RELAXED)&&size>=80){
  struct ns_buffer b={bytes,sizeof(bytes)};
  if(!lfs_trace_original_read((uint8_t *)object+8,0,&b,80)&&*(uint64_t *)bytes==80){uint64_t empty=0;if(__atomic_compare_exchange_n(&c->unmatched_count,&empty,1,0,__ATOMIC_RELAXED,__ATOMIC_RELAXED)){c->unmatched_size=size;__atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);}lfs_track(object,0,LFS_STORAGE);}
 }
 return 0;
}
static uint32_t read_segment(void *object,const struct lfs_segment *s,uint64_t offset,void *data,uint64_t size){
 if((uintptr_t)s->source_path==2){struct ns_buffer b={data,size};return lfs_trace_original_read((uint8_t *)object+8,s->source_offset+offset,&b,size);}
 if((uintptr_t)s->source_path>2){struct lfs_life *life=lfs_lookup(object,LFS_STORAGE);if(life&&life->plan_owner)return lfs_lazy_source_read(life->plan_owner,(struct lfs_source *)s->source_path,s->source_offset+offset,data,size);}
 return lfs_source_read(s->source_path,s->source_offset+offset,data,size);
}
static uint32_t read_gap(void *object,const struct lfs_view *view,uint64_t offset,void *data,uint64_t size){
 uint64_t original=offset<view->original_size?view->original_size-offset:0;
 if(original>size)original=size;
 if(original){struct ns_buffer b={data,original};uint32_t result=lfs_trace_original_read((uint8_t *)object+8,offset,&b,original);if(result)return result;}
 lfs_zero((uint8_t *)data+original,size-original);return 0;
}
uint32_t lfs_size(void *object,uint64_t *size){
 struct lfs_context *c=lfs_context();add(&c->active,1);
 struct lfs_life *tracked=lfs_lookup(object,LFS_STORAGE);
 uint64_t trace=tracked&&tracked->plan_owner?lfs_trace_begin(LFS_T_STORAGE_SIZE,object,0,0,0):0;
 /* An attached RomFS view has immutable geometry and owns its backing
  * storage reference. Its size is already final: do not re-enter the base
  * storage's GetSize for every query, only to replace that result afterwards. */
 const struct lfs_view *view=c->enabled&&tracked?tracked->owner:0;
 uint32_t result;
 if(view){*size=view->size;result=0;}
 else{
  result=c->original_size(object,size);
  if(!result&&c->enabled&&!lfs_lazy_config()){
   view=tracked?tracked->owner:identify(object,*size);
   if(view)*size=view->size;
  }
 }
 lfs_trace_end(trace,result,result?0:*size,0,0);
 add(&c->active,-1);return result;
}
/* A virtual RomFS has different offsets and sources from its base storage.
 * Match fs.mitm's policy for optional storage commands: an empty range is a
 * no-op, other range operations and batched reads are unsupported. Never
 * pass virtual offsets to the base device or describe its physical ranges.
 * Ordinary/untracked storage keeps the original SDK behavior and ABI. */
#define FS_UNSUPPORTED_OPERATION ((6300u<<9)|2u)
#define FS_NULLPTR_ARGUMENT ((6063u<<9)|2u)
uint32_t lfs_storage_range(void *object,void *info,int32_t operation,int64_t offset,int64_t size){
 struct lfs_context *c=lfs_context();struct lfs_lazy_config *a=lfs_lazy_config();
 struct lfs_life *n=c->enabled?lfs_lookup(object,LFS_STORAGE):0;
 if(!n||!n->owner)return a->storage_range((uint8_t *)object+8,info,operation,offset,size);
 uint64_t trace=operation==2||operation==3?lfs_trace_begin(operation==2?LFS_T_STORAGE_INVALIDATE:LFS_T_STORAGE_QUERY,object,0,(uint64_t)offset,(uint64_t)size):0;
 uint32_t result=0;
 if(!info)result=FS_NULLPTR_ARGUMENT;
 else{
  /* StorageInterfaceAdapter clears its 64-byte IPC result for every opcode.
   * Unknown opcodes are no-ops at that adapter, before the layered storage. */
  lfs_zero(info,64);
  if((operation==2||operation==3)&&size!=0)result=FS_UNSUPPORTED_OPERATION;
 }
 lfs_trace_end(trace,result,0,0,0);return result;
}
uint32_t lfs_storage_batch(void *object,const struct ns_buffer *out0,const struct ns_buffer *out1,const struct ns_buffer *out2,const struct ns_buffer *out3,const struct ns_buffer *out4,const struct ns_buffer *out5,const struct ns_buffer *out6,const struct ns_buffer *input){
 struct lfs_context *c=lfs_context();struct lfs_lazy_config *a=lfs_lazy_config();
 struct lfs_life *n=c->enabled?lfs_lookup(object,LFS_STORAGE):0;
 if(!n||!n->owner)return a->storage_batch((uint8_t *)object+8,out0,out1,out2,out3,out4,out5,out6,input);
 uint64_t trace=lfs_trace_begin(LFS_T_STORAGE_BATCH,object,0,0,input?input->capacity:0);
 lfs_trace_end(trace,FS_UNSUPPORTED_OPERATION,0,0,0);return FS_UNSUPPORTED_OPERATION;
}
uint32_t lfs_read(void *object,int64_t at,const struct ns_buffer *buffer,int64_t length){
 struct lfs_context *c=lfs_context();uint32_t result;uint64_t end=(uint64_t)at+(uint64_t)length;
 struct lfs_life *tracked=lfs_lookup(object,LFS_STORAGE);
 uint64_t trace=tracked&&tracked->plan_owner?lfs_trace_begin(LFS_T_STORAGE_READ,object,0,(uint64_t)at,(uint64_t)length):0;
 add(&c->active,1);add(&c->calls,1);
 if(!c->enabled||at<0||length<=0||end<(uint64_t)at||(uint64_t)length>buffer->capacity)goto original;
 struct lfs_life *n=lfs_lookup(object,LFS_STORAGE);const struct lfs_view *v;
 if(n)v=n->owner;
 else{if(lfs_lazy_config())goto original;uint64_t size;if(c->original_size(object,&size))goto original;v=identify(object,size);}
 if(!v||end>v->size)goto original;
 uint32_t lo=0,hi=v->count;
 while(lo<hi){uint32_t mid=lo+(hi-lo)/2;const struct lfs_segment *s=&v->segments[mid];if(s->offset+s->length<=(uint64_t)at)lo=mid+1;else hi=mid;}
 if(lo==v->count||v->segments[lo].offset>=end){
  if(end<=v->original_size)goto original;
 }else{
  const struct lfs_segment *s=&v->segments[lo];
  if(s->offset<=(uint64_t)at&&s->offset+s->length>=end){
   add(&c->matched,1);result=read_segment(object,s,(uint64_t)at-s->offset,buffer->data,(uint64_t)length);goto redirected;
  }
 }
 add(&c->matched,1);
 /* Read each covered span from its actual source once. Prefilling the whole
  * request from the base storage duplicates I/O and makes a fully replaced
  * range depend on bytes the virtual view no longer uses. */
 uint64_t cursor=(uint64_t)at;
 for(uint32_t i=lo;i<v->count&&v->segments[i].offset<end;i++){
  const struct lfs_segment *s=&v->segments[i];uint64_t start=s->offset>cursor?s->offset:cursor;
  uint64_t stop=s->offset+s->length<end?s->offset+s->length:end;
  if(start>cursor){result=read_gap(object,v,cursor,(uint8_t *)buffer->data+cursor-(uint64_t)at,start-cursor);if(result)goto redirected;}
  if(stop>start){result=read_segment(object,s,start-s->offset,(uint8_t *)buffer->data+start-(uint64_t)at,stop-start);if(result)goto redirected;cursor=stop;}
 }
 result=cursor<end?read_gap(object,v,cursor,(uint8_t *)buffer->data+cursor-(uint64_t)at,end-cursor):0;
redirected:
 if(n&&n->plan_owner){
  if(!result&&!__atomic_exchange_n(&n->mode,1,__ATOMIC_RELAXED)){lfs_lazy_log("RomFS first read",0,(uint64_t)length,0,0);lfs_lazy_log_flush();}
  if(result){lfs_lazy_log("RomFS read error",0,(uint64_t)at,result,0);lfs_lazy_log_flush();}
 }else lfs_note(&c->view_stats[v-c->views],result?0:(uint64_t)length,result);
 if(result)add(&c->errors,1);
 goto finish;
original:
 result=trace?lfs_trace_original_read((uint8_t *)object+8,at,buffer,length):c->original_read((uint8_t *)object+8,at,buffer,length);
 if(result&&trace){lfs_lazy_log("Original RomFS read error",0,(uint64_t)at,result,0);lfs_lazy_log_flush();}
finish:
 lfs_trace_end(trace,result,result?0:(uint64_t)length,!result&&length>0&&(uint64_t)length<=buffer->capacity?buffer->data:0,!result&&length>0?(uint64_t)length:0);
 add(&c->active,-1);return result;
}
