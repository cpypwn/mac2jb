#include "lazy.h"
#include "trace.h"
#define NONE UINT32_MAX
struct input { void *storage; struct lfs_source *source; uint64_t size,header[10]; void *file; };
struct node {
 struct node *next;
 uint32_t parent,record,kind,length,added,changed;
 uint64_t source_offset;
 struct lfs_source *source;
 uint8_t data[];
};
struct bucket { struct bucket *next; uint32_t table,offset,value; };
struct piece { struct piece *next; struct lfs_segment s; };
struct edit { struct edit *next; uint64_t at,size; const void *data; };
struct builder {
 struct lfs_arena *arena;
 struct input original;
 struct node **nodes;
 struct bucket **buckets;
 uint64_t slots,directory_size,file_size,virtual_size,piece_count,program;
 struct piece *pieces;
 struct edit *edits[4];
 uint32_t error,diagnostic_count;
 uint32_t diagnostic_parents[8];
};
static uint64_t align(uint64_t n,uint64_t a){return (n+a-1)&~(a-1);}
static uint32_t input_read(struct input *in,uint64_t at,void *data,uint64_t length){
 if(at>in->size||length>in->size-at)return 0xd401;
 if(in->source)return in->file?lfs_source_read_file(in->file,in->source,at,data,length):lfs_source_read((const char *)in->source,at,data,length);
 struct ns_buffer buffer={data,length};return lfs_trace_original_read((uint8_t *)in->storage+8,at,&buffer,length);
}
static uint32_t input_header(struct input *in){
 uint32_t result=input_read(in,0,in->header,80);if(result)return result;
 if(in->header[0]!=80||in->header[9]>in->size)return 0xd401;
 for(unsigned i=1;i<9;i+=2)if(in->header[i]>in->size||in->header[i+1]>in->size-in->header[i])return 0xd401;
 if(!in->header[2]||in->header[2]%4||!in->header[6]||in->header[6]%4||in->header[4]<24||in->header[4]>=NONE||in->header[8]>=NONE)return 0xd401;
 return 0;
}
static uint32_t hash_name(uint32_t parent,const char *name,uint32_t length){
 uint32_t h=parent^123456789;for(uint32_t i=0;i<length;i++)h=((h>>5)|(h<<27))^(uint8_t)name[i];return h;
}
static void *take(struct builder *b,uint64_t bytes){
 void *memory=b->error?0:lfs_arena_allocate(&b->arena,bytes);if(!memory)b->error=0xd401;return memory;
}
static uint32_t find_original(struct builder *b,uint32_t parent,const char *name,uint32_t length,uint32_t kind,uint8_t *data,uint32_t *record){
 struct input *in=&b->original;unsigned bucket_table=kind?5:1,records=kind?7:3,fixed=kind?32:24;
 uint32_t hash=hash_name(parent,name,length),at;uint64_t offset=(hash%(in->header[bucket_table+1]/4))*4;
 uint32_t result=input_read(in,in->header[bucket_table]+offset,&at,4);if(result)return result;
 uint64_t left=in->header[records+1]/fixed+1;
 while(at!=NONE&&left--){
  if(at>in->header[records+1]||fixed>in->header[records+1]-at)return 0xd401;
  result=input_read(in,in->header[records]+at,data,fixed);if(result)return result;
  uint32_t n=*(uint32_t *)(data+fixed-4);
  if(n>0x300||n>in->header[records+1]-at-fixed)return 0xd401;
  if(*(uint32_t *)data==parent&&n==length){
   char text[0x300];result=input_read(in,in->header[records]+at+fixed,text,n);if(result)return result;
   if(lfs_equal(text,name,n)){*record=at;return 0;}
  }
  at=*(uint32_t *)(data+fixed-8);
 }
 return at==NONE?0x202:0xd401;
}
static struct node *lookup(struct builder *b,uint32_t parent,const char *name,uint32_t length,uint32_t kind,int create){
 uint32_t h=hash_name(parent,name,length);uint64_t slot=(h^(kind*UINT32_C(0x9e3779b9)))&(b->slots-1);
 for(struct node *n=b->nodes[slot];n;n=n->next)if(n->parent==parent&&n->kind==kind&&n->length==length&&lfs_equal(n->data+(kind?32:24),name,length))return n;
 uint8_t data[32];uint32_t record=NONE,result;
 if(!kind&&!parent&&!length){result=input_read(&b->original,b->original.header[3],data,24);record=0;}
 else result=find_original(b,parent,name,length,kind,data,&record);
 if(result&&result!=0x202){b->error=result;return 0;}
 if(result&&!create)return 0;
 struct node *n=take(b,sizeof(*n)+(kind?32:24)+align(length,4));if(!n)return 0;
 n->parent=parent;n->kind=kind;n->length=length;n->record=record;n->added=result!=0;
 if(!result)lfs_copy(n->data,data,kind?32:24);
 lfs_copy(n->data+(kind?32:24),name,length);n->next=b->nodes[slot];b->nodes[slot]=n;
 return n;
}
static uint32_t *bucket_value(struct builder *b,uint32_t table,uint32_t offset){
 uint64_t slot=((uint64_t)offset*0x9e3779b9+table)&(b->slots-1);
 for(struct bucket *p=b->buckets[slot];p;p=p->next)if(p->table==table&&p->offset==offset)return &p->value;
 struct bucket *p=take(b,sizeof(*p));if(!p)return 0;
 p->table=table;p->offset=offset;
 b->error=input_read(&b->original,b->original.header[table]+offset,&p->value,4);if(b->error)return 0;
 p->next=b->buckets[slot];b->buckets[slot]=p;return &p->value;
}
static int insert(struct builder *b,struct node *n,struct node *parent){
 if(!n->added)return 1;
 uint64_t *size=n->kind?&b->file_size:&b->directory_size;uint64_t fixed=n->kind?32:24;
 if(*size>=NONE||align(fixed+n->length,4)>=NONE-*size){b->error=0xd401;return 0;}
 n->record=(uint32_t)*size;*size+=align(fixed+n->length,4);
 unsigned table=n->kind?5:1;uint32_t hash=hash_name(n->parent,(const char *)n->data+fixed,n->length);
 uint32_t *head=bucket_value(b,table,(hash%(b->original.header[table+1]/4))*4);if(!head)return 0;
 *(uint32_t *)n->data=n->parent;
 *(uint32_t *)(n->data+4)=*(uint32_t *)(parent->data+(n->kind?12:8));
 *(uint32_t *)(n->data+fixed-8)=*head;*head=n->record;*(uint32_t *)(n->data+fixed-4)=n->length;
 if(!n->kind){*(uint32_t *)(n->data+8)=NONE;*(uint32_t *)(n->data+12)=NONE;}
 *(uint32_t *)(parent->data+(n->kind?12:8))=n->record;parent->changed=1;n->changed=1;
 return 1;
}
static struct node *path_node(struct builder *b,const char *path,uint32_t kind,int create){
 uint64_t length=lfs_text_length(path);if(!length||length>0x300||path[0]!='/'){b->error=0xd401;return 0;}
 struct node *parent=lookup(b,0,"",0,0,0);if(!parent)return 0;
 if(length==1)return kind?0:parent;
 for(uint32_t at=1;at<length;){
  uint32_t end=at;while(end<length&&path[end]!='/')end++;uint32_t n=end-at;
  if(!n||(n==1&&path[at]=='.')||(n==2&&path[at]=='.'&&path[at+1]=='.')){b->error=0xd401;return 0;}
  uint32_t type=end==length?kind:0;
  struct node *child=lookup(b,parent->record,path+at,n,type,create);
  if(!child)return 0;
  if(child->record==NONE){
   if(lookup(b,parent->record,path+at,n,type^1,0)){b->error=0xd401;return 0;}
   if(b->error||!insert(b,child,parent))return 0;
  }
  parent=child;at=end+1;
 }
 return parent;
}
static void segment(struct builder *b,uint64_t at,uint64_t size,uint64_t offset,const char *source){
 if(!size)return;
 if(at>UINT64_MAX-size){b->error=0xd401;return;}
 struct piece *p=take(b,sizeof(*p));if(!p)return;
 p->s=(struct lfs_segment){at,size,offset,source};p->next=b->pieces;b->pieces=p;b->piece_count++;
}
static void edit(struct builder *b,unsigned table,uint64_t at,uint64_t size,const void *data){
 struct edit *p=take(b,sizeof(*p));if(!p)return;
 p->at=at;p->size=size;p->data=data;p->next=b->edits[table];b->edits[table]=p;
}
static struct edit *sort_edits(struct edit *list){
 if(!list||!list->next)return list;
 struct edit *slow=list,*fast=list->next;while(fast&&fast->next){slow=slow->next;fast=fast->next->next;}
 struct edit *right=slow->next;slow->next=0;list=sort_edits(list);right=sort_edits(right);
 struct edit head={0},*tail=&head;
 while(list&&right){if(list->at<=right->at){tail->next=list;list=list->next;}else{tail->next=right;right=right->next;}tail=tail->next;}
 tail->next=list?list:right;return head.next;
}
static struct piece *sort_pieces(struct piece *list){
 if(!list||!list->next)return list;
 struct piece *slow=list,*fast=list->next;while(fast&&fast->next){slow=slow->next;fast=fast->next->next;}
 struct piece *right=slow->next;slow->next=0;list=sort_pieces(list);right=sort_pieces(right);
 struct piece head={0},*tail=&head;
 while(list&&right){if(list->s.offset<=right->s.offset){tail->next=list;list=list->next;}else{tail->next=right;right=right->next;}tail=tail->next;}
 tail->next=list?list:right;return head.next;
}
static uint32_t image_path(struct input *in,uint32_t record,uint32_t kind,char *path){
 uint64_t end=0x300;path[end]=0;uint8_t header[32];uint64_t limit=in->header[4]/24+1;
 while((kind||record)&&limit--){
  unsigned table=kind?7:3,fixed=kind?32:24;
  if(record>in->header[table+1]||fixed>in->header[table+1]-record)return 0xd401;
  uint32_t result=input_read(in,in->header[table]+record,header,fixed);if(result)return result;
  uint32_t length=*(uint32_t *)(header+fixed-4);
  if(!length||length>=end||length>in->header[table+1]-record-fixed)return 0xd401;
  end-=length;result=input_read(in,in->header[table]+record+fixed,path+end,length);if(result)return result;
  path[--end]='/';record=*(uint32_t *)header;kind=0;
 }
 if(record)return 0xd401;
 if(end==0x300)path[--end]='/';lfs_copy(path,path+end,0x301-end);return 0;
}
static void original_directory(struct builder *b,const char *path,uint64_t program){
 if(!lfs_context()->log_file)return;
 uint64_t length=lfs_text_length(path);if(length<4||path[length-4]!='.'||(path[length-3]!='p'&&path[length-3]!='P')||(path[length-2]!='a'&&path[length-2]!='A')||(path[length-1]!='k'&&path[length-1]!='K'))return;
 char parent_path[0x301];lfs_copy(parent_path,path,length+1);uint64_t end=length;while(end>1&&parent_path[end-1]!='/')end--;parent_path[end>1?end-1:1]=0;
 uint32_t saved_error=b->error;struct node *parent=path_node(b,parent_path,0,0);uint32_t diagnostic_error=b->error;b->error=saved_error;
 if(!parent){if(diagnostic_error)lfs_lazy_log("Original directory diagnostic error",program,0,diagnostic_error,parent_path);return;}
 for(uint32_t i=0;i<b->diagnostic_count;i++)if(b->diagnostic_parents[i]==parent->record)return;
 if(b->diagnostic_count>=8)return;b->diagnostic_parents[b->diagnostic_count++]=parent->record;
 if(parent->added){lfs_lazy_log("Original parent directory absent",program,0,0,parent_path);return;}
 uint8_t directory[24];uint32_t result=input_read(&b->original,b->original.header[3]+parent->record,directory,24);
 if(result){lfs_lazy_log("Original directory diagnostic error",program,0,result,parent_path);return;}
 uint32_t record=*(uint32_t *)(directory+12);unsigned count=0;
 while(record!=NONE&&count++<64){
  uint8_t file[32];if(record>b->original.header[8]||32>b->original.header[8]-record)break;
  result=input_read(&b->original,b->original.header[7]+record,file,32);if(result)break;
  uint32_t n=*(uint32_t *)(file+28);uint64_t prefix=lfs_text_length(parent_path);
  if(!n||n>0x300||n>b->original.header[8]-record-32||prefix+1+n>0x300)break;
  char name[0x301];lfs_copy(name,parent_path,prefix);if(prefix!=1)name[prefix++]='/';
  result=input_read(&b->original,b->original.header[7]+record+32,name+prefix,n);if(result)break;name[prefix+n]=0;
  uint64_t original_offset=*(uint64_t *)(file+8),original_size=*(uint64_t *)(file+16);
  lfs_lazy_log("Original directory file",program,original_size,0,name);
  if(original_offset<=b->original.size-b->original.header[9]&&original_size<=b->original.size-b->original.header[9]-original_offset)
   lfs_lazy_log("Original directory offset",program,b->original.header[9]+original_offset,0,name);
  record=*(uint32_t *)(file+4);
 }
 if(result)lfs_lazy_log("Original directory diagnostic error",program,record,result,parent_path);
 else if(record!=NONE)lfs_lazy_log("Original directory listing bounded",program,count,0,parent_path);
}
static void replace(struct builder *b,const char *path,struct lfs_source *source,uint64_t offset,uint64_t size){
 struct node *n=path_node(b,path,1,1);if(!n){if(!b->error)b->error=0xd401;return;}
 if(n->added)original_directory(b,path,b->program);
 n->source=source;n->source_offset=offset;n->changed=1;*(uint64_t *)(n->data+16)=size;
}
static uint32_t image_entries(struct builder *b,struct input *in){
 uint32_t result=input_header(in);if(result)return result;
 for(unsigned type=0;type<2;type++){
  unsigned table=type?7:3,fixed=type?32:24;
  for(uint64_t at=0;at<in->header[table+1];){
   uint8_t data[32];result=input_read(in,in->header[table]+at,data,fixed);if(result)return result;
   uint32_t length=*(uint32_t *)(data+fixed-4);uint64_t bytes=align(fixed+length,4);
   if(length>0x300||bytes>in->header[table+1]-at)return 0xd401;
   char path[0x301];result=image_path(in,(uint32_t)at,type,path);if(result)return result;
   if(type){
    uint64_t offset=*(uint64_t *)(data+8),size=*(uint64_t *)(data+16);
    if(offset>in->size-in->header[9]||size>in->size-in->header[9]-offset)return 0xd401;
    replace(b,path,in->source,in->header[9]+offset,size);
   }else if(!path_node(b,path,0,1)&&!b->error)b->error=0xd401;
   if(b->error)return b->error;at+=bytes;
  }
 }
 return 0;
}
static uint32_t add_image(struct builder *b,const struct lfs_lazy_file *file){
 struct input in={.source=(struct lfs_source *)&file->source,.size=file->size};struct lfs_context *c=lfs_context();struct ns_out out={&in.file};
 uint32_t result=c->open_file((uint8_t *)c->source_fs+8,&out,file->source.path,1);
 if(!result)result=in.file?image_entries(b,&in):0xd401;
 if(in.file)c->sdk.file_release(in.file);return result;
}
static uint32_t attach_storage(void *storage,uint64_t program){
 const struct lfs_lazy_game *game=lfs_lazy_game(program);if(!game){lfs_lazy_unconfigured(program,1);return 0;}if(lfs_lookup(storage,LFS_STORAGE))return 0;
 uint64_t relevant=0;for(uint64_t i=0;i<game->count;i++)if(game->files[i].kind<=LAZY_ROMFS||game->files[i].kind==LAZY_ROMFS_IMAGE)relevant++;
 if(!relevant)return 0;
 struct builder b={.original={.storage=storage},.slots=16,.program=program};
 uint32_t result=lfs_context()->original_size(storage,&b.original.size);if(result){lfs_lazy_log("RomFS original size",program,0,result,0);lfs_lazy_log_flush();return result;}
 result=input_header(&b.original);if(result){lfs_lazy_log("RomFS original header",program,b.original.size,result,0);lfs_lazy_log_flush();return result;}
 lfs_lazy_log("RomFS storage object",program,(uintptr_t)storage,0,0);
 while(b.slots<game->count*2){if(b.slots>UINT64_MAX/2)return 0xd401;b.slots*=2;}
 b.nodes=take(&b,b.slots*sizeof(*b.nodes));b.buckets=take(&b,b.slots*sizeof(*b.buckets));
 struct lfs_view *view=lfs_lazy_plan_allocate(&b.arena,sizeof(*view));if(!view)b.error=0xd401;
 b.directory_size=b.original.header[4];b.file_size=b.original.header[8];b.virtual_size=align(b.original.size,4096);
 if(!b.error){
  for(uint64_t i=0;i<game->count&&!b.error;i++)if(game->files[i].kind==LAZY_ROMFS_IMAGE)b.error=add_image(&b,&game->files[i]);
  for(uint64_t i=0;i<game->count&&!b.error;i++){
   const struct lfs_lazy_file *f=&game->files[i];
   if(f->kind==LAZY_DIRECTORY){if(!path_node(&b,f->name,0,1)&&!b.error)b.error=0xd401;}
   else if(f->kind==LAZY_ROMFS)replace(&b,f->name,(struct lfs_source *)&f->source,f->offset,f->size);
  }
 }
 uint64_t *header=b.error?0:take(&b,80);if(header)lfs_copy(header,b.original.header,80);
 int added=b.directory_size!=b.original.header[4]||b.file_size!=b.original.header[8];
 for(uint64_t i=0;i<b.slots&&!b.error;i++)for(struct node *n=b.nodes[i];n;n=n->next)if(n->kind&&n->source){
  uint64_t size=*(uint64_t *)(n->data+16),offset=align(b.virtual_size,16);
  if(offset<b.virtual_size||size>UINT64_MAX-offset){b.error=0xd401;break;}
  *(uint64_t *)(n->data+8)=offset-b.original.header[9];b.virtual_size=offset+size;
  segment(&b,offset,size,n->source_offset,(const char *)n->source);
 }
 for(uint64_t i=0;i<b.slots&&!b.error;i++){
  for(struct node *n=b.nodes[i];n;n=n->next)if(n->changed){
   if(added)edit(&b,n->kind?3:1,n->record,n->added?align((n->kind?32:24)+n->length,4):(n->kind?32:24),n->data);
   else if(n->kind)segment(&b,b.original.header[7]+n->record+8,16,(uintptr_t)(n->data+8),(const char *)1);
  }
  if(added)for(struct bucket *p=b.buckets[i];p;p=p->next)edit(&b,p->table==1?0:2,p->offset,4,&p->value);
 }
 if(added&&!b.error){
  b.virtual_size=align(b.virtual_size,4096);
  for(unsigned table=0;table<4&&!b.error;table++){
   unsigned index=1+table*2;uint64_t original_size=b.original.header[index+1],size=table==1?b.directory_size:table==3?b.file_size:original_size;
   uint64_t start=align(b.virtual_size,16),cursor=0;
   if(start<b.virtual_size||size>UINT64_MAX-start){b.error=0xd401;break;}
   for(struct edit *e=sort_edits(b.edits[table]);e;e=e->next){
    if(e->at<cursor||e->at>size||e->size>size-e->at){b.error=0xd401;break;}
    if(e->at>cursor){if(e->at>original_size){b.error=0xd401;break;}segment(&b,start+cursor,e->at-cursor,b.original.header[index]+cursor,(const char *)2);}
    segment(&b,start+e->at,e->size,(uintptr_t)e->data,(const char *)1);cursor=e->at+e->size;
   }
   if(cursor<size){if(size>original_size)b.error=0xd401;else segment(&b,start+cursor,size-cursor,b.original.header[index]+cursor,(const char *)2);}
   header[index]=start;header[index+1]=size;b.virtual_size=start+size;
  }
  segment(&b,0,80,(uintptr_t)header,(const char *)1);
 }
 if(!b.error){
  if(b.piece_count>UINT32_MAX)b.error=0xd401;
  else{
   struct lfs_segment *segments=b.piece_count?take(&b,b.piece_count*sizeof(*segments)):0;uint64_t i=0,end=0;
   if(segments)for(struct piece *p=sort_pieces(b.pieces);p;p=p->next){
    if(p->s.offset<end){b.error=0xd401;break;}segments[i++]=p->s;end=p->s.offset+p->s.length;
   }
   if(!b.error){view->original_size=b.original.size;view->size=b.virtual_size;view->count=(uint32_t)b.piece_count;view->segments=segments;lfs_copy(view->header,b.original.header,80);}
  }
 }
 if(!b.error){
  lfs_lazy_plan_finish(view,b.arena);struct lfs_life *life=lfs_track(storage,view,LFS_STORAGE);
  if(life)life->plan_owner=view;else b.error=0xd401;
 }
 lfs_lazy_log("RomFS mounted",program,b.original.size,b.error,0);
 if(!b.error)lfs_lazy_log("RomFS virtual size",program,b.virtual_size,0,0);
 if(!b.error)for(uint64_t i=0;i<b.slots;i++)for(struct node *n=b.nodes[i];n;n=n->next)if(n->kind&&n->source)lfs_lazy_log(n->added?"RomFS added":"RomFS replaced",program,*(uint64_t *)(n->data+16),0,n->source->path);
 lfs_lazy_log_flush();
 if(b.error)lfs_arena_free(b.arena);return b.error;
}
uint32_t lfs_lazy_attach_storage(void *storage,uint64_t program){
 uint64_t trace=lfs_lazy_game(program)?lfs_trace_begin(LFS_T_PREPARE,storage,0,program,0):0;
 lfs_lazy_plan_lock();uint32_t result=attach_storage(storage,program);lfs_lazy_plan_unlock();lfs_trace_end(trace,result,program,0,0);if(trace)lfs_trace_checkpoint(1);return result;
}
