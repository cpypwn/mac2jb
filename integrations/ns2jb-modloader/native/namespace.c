#include "namespace.h"
static void add(uint64_t *p,int64_t n){__atomic_fetch_add(p,n,__ATOMIC_RELAXED);}
static int equal(const uint8_t *a,const uint8_t *b,unsigned n){for(unsigned i=0;i<n;i++)if(a[i]!=b[i])return 0;return 1;}
static int read_bytes(struct ns_context *c,void *file,uint64_t offset,void *data,uint64_t size){
 struct ns_buffer b={data,size};uint64_t count=0;
 return !c->read(file,&count,(int64_t)offset,&b,(int64_t)size,0)&&count==size;
}
static const struct ns_group *owner(void *fs,struct ns_context *c){
 if(!c->enabled||fs==c->source_fs)return 0;
 uint8_t npdm[128],main[256];uint64_t id=0,size=0;void *file=0;struct ns_out out={&file};
 if(c->open_file(fs,&out,"/main.npdm",1)||!file)return 0;
 int ok=read_bytes(c,file,0,npdm,128);const struct ns_group *g=0;
 if(ok){
  for(uint64_t i=0;i<c->count;i++){
   const struct ns_group *candidate=&c->groups[i];
   if(!equal(npdm,candidate->npdm_header,128))continue;
   if(!read_bytes(c,file,candidate->program_offset,&id,8)||id!=candidate->program_id)continue;
   g=candidate;break;
  }
 }
 c->release(file);file=0;if(!g)return 0;
 if(c->open_file(fs,&out,"/main",1)||!file)return 0;
 ok=!c->size(file,&size)&&size==g->main_size&&read_bytes(c,file,0,main,256)&&equal(main,g->main_header,256);
 c->release(file);return ok?g:0;
}
static int redirect(char *out,const char *path,const struct ns_group *g){
 if(!path||path[0]!='/')return 0;
 unsigned n=0;for(;n<160&&g->prefix[n];n++)out[n]=g->prefix[n];if(n==160)return 0;
 unsigned component=1;
 for(unsigned i=0;i<0x301;i++){
  char ch=path[i];if(ch=='\\')return 0;
  if(i&&(!ch||ch=='/')){
   unsigned len=i-component;
   if((len==1&&path[component]=='.')||(len==2&&path[component]=='.'&&path[component+1]=='.'))return 0;
   component=i+1;
  }
  if(n>=0x300)return 0;out[n++]=ch;if(!ch)return 1;
 }
 return 0;
}
uint32_t lfs_namespace_open(void *fs,struct ns_out *out,const char *path,uint32_t mode,struct ns_context *c){
 if(!c||c->magic!=0x33465343u)return 0xd401;
 add(&c->active,1);add(&c->calls,1);char target[0x301];const struct ns_group *g=mode==1?owner(fs,c):0;uint32_t result;
 if(g&&redirect(target,path,g)){add(&c->matched,1);result=c->open_file(c->source_fs,out,target,mode);}
 else result=c->open_file(fs,out,path,mode);
 add(&c->active,-1);return result;
}
uint32_t lfs_namespace_directory(void *fs,struct ns_out *out,const char *path,uint32_t mode,struct ns_context *c){
 if(!c||c->magic!=0x33465343u)return 0xd401;
 add(&c->active,1);add(&c->calls,1);char target[0x301];const struct ns_group *g=owner(fs,c);uint32_t result;
 if(g&&redirect(target,path,g)){add(&c->matched,1);result=c->open_directory(c->source_fs,out,target,mode);}
 else result=c->open_directory(fs,out,path,mode);
 add(&c->active,-1);return result;
}
uint32_t lfs_namespace_type(void *fs,uint32_t *out,const char *path,struct ns_context *c){
 if(!c||c->magic!=0x33465343u)return 0xd401;
 add(&c->active,1);add(&c->calls,1);char target[0x301];const struct ns_group *g=owner(fs,c);uint32_t result;
 if(g&&redirect(target,path,g)){add(&c->matched,1);result=c->get_type(c->source_fs,out,target);}
 else result=c->get_type(fs,out,path);
 add(&c->active,-1);return result;
}
