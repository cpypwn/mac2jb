#include "trace.h"
static struct lfs_trace_state *state(void){struct lfs_lazy_config *a=lfs_lazy_config();return a?a->trace:0;}
static uint64_t tick(void){
#if defined(__aarch64__)
 uint64_t n;__asm__ volatile("mrs %0, cntpct_el0":"=r"(n));return n;
#else
 static uint64_t n;return __atomic_add_fetch(&n,1000,__ATOMIC_RELAXED);
#endif
}
static uint64_t frequency(void){
#if defined(__aarch64__)
 uint64_t n;__asm__ volatile("mrs %0, cntfrq_el0":"=r"(n));return n;
#else
 return 1000000;
#endif
}
static uint64_t thread(void){
#if defined(__aarch64__)
 uint64_t n;__asm__ volatile("mrs %0, tpidrro_el0":"=r"(n));return n;
#else
 static _Thread_local uint8_t id;return (uintptr_t)&id;
#endif
}
static int enter(struct lfs_trace_state *t){
 if(!t||!t->file||__atomic_load_n(&t->initialized,__ATOMIC_ACQUIRE)!=2||__atomic_load_n(&t->failed,__ATOMIC_RELAXED)||__atomic_load_n(&t->writer_thread,__ATOMIC_RELAXED)==thread())return 0;
 if(__atomic_exchange_n(&t->lock,1,__ATOMIC_ACQUIRE)){__atomic_fetch_add(&t->reserved,1,__ATOMIC_RELAXED);return 0;}
 for(unsigned i=0;i<LFS_TRACE_PENDING;i++){uint64_t ended=__atomic_exchange_n(&t->deferred_end[i],0,__ATOMIC_ACQUIRE);if(ended&&t->live.pending[i].sequence==ended){t->live.pending[i].sequence=0;t->live.h.pending_count--;t->live.h.dropped++;}}
 return 1;
}
static void leave(struct lfs_trace_state *t){__atomic_store_n(&t->lock,0,__ATOMIC_RELEASE);}
/* Lifecycle calls and lock ownership are breadcrumbs in RAM. They must never
 * start diagnostic I/O while an SDK/loader lock may be held. Existing safe
 * snapshot and journal boundaries copy these records with the other events. */
static int memory_only(uint32_t op){return op==LFS_T_STORAGE_SIZE||op==LFS_T_SOURCE_LOCK||op==LFS_T_PLAN_LOCK||op>=LFS_T_OBJECT_LOCK;}
static struct lfs_trace_stats *stats(struct lfs_trace_state *t,uint32_t id){
 if(!id)return 0;
 struct lfs_trace_stats *empty=0;
 for(unsigned i=0;i<LFS_TRACE_FILES;i++){struct lfs_trace_stats *s=&t->live.files[i];if(s->file==id)return s;if(!s->file&&!empty)empty=s;}
 if(!empty){__atomic_fetch_add(&t->live.h.dropped,1,__ATOMIC_RELAXED);return 0;}
 empty->file=id;t->live.h.file_count++;return empty;
}
static const struct lfs_lazy_file *source(uint32_t id){
 struct lfs_lazy_config *a=lfs_lazy_config();
 for(uint64_t i=0;i<a->count;i++)for(uint64_t j=0;j<a->games[i].count;j++)if(a->games[i].files[j].source.reserved==id)return &a->games[i].files[j];
 for(uint64_t i=0;i<a->patch_count;i++)if(a->patches[i].source.reserved==id)return &a->patches[i];return 0;
}
static int pak(const char *p){uint64_t n=lfs_text_length(p);return n>=4&&p[n-4]=='.'&&(p[n-3]=='p'||p[n-3]=='P')&&(p[n-2]=='a'||p[n-2]=='A')&&(p[n-1]=='k'||p[n-1]=='K');}
static void record(struct lfs_trace_state *t,const struct lfs_trace_record *r){t->live.records[t->live.h.next_record++%LFS_TRACE_EVENTS]=*r;}
static uint32_t checksum(const void *data){const uint8_t *p=data;uint32_t h=2166136261u;for(unsigned i=0;i<LFS_TRACE_PAGE;i++){h^=i>=112&&i<116?0:p[i];h*=16777619u;}return h;}
/* A separate pair of small checksummed pages identifies recorder I/O, so
 * an operation present in a snapshot is not confused with a writer stall.
 * This is a bounded diagnostic journal, never a thread or retry loop. */
