#include "lazy.h"
#include "trace.h"

// Resolve a mounted game's identity from the live FS registry. The returned
// shared reference is held only for the lookup, never across game sessions.
uint32_t lfs_program_for_pid(const struct lfs_lazy_api *a,uint64_t pid,uint64_t *program){
 if(!a||!a->registry||!a->program_info||!a->release_weak||!program)return 0xd401;
 struct lfs_shared info={0,0};
 uint64_t trace=lfs_trace_begin(LFS_T_PROGRAM_LOOKUP,a->registry,0,pid,0);
 uint32_t result=a->program_info(a->registry,&info,pid);
 if(!result){if(!info.object)result=0xd401;else *program=((const uint64_t *)info.object)[1];}
 if(info.control){
  uint64_t *owners=(uint64_t *)((uint8_t *)info.control+8);
  if(__atomic_fetch_sub(owners,1,__ATOMIC_ACQ_REL)==0){
   ((ns_ref_fn)(*(void ***)info.control)[2])(info.control);
   a->release_weak(info.control);
  }
 }
 lfs_trace_end(trace,result,!result?*program:0,0,0);return result;
}

struct system_block { uint64_t size,reserved; };
struct lfs_arena { struct lfs_arena *next; uint64_t used,capacity,reserved; };
/* Evict file references rather than retaining every file in a large modpack.
 * This bounds open resources without limiting how many mod files can load. */
struct owned_source { struct lfs_source *source; void *file; uint64_t used; };
struct owned_plan { struct lfs_arena *arena; uint64_t references; uint32_t source_lock,reserved; uint64_t clock; struct owned_source sources[8]; };

