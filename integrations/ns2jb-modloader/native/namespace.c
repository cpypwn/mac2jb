#include "namespace.h"
#include "lazy.h"
#include "trace.h"
static void add(uint64_t *p,int64_t n){ __atomic_fetch_add(p,n,__ATOMIC_RELAXED); }
static int equal_name(const char *a,const char *b){
 for(unsigned i=0;i<0x301;i++){if(a[i]!=b[i])return 0;if(!a[i])return 1;}return 0;
}
static const struct ns_file *entry(const struct ns_group *g,const char *path){
 if(!path||path[0]!='/'||!path[1])return 0;
 for(uint64_t i=0;i<g->count;i++)if(equal_name(path+1,g->files[i].name))return &g->files[i];
 return 0;
}
static int interesting(struct ns_context *c,const char *path){
 if(!c->enabled||!path)return 0;
 if(lfs_lazy_config())return 1;
 for(uint64_t i=0;i<c->count;i++){const struct ns_file *f=entry(&c->groups[i],path);if(f&&f->flags)return 1;}
 return 0;
}
static int read_bytes(struct ns_context *c,void *file,uint64_t offset,void *data,uint64_t size){
 struct ns_buffer b={data,size};uint64_t count=0;
 return !c->read(file,&count,(int64_t)offset,&b,(int64_t)size,0)&&count==size;
}
static const struct ns_group *owner(void *fs,struct ns_context *c){
 if(!c->enabled||fs==c->source_fs)return 0;
 struct lfs_life *n=lfs_lookup((uint8_t *)fs-8,LFS_CODEFS);return n?n->owner:0;
}
/* Only the qualified Loader OpenCodeFileSystem result enters discovery.
 * Generic FS callbacks must not open main.npdm, enumerate an unrelated
 * filesystem or retain a negative-cache reference to an account's data. */
