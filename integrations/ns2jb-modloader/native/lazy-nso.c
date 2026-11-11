#include "lazy.h"
struct patch { struct patch *next; uint64_t at,size; const uint8_t *data; uint32_t repeat,reserved; };
struct segment { uint64_t file,address,size,packed,virtual_at,virtual_size; };
struct decoder {
 uint64_t position,cursor,input_begin,input_size,literals,matches;
 uint32_t segment,phase,distance,token;
 uint8_t dictionary[0x10000],input[0x10000];
 void *zbic;
};
struct nso {
 struct lfs_arena *arena;
 struct patch *patches;
 const struct ns_file *file;
 void *object;
 struct decoder *decoder;
 uint64_t size,name_at,name_size,virtual_name;
 uint32_t flags,lock,error,reserved;
 struct segment segments[3];
 uint8_t header[256];
};
void *lfs_zbic_create(void);
void lfs_zbic_release(void *);
uint32_t lfs_zbic_read(void *,void *,uint32_t (*)(void *,uint64_t,void *,uint64_t),uint64_t,uint64_t,uint64_t,uint64_t,void *,uint64_t);
static uint64_t u32(const void *memory){const uint8_t *b=memory;return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static uint64_t be(const uint8_t *p,unsigned n){uint64_t value=0;for(unsigned i=0;i<n;i++)value=(value<<8)|p[i];return value;}
static uint32_t read_raw(struct nso *n,uint64_t at,void *data,uint64_t size){
 if(at>n->file->size||size>n->file->size-at)return 0xd401;
 struct ns_buffer buffer={data,size};uint64_t count=0;uint32_t result=lfs_context()->sdk.file_read(n->object,&count,n->file->offset+at,&buffer,size,0);
 return result?result:count==size?0:0xd401;
}
static uint32_t zbic_input(void *n,uint64_t at,void *data,uint64_t size){return read_raw(n,at,data,size);}
static int matching(const char *path,const uint8_t *build){
 const char *base=path;for(uint64_t i=0;path[i];i++)if(path[i]=='/')base=path+i+1;
 unsigned digits=0;while(base[digits]&&base[digits]!='.')digits++;
 if(!digits||digits>64||(digits&1))return 0;
 for(unsigned i=0;i<32;i++){
  unsigned value=0;
  for(unsigned j=0;j<2;j++)if(i*2+j<digits){
   char c=base[i*2+j];unsigned v=c>='0'&&c<='9'?(unsigned)(c-'0'):c>='a'&&c<='f'?(unsigned)(c-'a'+10):c>='A'&&c<='F'?(unsigned)(c-'A'+10):16;
   if(v>15)return 0;value=(value<<4)|v;
  }else value<<=4;
  if(value!=build[i])return 0;
 }
 const char *ext=base+digits;
 return ext[0]=='.'&&(ext[1]|32)=='i'&&(ext[2]|32)=='p'&&(ext[3]|32)=='s'&&(!ext[4]||(ext[4]=='3'&&ext[5]=='2'&&!ext[6]));
}
static uint32_t parse(struct nso *n,const struct lfs_lazy_file *file){
 if(file->size<8||file->size>SIZE_MAX)return 0xd401;
 const uint8_t *data;
 if(file->kind==LAZY_INLINE_PATCH){if(!file->offset)return 0xd401;data=(const uint8_t *)(uintptr_t)file->offset;}
 else{
  uint8_t *copy=lfs_arena_allocate(&n->arena,file->size);if(!copy)return 0xd401;
  uint32_t result=lfs_source_read((const char *)&file->source,file->offset,copy,file->size);if(result)return result;data=copy;
 }
 unsigned width=lfs_equal(data,"IPS32",5)?4:3;
 if(width==3&&!lfs_equal(data,"PATCH",5))return 0xd401;
 uint64_t at=5;
 for(;;){
  if(at>file->size||width>file->size-at)return 0xd401;
  if(lfs_equal(data+at,width==4?"EEOF":"EOF",width)){at+=width;return at==file->size||file->size-at==width?0:0xd401;}
  uint64_t offset=be(data+at,width);at+=width;
  if(file->size-at<2)return 0xd401;
  uint64_t length=be(data+at,2);at+=2;uint32_t repeated=0;const uint8_t *bytes=data+at;
  if(length){if(length>file->size-at)return 0xd401;at+=length;}
  else{if(file->size-at<3)return 0xd401;length=be(data+at,2);bytes=data+at+2;at+=3;repeated=1;if(!length)continue;}
  if(offset+length<=256)continue;
  if(offset<256){uint64_t skip=256-offset;offset=256;length-=skip;if(!repeated)bytes+=skip;}
  struct patch *p=lfs_arena_allocate(&n->arena,sizeof(*p));if(!p)return 0xd401;
  p->at=offset-256;p->size=length;p->data=bytes;p->repeat=repeated;p->next=n->patches;n->patches=p;
 }
}
static uint32_t initialize(struct nso *n){
 uint32_t result=read_raw(n,0,n->header,256);if(result)return result;
 if(!lfs_equal(n->header,"NSO0",4))return 0xd401;
 n->flags=(uint32_t)u32(n->header+12);n->name_at=u32(n->header+0x1c);n->name_size=u32(n->header+0x2c);
 if(n->name_size&&(n->name_at<256||n->name_at>n->file->size||n->name_size>n->file->size-n->name_at))return 0xd401;
 for(unsigned i=0;i<3;i++){
  struct segment *s=&n->segments[i];unsigned at=16+i*16;
  s->file=u32(n->header+at);s->address=u32(n->header+at+4);s->size=s->virtual_size=u32(n->header+at+8);s->packed=(n->flags&(1u<<i))?u32(n->header+0x60+i*4):s->size;
  if(s->file>n->file->size||s->packed>n->file->size-s->file||(s->size&&s->file<256)||(i&&n->segments[i-1].address+n->segments[i-1].size>s->address))return 0xd401;
 }
 /* IPS writes are ordered: a later record overwrites an earlier record.
  * Keep that order across matching patch files, including overlapping RLE. */
 struct patch *head=0;
 for(struct patch *p=n->patches;p;){struct patch *next=p->next;p->next=head;head=p;p=next;}
 n->patches=head;
 for(struct patch *p=head;p;p=p->next){
  uint64_t cursor=p->at,end=p->at+p->size;
  while(cursor<end){
   int which=-1;
   for(unsigned i=0;i<3;i++){
    struct segment *s=&n->segments[i];uint64_t limit=i<2?n->segments[i+1].address:s->address+s->size+u32(n->header+0x3c);
    if(cursor>=s->address&&cursor<limit){which=(int)i;uint64_t stop=end<limit?end:limit,needed=stop-s->address;if(needed>s->virtual_size)s->virtual_size=needed;cursor=stop;break;}
   }
   if(which<0)return 0xd401;
  }
 }
 n->size=256;
 for(unsigned i=0;i<3;i++){
  struct segment *s=&n->segments[i];s->virtual_at=(n->size+15)&~UINT64_C(15);
  if(s->virtual_at>UINT32_MAX||s->virtual_size>UINT32_MAX||s->virtual_size>UINT32_MAX-s->virtual_at)return 0xd401;
  *(uint32_t *)(n->header+16+i*16)=(uint32_t)s->virtual_at;*(uint32_t *)(n->header+24+i*16)=(uint32_t)s->virtual_size;*(uint32_t *)(n->header+0x60+i*4)=(uint32_t)s->virtual_size;n->size=s->virtual_at+s->virtual_size;
 }
 uint64_t growth=n->segments[2].virtual_size-n->segments[2].size,bss=u32(n->header+0x3c);if(growth>bss)return 0xd401;
 *(uint32_t *)(n->header+0x3c)=(uint32_t)(bss-growth);
 n->virtual_name=n->size;if(n->name_size){if(n->size>UINT32_MAX)return 0xd401;*(uint32_t *)(n->header+0x1c)=(uint32_t)n->size;n->size+=n->name_size;}else *(uint32_t *)(n->header+0x1c)=0;
 /* NSO supports uncompressed segments and optional segment hashes. The virtual
  * file is decoded during Read, patched in mapped-memory coordinates, and
  * never materialized as another executable on SD. */
 *(uint32_t *)(n->header+12)=n->flags&~UINT32_C(0xbf);
 return 0;
}
uint64_t lfs_lazy_patch_count(const struct lfs_lazy_game *game){
 uint64_t count=0;if(game)for(uint64_t i=0;i<game->count;i++)if(game->files[i].kind==LAZY_PATCH||game->files[i].kind==LAZY_INLINE_PATCH)count++;return count;
}
static uint32_t probe_nso(void *object,const struct ns_file *file,uint64_t program,const struct lfs_lazy_game *game,uint64_t *matches,int report,uint8_t *identity){
 *matches=0;struct lfs_lazy_config *config=lfs_lazy_config();if((!config->patch_count&&!lfs_lazy_patch_count(game))||file->size<256)return 0;
 struct nso initial={.file=file,.object=object};uint8_t header[256];uint32_t result=read_raw(&initial,0,header,256);if(result)return result;
 if(!lfs_equal(header,"NSO0",4))return 0;
 if(identity)lfs_copy(identity,header+0x40,32);
 if(game)for(uint64_t i=0;i<game->count;i++)if((game->files[i].kind==LAZY_PATCH||game->files[i].kind==LAZY_INLINE_PATCH)&&matching(game->files[i].name,header+0x40))(*matches)++;
 for(uint64_t i=0;i<config->patch_count;i++)if(matching(config->patches[i].name,header+0x40))(*matches)++;
 /* Build ID is recorded even when every supplied patch belongs to another
  * game version. This makes an inactive patch visible in the normal report. */
 char build[65];static const char hex[]="0123456789abcdef";for(unsigned i=0;i<32;i++){build[i*2]=hex[header[0x40+i]>>4];build[i*2+1]=hex[header[0x40+i]&15];}build[64]=0;
 if(report){lfs_lazy_log("NSO file",program,file->size,0,file->name);lfs_lazy_log("NSO Build ID",program,*matches,0,build);}
 if(!*matches&&report)lfs_lazy_log_flush();return 0;
}
uint32_t lfs_lazy_probe_nso(void *object,const struct ns_file *file,uint64_t program,uint64_t *matches){
 return probe_nso(object,file,program,lfs_lazy_game(program),matches,1,0);
}
static uint32_t patch_file(void *object,struct lfs_life *life,const struct ns_file *file,const struct lfs_lazy_game *game,int report){
 struct lfs_lazy_config *config=lfs_lazy_config();const struct ns_group *owner=life->plan_owner;
 uint8_t identity[32];uint64_t matches=0;uint32_t result=probe_nso(object,file,owner?owner->program_id:0,game,&matches,report,identity);if(result||!matches)return result;
 struct lfs_arena *arena=0;struct nso *n=lfs_arena_allocate(&arena,sizeof(*n));if(!n){lfs_arena_free(arena);return 0xd401;}
 n->arena=arena;n->file=file;n->object=object;
 /* Match the prepared JS path's order: title-scoped patches first, then
  * global patchsets. A later record wins, independent of storage layout. */
 if(game)for(uint64_t i=0;i<game->count&&!result;i++)if((game->files[i].kind==LAZY_PATCH||game->files[i].kind==LAZY_INLINE_PATCH)&&matching(game->files[i].name,identity)){
  result=parse(n,&game->files[i]);if(report)lfs_lazy_log("IPS matched",owner?owner->program_id:0,game->files[i].size,result,game->files[i].source.path);
 }
 for(uint64_t i=0;i<config->patch_count&&!result;i++)if(matching(config->patches[i].name,identity)){
  result=parse(n,&config->patches[i]);if(report)lfs_lazy_log("IPS matched",owner?owner->program_id:0,config->patches[i].size,result,config->patches[i].source.path);
 }
 if(!result)result=initialize(n);
 if(!result)life->stream=n;else{lfs_lazy_log("IPS preparation error",owner?owner->program_id:0,file->size,result,file->name);lfs_arena_free(n->arena);}
 if(report||result)lfs_lazy_log_flush();return result;
}
uint32_t lfs_lazy_patch_file(void *object,struct lfs_life *life,const struct ns_file *file,const struct lfs_lazy_game *game){
 return patch_file(object,life,file,game,1);
}
uint32_t lfs_lazy_directory_size(void *filesystem,const struct ns_file *file,const struct ns_group *group,uint64_t *size){
 *size=file->size;if(!file->flags||file->size<256)return 0;
 struct ns_context *c=lfs_context()->codefs;char name[0x302];name[0]='/';uint64_t length=lfs_text_length(file->name);if(length>0x300)return 0xd401;lfs_copy(name+1,file->name,length+1);
 void *object=0;struct ns_out out={&object};
 uint32_t result=file->source_path?c->open_file(c->source_fs,&out,((const struct lfs_source *)file->source_path)->path,1):c->open_file(filesystem,&out,name,1);
 if(!result&&!object)result=0xd401;
 if(!result){
  struct lfs_life temporary={.plan_owner=group};result=patch_file(object,&temporary,file,lfs_lazy_game(group->program_id),0);
  if(temporary.stream){if(!result)*size=((const struct nso *)temporary.stream)->size;lfs_lazy_stream_release(temporary.stream);}
  c->release(object);
 }
 return result;
}
static uint32_t next_byte(struct nso *n,uint8_t *value){
 struct decoder *d=n->decoder;struct segment *s=&n->segments[d->segment];
 if(d->cursor>=s->packed)return 0xd401;
 if(d->cursor<d->input_begin||d->cursor>=d->input_begin+d->input_size){
  uint64_t size=s->packed-d->cursor;if(size>sizeof(d->input))size=sizeof(d->input);
  uint32_t result=read_raw(n,s->file+d->cursor,d->input,size);if(result)return result;
  d->input_begin=d->cursor;d->input_size=size;
 }
 *value=d->input[d->cursor++-d->input_begin];return 0;
}
static uint32_t extra(struct nso *n,uint64_t *length){
 uint8_t value;do{uint32_t result=next_byte(n,&value);if(result)return result;if(*length>UINT64_MAX-value)return 0xd401;*length+=value;}while(value==255);return 0;
}
static uint32_t decoded_byte(struct nso *n,uint8_t *value){
 struct decoder *d=n->decoder;struct segment *s=&n->segments[d->segment];uint32_t result;
 if(d->position>=s->size)return 0xd401;
 for(;;){
  if(d->literals){result=next_byte(n,value);if(result)return result;d->literals--;break;}
  if(d->matches){if(!d->distance||d->distance>d->position)return 0xd401;*value=d->dictionary[(d->position-d->distance)&0xffff];d->matches--;break;}
  if(!d->phase){
   uint8_t token;result=next_byte(n,&token);if(result)return result;d->token=token;d->literals=token>>4;
   if(d->literals==15){result=extra(n,&d->literals);if(result)return result;}
   if(d->literals>s->size-d->position)return 0xd401;d->phase=1;
  }else{
   uint8_t lo,hi;result=next_byte(n,&lo);if(result)return result;result=next_byte(n,&hi);if(result)return result;
   d->distance=(uint32_t)lo|(uint32_t)hi<<8;d->matches=d->token&15;
   if(d->matches==15){result=extra(n,&d->matches);if(result)return result;}d->matches+=4;
   if(d->matches>s->size-d->position)return 0xd401;d->phase=0;
  }
 }
 d->dictionary[d->position++&0xffff]=*value;return 0;
}
static uint32_t segment_read(struct nso *n,unsigned index,uint64_t at,void *data,uint64_t length){
 struct segment *s=&n->segments[index];uint64_t original=at<s->size?s->size-at:0;if(original>length)original=length;
 if(original){
  if(!(n->flags&(1u<<index))){uint32_t result=read_raw(n,s->file+at,data,original);if(result)return result;}
  else{
   if(!n->decoder){n->decoder=lfs_system_allocate(sizeof(*n->decoder));if(!n->decoder)return 0xd401;lfs_zero(n->decoder,sizeof(*n->decoder));n->decoder->segment=UINT32_MAX;}
   struct decoder *d=n->decoder;
   if(d->segment!=index||at<d->position){if(d->zbic)lfs_zbic_release(d->zbic);lfs_zero(d,sizeof(*d));d->segment=index;}
   if(n->flags&0x80){
    if(!d->zbic){d->zbic=lfs_zbic_create();if(!d->zbic)return 0xd401;}
    uint32_t result=lfs_zbic_read(d->zbic,n,zbic_input,s->file,s->packed,s->size,at,data,original);if(result)return result;d->position=at+original;
   }else{
    uint8_t ignored;while(d->position<at){uint32_t result=decoded_byte(n,&ignored);if(result)return result;}
    for(uint64_t i=0;i<original;i++){uint32_t result=decoded_byte(n,(uint8_t *)data+i);if(result)return result;}
   }
  }
 }
 lfs_zero((uint8_t *)data+original,length-original);
 uint64_t start=s->address+at,end=start+length;
 for(const struct patch *p=n->patches;p;p=p->next){
  uint64_t lo=p->at>start?p->at:start,hi=p->at+p->size<end?p->at+p->size:end;
  if(hi>lo){if(p->repeat){for(uint64_t i=lo;i<hi;i++)((uint8_t *)data)[i-start]=p->data[0];}else lfs_copy((uint8_t *)data+lo-start,p->data+lo-p->at,hi-lo);}
 }
 return 0;
}
uint32_t lfs_lazy_nso_read(struct lfs_life *life,uint64_t *read,int64_t at,const struct ns_buffer *buffer,int64_t length,uint32_t option){
 (void)option;struct nso *n=life->stream;
 if(at<0||length<0||(uint64_t)length>buffer->capacity||(uint64_t)at>n->size)return 0xd401;
 uint64_t amount=n->size-(uint64_t)at;if(amount>(uint64_t)length)amount=(uint64_t)length;
 lfs_mutex_lock(&n->lock);
 uint64_t cursor=(uint64_t)at,end=cursor+amount;uint32_t result=0;
 while(cursor<end&&!result){
  uint8_t *out=(uint8_t *)buffer->data+cursor-(uint64_t)at;
  if(cursor<256){uint64_t stop=end<256?end:256;lfs_copy(out,n->header+cursor,stop-cursor);cursor=stop;continue;}
  if(n->name_size&&cursor>=n->virtual_name){result=read_raw(n,n->name_at+cursor-n->virtual_name,out,end-cursor);cursor=end;continue;}
  int selected=-1;uint64_t next=end;
  for(unsigned i=0;i<3;i++){
   struct segment *s=&n->segments[i];if(cursor>=s->virtual_at&&cursor<s->virtual_at+s->virtual_size){selected=(int)i;next=s->virtual_at+s->virtual_size;if(next>end)next=end;break;}
   if(s->virtual_at>cursor&&s->virtual_at<next)next=s->virtual_at;
  }
  if(selected<0)lfs_zero(out,next-cursor);else result=segment_read(n,(unsigned)selected,cursor-n->segments[selected].virtual_at,out,next-cursor);
  cursor=next;
 }
 if(!result)*read=amount;
 if(!result&&amount&&!n->reserved){n->reserved=1;lfs_lazy_log("IPS first read",0,amount,0,n->file->name);lfs_lazy_log_flush();}
 if(result&&!n->error){n->error=result;lfs_lazy_log("IPS read error",0,(uint64_t)at,result,n->file->name);lfs_lazy_log_flush();}
 lfs_mutex_unlock(&n->lock);return result;
}
uint32_t lfs_lazy_nso_size(struct lfs_life *life,uint64_t *size){*size=((const struct nso *)life->stream)->size;return 0;}
void lfs_lazy_stream_release(void *stream){
 struct nso *n=stream;struct lfs_arena *arena=n->arena;
 if(n->decoder){if(n->decoder->zbic)lfs_zbic_release(n->decoder->zbic);lfs_system_free(n->decoder);}lfs_arena_free(arena);
}
