#include "lazy.h"
struct item { struct item *next; struct ns_file file; };
static uint32_t read_file(struct ns_context *c,void *file,uint64_t at,void *bytes,uint64_t length){
 uint64_t count=0;struct ns_buffer buffer={bytes,length};uint32_t result=c->read(file,&count,at,&buffer,length,0);return result?result:count==length?0:0xd401;
}
static uint64_t code_program(void *filesystem,struct ns_context *c,uint64_t requested){
 /* Collections and Switch 2 Editions can request a base mount containing
  * a different subprogram. Preserve the existing NPDM identity resolution,
  * but only on a filesystem returned by Loader OpenCodeFileSystem. */
 void *file=0;struct ns_out out={&file};uint8_t header[128],aci[32];uint64_t program=requested,size=0;
 uint32_t result=c->open_file(filesystem,&out,"/main.npdm",1);
 if(!result&&file){
  result=c->size(file,&size);
  if(!result&&size>=sizeof(header))result=read_file(c,file,0,header,sizeof(header));else result=0xd401;
  if(!result&&lfs_equal(header,"META",4)){
   uint64_t at=*(uint32_t *)(header+0x70);
   if(at>=sizeof(header)&&at<=size&&sizeof(aci)<=size-at&&!read_file(c,file,at,aci,sizeof(aci))&&lfs_equal(aci,"ACI0",4)&&*(uint64_t *)(aci+16))program=*(uint64_t *)(aci+16);
  }
 }
 if(file)c->release(file);
 if(program!=requested)lfs_lazy_log("ExeFS subprogram",program,requested,0,0);
 return program;
}
static struct item *get(struct lfs_arena **arena,struct item **items,const char *name){
 for(struct item *i=*items;i;i=i->next)if(lfs_text_equal(i->file.name,name))return i;
 uint64_t length=lfs_text_length(name);if(!length||length>0x300)return 0;
 struct item *i=lfs_arena_allocate(arena,sizeof(*i)+length+1);if(!i)return 0;
 char *text=(char *)(i+1);lfs_copy(text,name,length+1);i->file.name=text;i->file.observation.path=text;i->next=*items;*items=i;return i;
}
static uint32_t pfs_read(const struct lfs_lazy_file *image,void *file,uint64_t at,void *data,uint64_t size){
 return lfs_source_read_file(file,(struct lfs_source *)&image->source,at,data,size);
}
static uint32_t pfs_entries(struct lfs_arena **arena,struct item **items,const struct lfs_lazy_file *image,void *file){
 uint8_t header[16];uint32_t result=pfs_read(image,file,0,header,16);if(result)return result;
 if(!lfs_equal(header,"PFS0",4))return 0xd401;
 uint64_t count=*(uint32_t *)(header+4),names=*(uint32_t *)(header+8),table=count*24,data_start=16+table+names;
 if(!count||data_start>image->size||table>UINT32_MAX||names>UINT32_MAX)return 0xd401;
 for(uint64_t i=0;i<count;i++){
  uint8_t row[24];result=pfs_read(image,file,16+i*24,row,24);if(result)return result;
  uint64_t offset=*(uint64_t *)row,size=*(uint64_t *)(row+8);uint32_t name_at=*(uint32_t *)(row+16);
  if(offset>image->size-data_start||size>image->size-data_start-offset||name_at>=names)return 0xd401;
  char name[0x301];uint64_t length=names-name_at;if(length>sizeof(name))length=sizeof(name);
  result=pfs_read(image,file,16+table+name_at,name,length);if(result)return result;
  uint64_t n=0;for(;n<length&&name[n];n++)if(name[n]=='/'||name[n]=='\\')return 0xd401;
  if(!n||n==length||lfs_text_equal(name,".")||lfs_text_equal(name,".."))return 0xd401;
  struct item *item=get(arena,items,name);if(!item)return 0xd401;
  item->file.size=size;item->file.source_path=(const char *)&image->source;item->file.offset=data_start+offset;item->file.source_size=image->size;item->file.flags=1;
 }
 return 0;
}
static uint32_t add_pfs(struct lfs_arena **arena,struct item **items,const struct lfs_lazy_file *image){
 struct lfs_context *c=lfs_context();void *file=0;struct ns_out out={&file};
 uint32_t result=c->open_file((uint8_t *)c->source_fs+8,&out,image->source.path,1);
 if(!result)result=file?pfs_entries(arena,items,image,file):0xd401;
 if(file)c->sdk.file_release(file);return result;
}
static const struct ns_group *codefs(void *filesystem,struct ns_context *c,uint64_t program){
 struct lfs_life *existing=lfs_lookup((uint8_t *)filesystem-8,LFS_CODEFS);if(existing)return existing->owner;
 program=code_program(filesystem,c,program);
 uint32_t result=0;
 const struct lfs_lazy_game *game=program?lfs_lazy_game(program):0;
 struct lfs_lazy_config *config=lfs_lazy_config();uint64_t changes=0;
 uint64_t patches=config->patch_count+lfs_lazy_patch_count(game);
 if(game)for(uint64_t i=0;i<game->count;i++)if(game->files[i].kind==LAZY_EXEFS||game->files[i].kind==LAZY_STUB||game->files[i].kind==LAZY_EXEFS_IMAGE)changes++;
 if(!program||(!changes&&!patches)){
  if(program&&!game)lfs_lazy_unconfigured(program,2);
  return 0;
 }
 struct lfs_arena *arena=0;struct item *items=0;void *directory=0;struct ns_out directory_out={&directory};
 result=c->open_directory(filesystem,&directory_out,"/",2);
 if(!result&&!directory)result=0xd401;
 if(!result){
  uint8_t rows[4*0x310];struct ns_buffer buffer={rows,sizeof(rows)};
  for(;;){
   uint64_t count=0;result=lfs_context()->sdk.directory_read(directory,&count,&buffer);if(result||!count)break;
   if(count>4){result=0xd401;break;}
   for(uint64_t i=0;i<count;i++){
    uint8_t *row=rows+i*0x310;uint64_t length=lfs_text_length((const char *)row);
    if(length>0x300||row[0x304]!=1){result=0xd401;break;}
    struct item *item=get(&arena,&items,(const char *)row);if(!item){result=0xd401;break;}
    item->file.size=item->file.source_size=*(uint64_t *)(row+0x308);
   }
   if(result)break;
  }
  lfs_context()->sdk.directory_release(directory);
 }
 if(game&&!result){
  for(uint64_t i=0;i<game->count&&!result;i++)if(game->files[i].kind==LAZY_EXEFS_IMAGE){
   for(struct item *item=items;item;item=item->next)item->file.flags=2;
   result=add_pfs(&arena,&items,&game->files[i]);
  }
  for(uint64_t i=0;i<game->count&&!result;i++){
   const struct lfs_lazy_file *f=&game->files[i];if(f->kind!=LAZY_EXEFS&&f->kind!=LAZY_STUB)continue;
   const char *name=f->name[0]=='/'?f->name+1:f->name;struct item *item=get(&arena,&items,name);if(!item){result=0xd401;break;}
   if(f->kind==LAZY_STUB){if(!(item->file.flags&1))item->file.flags=2;}
   else{item->file.size=f->size;item->file.offset=f->offset;item->file.source_size=f->size+f->offset;item->file.source_path=(const char *)&f->source;item->file.flags=1;}
  }
 }
 /* A global IPS belongs to an NSO Build ID, not to every filesystem opened
  * while it is registered. Probe immutable original headers before deciding
  * to virtualize a namespace or retain any per-file overlay references. */
 if(patches)for(struct item *item=items;item&&!result;item=item->next){
  if(item->file.flags||item->file.size<256)continue;
  char name[0x302];name[0]='/';uint64_t length=lfs_text_length(item->file.name);if(length>0x300){result=0xd401;break;}lfs_copy(name+1,item->file.name,length+1);
  void *original=0;struct ns_out original_out={&original};uint64_t matches=0;
  result=c->open_file(filesystem,&original_out,name,1);
  if(!result)result=original?lfs_lazy_probe_nso(original,&item->file,program,&matches):0xd401;
  if(original)c->release(original);
  if(!result&&matches)item->file.flags=8;
 }
 if(!result){
  int modified=0;for(struct item *item=items;item;item=item->next)if(item->file.flags){modified=1;break;}
  if(!modified){
   lfs_arena_free(arena);
   lfs_lazy_log("ExeFS unchanged",program,0,0,0);lfs_lazy_log_flush();return 0;
  }
 }
 struct ns_group *group=0;
 if(!result){
  uint64_t count=0;for(struct item *item=items;item;item=item->next)count++;
  group=lfs_lazy_plan_allocate(&arena,sizeof(*group)+count*sizeof(struct ns_file));if(!group)result=0xd401;
  else{
   group->program_id=program;group->count=count;struct ns_file *files=(struct ns_file *)(group+1);group->files=files;
   uint64_t i=0;for(struct item *item=items;item;item=item->next)files[i++]=item->file;
   lfs_lazy_plan_finish(group,arena);struct lfs_life *life=lfs_track((uint8_t *)filesystem-8,group,LFS_CODEFS);
   if(life)life->plan_owner=group;else result=0xd401;
  }
 }
 lfs_lazy_log("ExeFS mounted",program,group?group->count:0,result,0);lfs_lazy_log_flush();
 if(result){lfs_arena_free(arena);return 0;}return group;
}
const struct ns_group *lfs_lazy_codefs(void *filesystem,struct ns_context *c,uint64_t program){
 lfs_lazy_plan_lock();const struct ns_group *group=codefs(filesystem,c,program);lfs_lazy_plan_unlock();return group;
}