static const struct ns_group *register_owner(void *fs,uint64_t program,struct ns_context *c){
 if(!c->enabled||fs==c->source_fs)return 0;
 struct lfs_life *n=lfs_lookup((uint8_t *)fs-8,LFS_CODEFS);if(n)return n->owner;
 if(lfs_lazy_config())return lfs_lazy_codefs(fs,c,program);
 uint8_t npdm[128],main[256];uint64_t id=0,size=0;void *file=0;struct ns_out out={&file};
 if(c->open_file(fs,&out,"/main.npdm",1)||!file)return 0;
 int ok=read_bytes(c,file,0,npdm,128);const struct ns_group *g=0;
 if(ok)for(uint64_t i=0;i<c->count;i++){
  const struct ns_group *candidate=&c->groups[i];
  if(!lfs_equal(npdm,candidate->npdm_header,128))continue;
  if(!read_bytes(c,file,candidate->program_offset,&id,8)||id!=candidate->program_id)continue;
  g=candidate;break;
 }
 c->release(file);file=0;if(!g)return 0;
 if(c->open_file(fs,&out,"/main",1)||!file)return 0;
 ok=!c->size(file,&size)&&size==g->main_size&&read_bytes(c,file,0,main,256)&&lfs_equal(main,g->main_header,256);
 c->release(file);if(!ok)return 0;
 lfs_track((uint8_t *)fs-8,g,LFS_CODEFS);return g;
}
void lfs_namespace_register(void *fs,uint64_t program){
 struct ns_context *c=lfs_context()->codefs;
 if(c&&c->magic==0x34465343u&&c->enabled&&fs){
  uint64_t trace=lfs_trace_begin(LFS_T_CODEFS_PREPARE,(uint8_t *)fs-8,0,program,0);
  const struct ns_group *g=register_owner(fs,program,c);
  lfs_trace_end(trace,0,g?g->program_id:0,0,0);
 }
}
uint32_t lfs_namespace_mount(void *root,struct ns_out *out,const void *verification,uint32_t attributes,uint64_t program,uint32_t storage){
 /* The six arguments and the shared-output indirection are the qualified
  * native Loader ABI. Verification output and original failures pass through. */
 uint64_t trace=lfs_trace_begin(LFS_T_CODEFS_MOUNT,root,0,program,((uint64_t)storage<<32)|attributes);
 uint32_t result=lfs_codefs_original()(root,out,verification,attributes,program,storage);
 void *object=!result&&out&&out->value?*out->value:0;
 if(object)lfs_namespace_register((uint8_t *)object+8,program);
 lfs_trace_end(trace,result,(uintptr_t)object,0,0);return result;
}
static uint32_t slice_read(void *object,uint64_t *read,int64_t offset,const struct ns_buffer *buffer,int64_t length,uint32_t option){
 struct lfs_life *n=lfs_lookup(object,LFS_SLICE);if(!n)return 0xd401;
 if(n->stream)return lfs_lazy_nso_read(n,read,offset,buffer,length,option);
 const struct ns_file *file=n->owner;
 if(offset<0||length<0||(uint64_t)offset>file->size||(uint64_t)length>buffer->capacity)return 0xd401;
 uint64_t amount=file->size-(uint64_t)offset;if(amount>(uint64_t)length)amount=(uint64_t)length;
 if(file->count){
  uint64_t end=(uint64_t)offset+amount,lo=0,hi=file->count,done=0;
  while(lo<hi){uint64_t mid=lo+(hi-lo)/2;const struct lfs_segment *s=&file->segments[mid];if(s->offset+s->length<=(uint64_t)offset)lo=mid+1;else hi=mid;}
  for(uint64_t i=lo;i<file->count&&file->segments[i].offset<end;i++){
   const struct lfs_segment *s=&file->segments[i];uint64_t start=s->offset>(uint64_t)offset?s->offset:(uint64_t)offset,stop=s->offset+s->length<end?s->offset+s->length:end;
   if(stop<=start)continue;
   struct ns_buffer b={(uint8_t *)buffer->data+start-(uint64_t)offset,stop-start};uint32_t result;
   if(s->source_path)result=lfs_source_read(s->source_path,s->source_offset+start-s->offset,b.data,b.capacity);
   else{uint64_t count=0;result=lfs_context()->sdk.file_read(object,&count,file->offset+s->source_offset+start-s->offset,&b,b.capacity,option);if(!result&&count!=b.capacity)result=0xd401;}
   if(result){lfs_note((struct lfs_source *)&file->observation,0,result);return result;}done+=b.capacity;
  }
  *read=done;uint32_t result=done==amount?0:0xd401;lfs_note((struct lfs_source *)&file->observation,result?0:done,result);return result;
 }
 uint32_t result=lfs_context()->sdk.file_read(object,read,(uint64_t)offset+file->offset,buffer,amount,option);lfs_note((struct lfs_source *)&file->observation,result?0:*read,result);return result;
}
static uint32_t slice_size(void *object,uint64_t *size){
 struct lfs_life *n=lfs_lookup(object,LFS_SLICE);if(!n)return 0xd401;
 if(n->stream)return lfs_lazy_nso_size(n,size);
 *size=((const struct ns_file *)n->owner)->size;return 0;
}
static uint64_t file_count(const struct lfs_life *n){
 const struct ns_group *g=n->owner;uint64_t count=0;
 if(n->mode&2)for(uint64_t i=0;i<g->count;i++)if(!(g->files[i].flags&2))count++;
 return count;
}
static uint32_t directory_count(void *object,uint64_t *count){
 struct lfs_life *n=lfs_lookup(object,LFS_DIRECTORY);if(!n)return 0xd401;
 *count=file_count(n);return 0;
}
static uint32_t directory_read(void *object,uint64_t *read,const struct ns_buffer *buffer){
 struct lfs_life *n=lfs_lookup(object,LFS_DIRECTORY);if(!n)return 0xd401;
 const struct ns_group *g=n->owner;uint64_t capacity=buffer->capacity/0x310,count=0;
 if(n->mode&2)while(count<capacity){
  uint64_t slot=__atomic_load_n(&n->cursor,__ATOMIC_RELAXED);if(slot>=g->count)break;
  if(!__atomic_compare_exchange_n(&n->cursor,&slot,slot+1,0,__ATOMIC_RELAXED,__ATOMIC_RELAXED))continue;
  const struct ns_file *file=&g->files[slot];if(file->flags&2)continue;
  uint8_t *row=(uint8_t *)buffer->data+count*0x310;lfs_zero(row,0x310);
  for(unsigned i=0;i<0x300&&file->name[i];i++)row[i]=(uint8_t)file->name[i];
  row[0x304]=1;
  if(!(n->mode&0x80000000u)){
   uint64_t size=file->size;
   if(n->filesystem){uint32_t result=lfs_lazy_directory_size((uint8_t *)n->filesystem+8,file,g,&size);if(result)return result;}
   *(uint64_t *)(row+0x308)=size;
  }
  count++;
 }
 *read=count;return 0;
}
uint32_t lfs_file_read(void *object,uint64_t *read,int64_t offset,const struct ns_buffer *buffer,int64_t length,uint32_t option){
 if(lfs_lookup(object,LFS_SLICE))return slice_read(object,read,offset,buffer,length,option);
 return lfs_context()->sdk.file_read(object,read,offset,buffer,length,option);
}
uint32_t lfs_file_size(void *object,uint64_t *size){
 if(lfs_lookup(object,LFS_SLICE))return slice_size(object,size);
 return lfs_context()->sdk.file_size(object,size);
}
uint32_t lfs_directory_read(void *object,uint64_t *read,const struct ns_buffer *buffer){
 if(lfs_lookup(object,LFS_DIRECTORY))return directory_read(object,read,buffer);
 return lfs_context()->sdk.directory_read(object,read,buffer);
}
uint32_t lfs_directory_count(void *object,uint64_t *count){
 if(lfs_lookup(object,LFS_DIRECTORY))return directory_count(object,count);
 return lfs_context()->sdk.directory_count(object,count);
}
uint32_t lfs_namespace_open(void *fs,struct ns_out *out,const char *path,uint32_t mode,struct ns_context *c){
 if(!c||c->magic!=0x34465343u)return 0xd401;
 add(&c->active,1);add(&c->calls,1);uint32_t result;
 const struct ns_group *g=mode==1&&interesting(c,path)?owner(fs,c):0;
 const struct ns_file *file=g?entry(g,path):0;
 if(!file||!file->flags)result=c->open_file(fs,out,path,mode);
 else if(file->flags&2){add(&c->matched,1);result=0x202;}
 else{
  add(&c->matched,1);result=file->source_path?c->open_file(c->source_fs,out,((const struct lfs_source *)file->source_path)->path,mode):c->open_file(fs,out,path,mode);
  if(!result&&(lfs_lazy_config()||file->source_path||file->count||file->offset||file->size!=file->source_size)){
   void *object=*out->value;struct lfs_life *n=lfs_track(object,file,LFS_SLICE);
   if(!n){c->release(object);*out->value=0;result=0xd401;}
   else if(lfs_lazy_config()){
    n->plan_owner=g;lfs_lazy_owner_retain(g);
    result=lfs_lazy_patch_file(object,n,file,lfs_lazy_game(g->program_id));
    if(result){lfs_file_release(object);*out->value=0;}
   }
  }
  if(result){add(&c->errors,1);lfs_note((struct lfs_source *)&file->observation,0,result);}
 }
 add(&c->active,-1);return result;
}
uint32_t lfs_namespace_directory(void *fs,struct ns_out *out,const char *path,uint32_t mode,struct ns_context *c){
 if(!c||c->magic!=0x34465343u)return 0xd401;
 add(&c->active,1);add(&c->calls,1);
 const struct ns_group *g=path&&equal_name(path,"/")?owner(fs,c):0;
 uint32_t result=c->open_directory(fs,out,path,mode);
 if(g&&!result){
  void *object=*out->value;struct lfs_life *n=lfs_track(object,g,LFS_DIRECTORY);
  if(!n){((ns_ref_fn)(*(void ***)object)[1])(object);*out->value=0;result=0xd401;add(&c->errors,1);}
  else{n->mode=mode;if(lfs_lazy_config()){
   n->plan_owner=g;lfs_lazy_owner_retain(g);
   if(lfs_lazy_config()->patch_count||lfs_lazy_patch_count(lfs_lazy_game(g->program_id))){n->filesystem=(uint8_t *)fs-8;((ns_ref_fn)(*(void ***)n->filesystem)[0])(n->filesystem);}
  }add(&c->matched,1);}
 }
 add(&c->active,-1);return result;
}
uint32_t lfs_namespace_type(void *fs,uint32_t *out,const char *path,struct ns_context *c){
 if(!c||c->magic!=0x34465343u)return 0xd401;
 add(&c->active,1);add(&c->calls,1);uint32_t result;
 const struct ns_group *g=interesting(c,path)?owner(fs,c):0;const struct ns_file *file=g?entry(g,path):0;
 if(!file||!file->flags)result=c->get_type(fs,out,path);
 else{add(&c->matched,1);result=file->flags&2?0x202:0;if(!result)*out=1;}
 add(&c->active,-1);return result;
}
uint64_t lfs_initialize(void){
 struct lfs_context *c=lfs_context();
 c->reserved2=0;
 if(c->log_file)((ns_ref_fn)(*(void ***)c->log_file)[0])(c->log_file);
 struct lfs_lazy_config *a=lfs_lazy_config();
 if(a&&a->trace&&a->trace->file)((ns_ref_fn)(*(void ***)a->trace->file)[0])(a->trace->file);
 if(a&&c->log_file&&a->set_log_size(c->log_file,a->log_cursor))a->log_failed=1;
 ((ns_ref_fn)(*(void ***)c->source_fs)[0])(c->source_fs);return 0;
}
