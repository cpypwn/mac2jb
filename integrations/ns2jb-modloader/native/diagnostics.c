#include "namespace.h"
#include "lazy.h"
#include "trace.h"
static void decimal(char *out,uint64_t n){
 for(unsigned i=0;i<20;i++)out[i]=' ';
 unsigned i=20;do{out[--i]=(char)('0'+n%10);n/=10;}while(n&&i);
}
static void hex(char *out,uint32_t n){
 const char *digits="0123456789abcdef";for(unsigned i=0;i<8;i++)out[i]=digits[(n>>(28-i*4))&15];
}
static void fields(char *out,uint64_t a,uint64_t b,uint64_t c,uint32_t result){
 decimal(out,a);decimal(out+21,b);decimal(out+42,c);hex(out+63,result);
}
static void observation(const struct lfs_source *s){
 if(s->log)fields(s->log,__atomic_load_n(&s->reads,__ATOMIC_RELAXED),__atomic_load_n(&s->bytes,__ATOMIC_RELAXED),__atomic_load_n(&s->errors,__ATOMIC_RELAXED),__atomic_load_n(&s->result,__ATOMIC_RELAXED));
}
void lfs_flush(void){
 struct lfs_context *c=lfs_context();
 if(!c->log_file||__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)||__atomic_load_n(&c->revision,__ATOMIC_RELAXED)==__atomic_load_n(&c->flushed_revision,__ATOMIC_RELAXED)||__atomic_exchange_n(&c->log_lock,1,__ATOMIC_ACQUIRE))return;
 uint64_t revision=__atomic_load_n(&c->revision,__ATOMIC_ACQUIRE);
 for(uint64_t i=0;i<c->source_count;i++){
  observation(&c->sources[i]);
 }
 for(uint32_t i=0;i<c->count;i++){
  observation(&c->view_stats[i]);
 }
 if(c->codefs)for(uint64_t i=0;i<c->codefs->count;i++){
  const struct ns_group *g=&c->codefs->groups[i];for(uint64_t j=0;j<g->count;j++)observation(&g->files[j].observation);
 }
 fields(c->log+c->unmatched_log,__atomic_load_n(&c->unmatched_count,__ATOMIC_RELAXED),__atomic_load_n(&c->unmatched_size,__ATOMIC_RELAXED),__atomic_load_n(&c->identity_mismatches,__ATOMIC_RELAXED),(uint32_t)__atomic_load_n(&c->reserved2,__ATOMIC_RELAXED));
 const struct lfs_source *last=__atomic_load_n(&c->last_error_source,__ATOMIC_ACQUIRE);
 if(last&&c->error_log){
  const struct lfs_source *s=last;hex(c->error_log,__atomic_load_n(&s->result,__ATOMIC_RELAXED));
  for(unsigned i=0;i<0x300;i++)c->error_log[9+i]=' ';
  if(s->path)for(unsigned i=0;i<0x300&&s->path[i];i++)c->error_log[9+i]=(unsigned char)s->path[i]>=32?s->path[i]:'?';
 }
 struct ns_buffer b={c->log,c->log_size};uint32_t result=c->write(c->log_file,0,&b,c->log_size,0);
 if(!result)result=c->flush(c->log_file);
 __atomic_store_n(&c->flushed_revision,revision,__ATOMIC_RELEASE);
 if(result)__atomic_store_n(&c->log_errors,1,__ATOMIC_RELEASE);
 __atomic_store_n(&c->log_lock,0,__ATOMIC_RELEASE);
}
void lfs_observe(struct lfs_source *source,uint64_t bytes,uint32_t result){
 struct lfs_context *c=lfs_context();if(!c->log_file||!source||__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED))return;
 if(lfs_lazy_config()){
  if(__atomic_exchange_n(result?&source->errors:&source->reads,1,__ATOMIC_ACQ_REL))return;
  lfs_lazy_log(result?"Source error":"Source first read",0,bytes,result,source->path);
  if(result)lfs_lazy_log_flush();return;
 }
 if(result){
  if(__atomic_exchange_n(&source->errors,1,__ATOMIC_ACQ_REL))return;
  __atomic_store_n(&source->result,result,__ATOMIC_RELAXED);
  struct lfs_source *previous=0;int first=__atomic_compare_exchange_n(&c->last_error_source,&previous,source,0,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE);
  __atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);
  if(first)lfs_flush();
 }else{
  if(__atomic_exchange_n(&source->reads,1,__ATOMIC_ACQ_REL))return;
  __atomic_store_n(&source->bytes,bytes,__ATOMIC_RELAXED);__atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);
 }
}
uint64_t lfs_game_observations(void){
 struct lfs_context *c=lfs_context();
 if(lfs_lazy_config()){
  lfs_trace_initialize();
  if(lfs_lazy_config()->trace)lfs_lazy_log(lfs_lazy_config()->trace->initialized==2?"Diagnostic trace enabled":"Diagnostic trace unavailable",0,40960,0,0);
  if(c->log_ready&&c->log_file&&!lfs_lazy_config()->log_failed){
   *c->log_ready='1';struct ns_buffer b={c->log_ready,1};
   if(c->write(c->log_file,(uint64_t)(c->log_ready-c->log),&b,1,0))lfs_lazy_config()->log_failed=1;
   lfs_lazy_log("Loader active",0,lfs_lazy_config()->count,0,0);lfs_lazy_log_flush();
  }
  return 0;
 }
 for(uint64_t i=0;i<c->source_count;i++){struct lfs_source *s=&c->sources[i];s->reads=s->bytes=s->errors=s->result=0;}
 for(uint32_t i=0;i<c->count;i++){struct lfs_source *s=&c->view_stats[i];s->reads=s->bytes=s->errors=s->result=0;}
 if(c->codefs)for(uint64_t i=0;i<c->codefs->count;i++){
  const struct ns_group *g=&c->codefs->groups[i];for(uint64_t j=0;j<g->count;j++){struct lfs_source *s=(struct lfs_source *)&g->files[j].observation;s->reads=s->bytes=s->errors=s->result=0;}
 }
 c->unmatched_size=c->unmatched_count=c->identity_mismatches=c->reserved2=0;c->last_error_source=0;
 if(c->log_ready)*c->log_ready='1';
 __atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);lfs_flush();return 0;
}
uint64_t lfs_activate(void){
 struct lfs_context *c=lfs_context();
 if(c->codefs)__atomic_store_n(&c->codefs->enabled,1,__ATOMIC_RELEASE);
 __atomic_store_n(&c->enabled,1,__ATOMIC_RELEASE);
 return lfs_game_observations();
}