void lfs_copy(void *to,const void *from,uint64_t size){
 uint8_t *d=to;const uint8_t *s=from;for(uint64_t i=0;i<size;i++)d[i]=s[i];
}
uint64_t lfs_text_length(const char *s){uint64_t n=0;while(n<=0x300&&s[n])n++;return n;}
int lfs_text_equal(const char *a,const char *b){
 for(unsigned i=0;i<=0x300;i++){if(a[i]!=b[i])return 0;if(!a[i])return 1;}return 0;
}
void *lfs_system_allocate(uint64_t size){
 struct lfs_lazy_config *c=lfs_lazy_config();
 if(!c||!size||size>UINT64_MAX-0x1010)return 0;
 uint64_t bytes=(size+sizeof(struct system_block)+4095)&~UINT64_C(4095);void *memory=0;
 uint64_t trace=lfs_trace_begin(LFS_T_ALLOCATE,c->memory_manager,0,0,bytes);
 uint32_t result=c->allocate_block(c->memory_manager,&memory,bytes);
 lfs_trace_end(trace,result?result:memory?0:0xd401,(uintptr_t)memory,0,0);
 if(result||!memory)return 0;
 struct system_block *b=memory;b->size=bytes;b->reserved=0;return b+1;
}
void lfs_system_free(void *memory){
 if(memory){struct system_block *b=(struct system_block *)memory-1;struct lfs_lazy_config *c=lfs_lazy_config();uint64_t trace=lfs_trace_begin(LFS_T_FREE,b,0,0,b->size);uint32_t result=c->free_block(c->memory_manager,b,b->size);lfs_trace_end(trace,result,0,0,0);}
}
void *lfs_arena_allocate(struct lfs_arena **arena,uint64_t size){
 if(!size||size>UINT64_MAX-0x10000)return 0;size=(size+15)&~UINT64_C(15);
 struct lfs_arena *a=*arena;
 if(!a||size>a->capacity-a->used){
  uint64_t capacity=size>0x10000?size:0x10000;
  a=lfs_system_allocate(sizeof(*a)+capacity);if(!a)return 0;
  a->next=*arena;a->used=0;a->capacity=capacity;*arena=a;
 }
 uint8_t *memory=(uint8_t *)(a+1)+a->used;a->used+=size;lfs_zero(memory,size);return memory;
}
void lfs_arena_free(struct lfs_arena *arena){
 while(arena){struct lfs_arena *next=arena->next;lfs_system_free(arena);arena=next;}
}
void *lfs_lazy_plan_allocate(struct lfs_arena **arena,uint64_t size){
 struct owned_plan *p=lfs_arena_allocate(arena,sizeof(*p)+size);if(!p)return 0;
 p->references=1;return p+1;
}
void lfs_lazy_plan_finish(void *owner,struct lfs_arena *arena){((struct owned_plan *)owner-1)->arena=arena;}
void lfs_lazy_owner_retain(const void *owner){if(owner)__atomic_fetch_add(&((struct owned_plan *)owner-1)->references,1,__ATOMIC_RELAXED);}
static void source_release(void *file,uint32_t id,uint32_t operation){
 uint64_t trace=lfs_trace_begin(operation,file,id,0,0);
 lfs_context()->sdk.file_release(file);lfs_trace_end(trace,0,0,0,0);
}
void lfs_lazy_owner_release(const void *owner){
 if(owner){struct owned_plan *p=(struct owned_plan *)owner-1;if(__atomic_fetch_sub(&p->references,1,__ATOMIC_ACQ_REL)==1){
  for(unsigned i=0;i<8;i++)if(p->sources[i].file)source_release(p->sources[i].file,p->sources[i].source->reserved,LFS_T_SOURCE_CLOSE);
  lfs_arena_free(p->arena);
 }}
}
uint32_t lfs_lazy_source_read(const void *owner,struct lfs_source *source,uint64_t offset,void *data,uint64_t size){
 struct owned_plan *p=(struct owned_plan *)owner-1;struct lfs_context *c=lfs_context();void *file=0;uint32_t result=0;int first=0;struct owned_source *slot=0;
 uint64_t trace=lfs_trace_begin(LFS_T_SOURCE_OPEN,p,source->reserved,offset,size);
 uint64_t lock_trace=lfs_trace_begin(LFS_T_SOURCE_LOCK,&p->source_lock,source->reserved,offset,size);
 lfs_mutex_lock(&p->source_lock);
 lfs_trace_end(lock_trace,0,0,0,0);
 uint64_t held=lfs_trace_begin(LFS_T_SOURCE_LOCK_HELD,&p->source_lock,source->reserved,offset,size);
 for(unsigned i=0;i<8;i++){
  struct owned_source *s=&p->sources[i];
  if(s->source==source&&s->file){file=s->file;slot=s;break;}
  if(!slot||!s->file||(slot->file&&s->used<slot->used))slot=s;
 }
 if(!file){
  if(slot->file)source_release(slot->file,slot->source->reserved,LFS_T_SOURCE_CLOSE);
  slot->source=0;slot->file=0;
  struct ns_out out={&file};uint64_t native_open=lfs_trace_begin(LFS_T_SOURCE_NATIVE_OPEN,c->source_fs,source->reserved,offset,size);
  result=c->open_file((uint8_t *)c->source_fs+8,&out,source->path,1);
  if(!result&&!file)result=0xd401;
  lfs_trace_end(native_open,result,(uintptr_t)file,0,0);
  if(!result){slot->source=source;slot->file=file;}
 }
 if(!result){slot->used=++p->clock;uint64_t retain=lfs_trace_begin(LFS_T_SOURCE_RETAIN,file,source->reserved,0,0);((ns_ref_fn)(*(void ***)file)[0])(file);lfs_trace_end(retain,0,0,0,0);}
 if(!p->reserved){p->reserved=1;first=1;}
 lfs_trace_end(held,0,0,0,0);lfs_mutex_unlock(&p->source_lock);
 lfs_trace_end(trace,result,0,0,0);
 if(result){lfs_note(source,0,result);return result;}
 result=lfs_source_read_file(file,source,offset,data,size);
 if(!result&&size&&!__atomic_exchange_n(&source->bytes,1,__ATOMIC_ACQ_REL))lfs_lazy_log("RomFS mod data read",0,offset,0,source->path);
 if(first)lfs_lazy_log_flush();
 source_release(file,source->reserved,LFS_T_SOURCE_RELEASE);
 return result;
}
const struct lfs_lazy_game *lfs_lazy_game(uint64_t program){
 const struct lfs_lazy_config *c=lfs_lazy_config();if(!c)return 0;
 for(uint64_t i=0;i<c->count;i++)if(c->games[i].program_id==program)return &c->games[i];
 /* Compatibility updates may retain the application's low 56 bits. Only
  * application namespaces are aliases; all other IDs remain exact. */
 uint64_t platform=program>>56;
 if(platform==1||platform==4)for(uint64_t i=0;i<c->count;i++){
  uint64_t id=c->games[i].program_id,other=id>>56;
  if((other==1||other==4)&&((id^program)&UINT64_C(0x00ffffffffffffff))==0)return &c->games[i];
 }
 return 0;
}
void lfs_lazy_plan_lock(void){
 struct lfs_lazy_config *a=lfs_lazy_config();uint64_t wait=lfs_trace_begin(LFS_T_PLAN_LOCK,&a->plan_lock,0,0,0);
 lfs_mutex_lock(&a->plan_lock);
 lfs_trace_end(wait,0,0,0,0);
 if(a->trace)a->trace->plan_lock_trace=lfs_trace_begin(LFS_T_PLAN_LOCK_HELD,&a->plan_lock,0,0,0);
}
void lfs_lazy_plan_unlock(void){
 struct lfs_lazy_config *a=lfs_lazy_config();if(a->trace){lfs_trace_end(a->trace->plan_lock_trace,0,0,0,0);a->trace->plan_lock_trace=0;}
 lfs_mutex_unlock(&a->plan_lock);
}