static uint32_t progress_checksum(const void *data){
 const uint8_t *p=data;uint32_t h=2166136261u;
 for(unsigned i=0;i<LFS_TRACE_PROGRESS_PAGE;i++){h^=i>=128&&i<132?0:p[i];h*=16777619u;}return h;
}
void lfs_trace_io_progress(uint32_t operation,uint32_t phase,uint64_t offset,uint64_t length,uint32_t result){
 struct lfs_trace_state *t=state();struct lfs_context *c=lfs_context();struct lfs_lazy_config *a=lfs_lazy_config();
 if(!t||!t->file||t->initialized!=2||!(__atomic_load_n(&t->live.h.status,__ATOMIC_RELAXED)&4)||__atomic_load_n(&t->progress_failed,__ATOMIC_RELAXED)||__atomic_load_n(&c->lock,__ATOMIC_RELAXED))return;
 if(__atomic_exchange_n(&t->progress_lock,1,__ATOMIC_ACQUIRE))return;
 if(!enter(t)){__atomic_store_n(&t->progress_lock,0,__ATOMIC_RELEASE);return;}
 struct lfs_trace_progress *p=&t->progress;lfs_zero(p,sizeof(*p));lfs_copy(p->magic,"NS2IO001",8);p->version=1;p->size=sizeof(*p);
 p->generation=++t->progress_generation;p->tick=tick();p->frequency=t->live.h.frequency;p->thread=thread();p->snapshot_generation=t->generation;p->sequence=t->live.h.sequence;
 p->operation=operation;p->phase=phase;p->result=result;p->pending=t->live.h.pending_count;p->offset=offset;p->length=length;p->completed=t->live.h.completed;p->log_cursor=a->log_cursor;p->active=__atomic_load_n(&c->active,__ATOMIC_RELAXED);
 p->locks=(!!__atomic_load_n(&t->io_lock,__ATOMIC_RELAXED))|(!!__atomic_load_n(&a->log_lock,__ATOMIC_RELAXED)<<1)|(!!__atomic_load_n(&a->plan_lock,__ATOMIC_RELAXED)<<2);p->failed=t->failed;p->reserved=a->log_failed;
 lfs_copy(p->pending_records,t->live.pending,sizeof(p->pending_records));p->last_completed=t->live.last_completed;p->last_source=t->live.last_source;p->last_original=t->live.last_original;p->last_size=t->last_size;p->size_queries=t->size_queries;leave(t);
 p->checksum=progress_checksum(p);
 struct ns_buffer buffer={p,sizeof(*p)};
 /* Flush is part of this individual journal write. If the SD itself stops,
  * the previous valid page remains usable; it cannot promise the next step. */
 uint32_t write_result=c->write(t->file,LFS_TRACE_PAGE*2+(p->generation&1)*LFS_TRACE_PROGRESS_PAGE,&buffer,sizeof(*p),1);
 if(write_result)__atomic_store_n(&t->progress_failed,write_result,__ATOMIC_RELAXED);
 __atomic_store_n(&t->progress_lock,0,__ATOMIC_RELEASE);
}
void lfs_trace_checkpoint(int force){
 struct lfs_trace_state *t=state();struct lfs_context *c=lfs_context();struct lfs_lazy_config *a=lfs_lazy_config();
 if(!t||!t->file||__atomic_load_n(&t->failed,__ATOMIC_RELAXED)||__atomic_load_n(&a->plan_lock,__ATOMIC_RELAXED)||__atomic_load_n(&c->lock,__ATOMIC_RELAXED)||__atomic_load_n(&a->log_lock,__ATOMIC_RELAXED))return;
 uint64_t now=tick();if(!force&&now<__atomic_load_n(&t->next_checkpoint,__ATOMIC_RELAXED))return;
 if(__atomic_exchange_n(&t->io_lock,1,__ATOMIC_ACQUIRE))return;
 if(!enter(t)){__atomic_store_n(&t->io_lock,0,__ATOMIC_RELEASE);return;}
 now=tick();if(!force&&now<t->next_checkpoint){leave(t);__atomic_store_n(&t->io_lock,0,__ATOMIC_RELEASE);return;}
 uint64_t elapsed=now-t->start_tick,f=t->live.h.frequency,interval=elapsed<f*30?f/4:elapsed<f*120?f*2:f*10;
 __atomic_store_n(&t->next_checkpoint,now+(interval?interval:1),__ATOMIC_RELAXED);
 t->live.h.generation=++t->generation;t->live.h.tick=now;t->live.h.checkpoints++;
 lfs_copy(&t->saved,&t->live,sizeof(t->saved));t->saved.h.dropped+=__atomic_load_n(&t->reserved,__ATOMIC_RELAXED);uint64_t log_dropped=__atomic_load_n(&a->log_dropped,__ATOMIC_RELAXED);t->saved.h.reserved[0]=(uint32_t)log_dropped;t->saved.h.reserved[1]=(uint32_t)(log_dropped>>32);leave(t);
 t->saved.h.checksum=checksum(&t->saved);
 lfs_trace_io_progress(LFS_IO_TRACE_WRITE,1,(t->generation&1)*LFS_TRACE_PAGE,sizeof(t->saved),0);
 __atomic_store_n(&t->writer_thread,thread(),__ATOMIC_RELEASE);
 struct ns_buffer b={&t->saved,sizeof(t->saved)};
 uint32_t result=c->write(t->file,(t->generation&1)*LFS_TRACE_PAGE,&b,sizeof(t->saved),0);
 __atomic_store_n(&t->writer_thread,0,__ATOMIC_RELEASE);
 lfs_trace_io_progress(LFS_IO_TRACE_WRITE,2,(t->generation&1)*LFS_TRACE_PAGE,sizeof(t->saved),result);
 if(!result){
  lfs_trace_io_progress(LFS_IO_TRACE_FLUSH,1,0,0,0);__atomic_store_n(&t->writer_thread,thread(),__ATOMIC_RELEASE);
  result=c->flush(t->file);__atomic_store_n(&t->writer_thread,0,__ATOMIC_RELEASE);
  lfs_trace_io_progress(LFS_IO_TRACE_FLUSH,2,0,0,result);
 }
 if(result){__atomic_store_n(&t->failed,result,__ATOMIC_RELAXED);__atomic_fetch_add(&t->live.h.write_failures,1,__ATOMIC_RELAXED);}
 __atomic_store_n(&t->writer_thread,0,__ATOMIC_RELEASE);__atomic_store_n(&t->io_lock,0,__ATOMIC_RELEASE);
}
void lfs_trace_initialize(void){
 /* Files are opened and qualified through the existing app session before
  * hooks are attached. Activation must not open or flush another FS file from
  * the notifier thread. The first game operation saves the initial snapshot. */
 struct lfs_trace_state *t=state();if(!t||!t->file||t->initialized)return;
 t->initialized=1;t->start_tick=tick();lfs_copy(t->live.h.magic,"NS2TRC01",8);t->live.h.version=1;t->live.h.size=LFS_TRACE_PAGE;t->live.h.frequency=frequency();t->live.h.status=1;
 __atomic_store_n(&t->initialized,2,__ATOMIC_RELEASE);
}
uint64_t lfs_trace_begin(uint32_t op,void *object,uint32_t id,uint64_t offset,uint64_t requested){
 struct lfs_trace_state *t=state();if(!enter(t))return 0;
 __atomic_fetch_or(&t->live.h.status,4,__ATOMIC_RELAXED);
 struct lfs_trace_record r={.sequence=++t->live.h.sequence,.tick=tick(),.thread=thread(),.object=(uintptr_t)object,.offset=offset,.requested=requested,.event=1,.operation=op,.file=id};
 int force=op==LFS_T_PREPARE;
 if(op==LFS_T_STORAGE_READ&&!(__atomic_fetch_or(&t->live.h.status,2,__ATOMIC_RELAXED)&2))force=1;
 if(op==LFS_T_SOURCE_OPEN&&id){struct lfs_trace_stats *s=stats(t,id);if(s&&!(s->flags&128)){s->flags|=128;force=1;}}
 if(op==LFS_T_SOURCE_READ&&id){struct lfs_trace_stats *s=stats(t,id);if(s){
  if(!s->reads){const struct lfs_lazy_file *f=source(id);if(f&&f->kind==LAZY_ROMFS&&pak(f->name)&&offset<=f->size&&requested==f->size-offset&&requested>=44&&requested<=512){r.flags|=1;s->flags|=2;force=1;}}
  if((s->flags&1)&&!(s->flags&4)&&requested&&offset<s->index_offset+s->index_size&&requested>(offset<s->index_offset?s->index_offset-offset:0)){s->flags|=4;r.flags|=2;force=1;}
  if((s->flags&8)&&!(s->flags&32)&&!(r.flags&3)&&requested&&offset<s->index_offset&&requested<=s->index_offset-offset){s->flags|=32;r.flags|=8;force=1;}
 }}
 unsigned slot;for(slot=0;slot<LFS_TRACE_PENDING;slot++)if(!t->live.pending[slot].sequence){t->live.pending[slot]=r;t->live.h.pending_count++;break;}
 if(slot==LFS_TRACE_PENDING){__atomic_fetch_add(&t->live.h.dropped,1,__ATOMIC_RELAXED);r.flags|=4;}
 record(t,&r);leave(t);if(!memory_only(op))lfs_trace_checkpoint(force);return slot<LFS_TRACE_PENDING?(r.sequence<<5)|(slot+1):0;
}
void lfs_trace_end(uint64_t token,uint32_t result,uint64_t actual,const void *data,uint64_t length){
 struct lfs_trace_state *t=state();if(!token||!t)return;
 unsigned slot=(unsigned)(token&31)-1;uint64_t sequence=token>>5;if(slot>=LFS_TRACE_PENDING)return;
 if(!enter(t)){__atomic_store_n(&t->deferred_end[slot],sequence,__ATOMIC_RELEASE);return;}
 if(t->live.pending[slot].sequence!=sequence){leave(t);return;}
 struct lfs_trace_record r=t->live.pending[slot];t->live.pending[slot].sequence=0;t->live.h.pending_count--;
 uint64_t now=tick();r.parent=sequence;r.sequence=++t->live.h.sequence;r.duration=now-r.tick;r.tick=now;r.event=2;r.result=result;r.actual=actual;
 if(data&&!result){r.sample_size=(uint32_t)(length<sizeof(r.sample)?length:sizeof(r.sample));lfs_copy(r.sample,data,r.sample_size);}
 t->live.h.completed++;if(result)t->live.h.errors++;
 if(r.operation==LFS_T_STORAGE_SIZE){t->last_size=r;t->size_queries++;}
 if(r.operation==LFS_T_SOURCE_READ){t->live.h.bytes+=actual;struct lfs_trace_stats *s=stats(t,r.file);if(s){s->reads++;s->bytes+=actual;if(result)s->errors++;if(!result&&(r.flags&2))s->flags|=8;if(!result&&(r.flags&8))s->flags|=64;s->last_offset=r.offset;s->last_length=r.requested;s->last_tick=now;}}
 t->live.last_completed=r;
 if(result&&!t->live.first_error.sequence)t->live.first_error=r;
 if(!t->live.slowest.sequence||r.duration>t->live.slowest.duration)t->live.slowest=r;
 if(r.operation==LFS_T_SOURCE_READ)t->live.last_source=r;
 if(r.operation==LFS_T_ORIGINAL_READ)t->live.last_original=r;
 if(r.operation==LFS_T_PREPARE)t->live.last_prepare=r;
 if(r.operation==LFS_T_SOURCE_LOCK||r.operation==LFS_T_PLAN_LOCK||r.operation==LFS_T_OBJECT_LOCK)t->live.last_wait=r;
 /* GetSize must remain memory-only. A later read/mount checkpoint also
  * saves these completed events without doing SD I/O inside the size query. */
 record(t,&r);leave(t);if(!memory_only(r.operation))lfs_trace_checkpoint(result!=0||(r.flags&11)||r.duration>=t->live.h.frequency/2);
}
static uint32_t u32(const uint8_t *p){return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static uint64_t u64(const uint8_t *p){return (uint64_t)u32(p)|(uint64_t)u32(p+4)<<32;}
void lfs_trace_pak(struct lfs_source *s,uint64_t at,const void *memory,uint64_t length){
 struct lfs_trace_state *t=state();if(!s->reserved||length<44||length>512||!enter(t))return;
 struct lfs_trace_stats *st=stats(t,s->reserved);const struct lfs_lazy_file *f=st&&!(st->flags&16)?source(s->reserved):0;
 if(!f||f->kind!=LAZY_ROMFS||!pak(f->name)||at>f->size||length!=f->size-at){leave(t);return;}
 st->flags|=16;const uint8_t *p=memory;uint32_t version=0;uint64_t offset=0,size=0;unsigned found=0,magic=0;
 for(unsigned i=0;i+44<=length;i++)if(u32(p+i)==0x5a6f12e1u){version=u32(p+i+4);offset=u64(p+i+8);size=u64(p+i+16);if(version&&version<64&&offset<=f->size&&size<=f->size-offset){found=1;magic=i;break;}}
 if(found){st->flags|=1;st->pak_version=version;st->index_offset=offset;st->index_size=size;
  if(size&&at<offset+size&&length>(at<offset?offset-at:0))st->flags|=4|8;
 }leave(t);
 lfs_lazy_log("PAK footer observed",0,length,0,s->path);
 if(found){lfs_lazy_log("PAK format version",0,version,0,s->path);lfs_lazy_log("PAK index offset",0,offset,0,s->path);lfs_lazy_log("PAK index size",0,size,0,s->path);if(magic==17)lfs_lazy_log("PAK encrypted index flag",0,p[16],0,s->path);}
 else lfs_lazy_log("PAK footer format unrecognized",0,length,0,s->path);
 /* Bounded raw metadata, copied from bytes already requested by the game. */
 for(unsigned i=0;i<length&&i<256;i+=16){char text[64];const char hex[]="0123456789abcdef";lfs_copy(text,"PAK footer hex ",15);unsigned n=15;for(unsigned j=i;j<length&&j<i+16;j++){text[n++]=hex[p[j]>>4];text[n++]=hex[p[j]&15];}text[n]=0;lfs_lazy_log(text,0,at+i,0,s->path);}
 lfs_lazy_log_flush();
}

/* Original storage operations have their own entry/exit so a slow base-game
 * read can be distinguished from a mod source read or metadata preparation. */
uint32_t lfs_trace_original_read(void *storage,int64_t offset,const struct ns_buffer *buffer,int64_t length){
 uint64_t token=lfs_trace_begin(LFS_T_ORIGINAL_READ,storage,0,(uint64_t)offset,(uint64_t)length);
 uint32_t result=lfs_context()->original_read(storage,offset,buffer,length);
 lfs_trace_end(token,result,result?0:(uint64_t)length,0,0);return result;
}

uint64_t lfs_trace_clock_probe(uint64_t *output){
 if(!output)return 0xd401;
 output[0]=tick();output[1]=frequency();return output[1]?0:0xd401;
}