static int write_log(struct lfs_lazy_config *a){
 struct lfs_context *c=lfs_context();if(!a->log_buffered)return 1;
 struct ns_buffer b={a->log_buffer,a->log_buffered};
 lfs_trace_io_progress(LFS_IO_TEXT_WRITE,1,a->log_cursor,b.capacity,0);
 uint32_t result=c->write(c->log_file,a->log_cursor,&b,b.capacity,0);
 lfs_trace_io_progress(LFS_IO_TEXT_WRITE,2,a->log_cursor,b.capacity,result);
 if(result){a->log_failed=1;return 0;}
 a->log_cursor+=a->log_buffered;a->log_buffered=0;return 1;
}
static uint32_t flush_log(struct lfs_context *c){
 lfs_trace_io_progress(LFS_IO_TEXT_FLUSH,1,0,0,0);uint32_t result=c->flush(c->log_file);
 lfs_trace_io_progress(LFS_IO_TEXT_FLUSH,2,0,0,result);return result;
}
static uint32_t error_log(struct lfs_context *c,uint64_t at,const struct ns_buffer *b,uint64_t length){
 lfs_trace_io_progress(LFS_IO_TEXT_WRITE,1,at,length,0);uint32_t result=c->write(c->log_file,at,b,length,0);
 lfs_trace_io_progress(LFS_IO_TEXT_WRITE,2,at,length,result);return result;
}
static unsigned hex(char *out,uint64_t value,unsigned count){
 static const char alphabet[]="0123456789abcdef";
 for(unsigned i=0;i<count;i++)out[i]=alphabet[(value>>((count-i-1)*4))&15];return count;
}
void lfs_lazy_log(const char *event,uint64_t program,uint64_t value,uint32_t result,const char *path){
 struct lfs_lazy_config *a=lfs_lazy_config();struct lfs_context *c=lfs_context();
 if(!a||!c->log_file||!a->log_buffer||__atomic_load_n(&a->log_failed,__ATOMIC_RELAXED))return;
 char row[0x380];unsigned n=0;uint64_t length=lfs_text_length(event);if(length>64)return;
 lfs_copy(row,event,length);n=(unsigned)length;row[n++]=' ';n+=hex(row+n,program,16);row[n++]=' ';n+=hex(row+n,value,16);row[n++]=' ';n+=hex(row+n,result,8);
 if(path){length=lfs_text_length(path);if(length>0x300)length=0x300;row[n++]=' ';lfs_copy(row+n,path,length);n+=(unsigned)length;}row[n++]='\n';
 if(__atomic_exchange_n(&a->log_lock,1,__ATOMIC_ACQUIRE)){__atomic_fetch_add(&a->log_dropped,1,__ATOMIC_RELAXED);return;}
 uint64_t budget=a->log_limit>4096?a->log_limit-4096:0;
 int saved=0;
 if(result&&!a->reserved&&!a->log_failed){
  struct ns_buffer error={row,n};a->reserved=1;
  if(write_log(a)){
   if(a->log_cursor>a->log_limit||n>a->log_limit-a->log_cursor||error_log(c,a->log_cursor,&error,n)||flush_log(c))a->log_failed=1;
   else{a->log_cursor+=n;saved=1;}
  }
 }
 if(!saved&&!a->log_failed&&a->log_cursor<=budget&&a->log_buffered<=budget-a->log_cursor&&n<=budget-a->log_cursor-a->log_buffered){
  if(a->log_buffered+n>0x4000)write_log(a);
  if(!a->log_failed){lfs_copy(a->log_buffer+a->log_buffered,row,n);a->log_buffered+=n;}
 }
 __atomic_store_n(&a->log_lock,0,__ATOMIC_RELEASE);
}
void lfs_lazy_log_flush(void){
 struct lfs_lazy_config *a=lfs_lazy_config();struct lfs_context *c=lfs_context();
 if(!a||!c->log_file||__atomic_load_n(&a->log_failed,__ATOMIC_RELAXED))return;
 if(__atomic_exchange_n(&a->log_lock,1,__ATOMIC_ACQUIRE)){__atomic_fetch_add(&a->log_dropped,1,__ATOMIC_RELAXED);return;}
 if(a->log_buffered&&!a->log_failed&&write_log(a)&&flush_log(c))a->log_failed=1;
 __atomic_store_n(&a->log_lock,0,__ATOMIC_RELEASE);
}
void lfs_lazy_unconfigured(uint64_t program,uint64_t kind){
 struct lfs_lazy_config *a=lfs_lazy_config();uint64_t platform=program>>56;
 if(a&&(platform==1||platform==4)&&(program&UINT64_C(0x00ffffffffffffff))>=0x10000&&__atomic_fetch_add(&a->unconfigured_mounts,1,__ATOMIC_RELAXED)<16){
  lfs_lazy_log("No matching game folder",program,kind,0,0);lfs_lazy_log_flush();
 }
}

uint32_t lfs_lazy_mount_current(void *root,struct ns_out *out){
 struct lfs_lazy_config *a=lfs_lazy_config();uint64_t trace=lfs_trace_begin(LFS_T_MOUNT_CURRENT,root,0,0,0);uint32_t result=a->mount_current(root,out);
 lfs_trace_end(trace,result,0,0,0);
 if(!lfs_context()->enabled)return result;
 if(lfs_context()->enabled){
  uint64_t program=0;uint64_t pid=*(uint64_t *)((uint8_t *)root+0x30);
  uint32_t lookup=lfs_program_for_pid(&a->api,pid,&program);
  if(result){lfs_lazy_log("Original RomFS mount failed",program,pid,result,0);lfs_lazy_log_flush();return result;}
  if(!lookup)result=lfs_lazy_attach_storage(*out->value,program);
  else{lfs_lazy_log("Program lookup",0,pid,lookup,0);lfs_lazy_log_flush();}
  if(result){lfs_lazy_log("RomFS mount",program,pid,result,0);lfs_lazy_log_flush();}
 }
 if(result&&*out->value){lfs_context()->sdk.storage_release(*out->value);*out->value=0;}return result;
}
uint32_t lfs_lazy_mount_program(void *root,struct ns_out *out,uint64_t program){
 struct lfs_lazy_config *a=lfs_lazy_config();uint64_t trace=lfs_trace_begin(LFS_T_MOUNT_PROGRAM,root,0,program,0);uint32_t result=a->mount_program(root,out,program);
 lfs_trace_end(trace,result,program,0,0);
 if(result&&lfs_context()->enabled&&lfs_lazy_game(program)){lfs_lazy_log("Original RomFS mount failed",program,0,result,0);lfs_lazy_log_flush();}
 if(!result&&lfs_context()->enabled){result=lfs_lazy_attach_storage(*out->value,program);if(result&&*out->value){lfs_context()->sdk.storage_release(*out->value);*out->value=0;}}return result;
}
uint32_t lfs_lazy_mount_data(void *root,struct ns_out *out,uint64_t program,uint32_t storage){
 struct lfs_lazy_config *a=lfs_lazy_config();uint64_t trace=lfs_trace_begin(LFS_T_MOUNT_DATA,root,0,program,storage);uint32_t result=a->mount_data(root,out,program,storage);
 lfs_trace_end(trace,result,program,0,0);
 if(result&&lfs_context()->enabled&&lfs_lazy_game(program)){lfs_lazy_log("Original data mount failed",program,storage,result,0);lfs_lazy_log_flush();}
 if(!result&&lfs_context()->enabled){result=lfs_lazy_attach_storage(*out->value,program);if(result&&*out->value){lfs_context()->sdk.storage_release(*out->value);*out->value=0;}}return result;
}
