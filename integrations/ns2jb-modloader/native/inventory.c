#include "namespace.h"

struct inventory {
 void *fs;
 ns_open_fn open;
 ns_directory_read_fn read;
 ns_ref_fn release;
 void *(*allocate)(uint64_t);
 void (*free)(void *,uint64_t);
 const char *root;
 uint8_t *data;
 uint64_t bytes,capacity,count;
 uint32_t error,reserved;
 char error_path[0x300];
 void *memory_manager;
 uint32_t (*allocate_block)(void *,void **,uint64_t);
 uint32_t (*free_block)(void *,void *,uint64_t);
};
_Static_assert(offsetof(struct inventory,data)==56,"Inventory buffer ABI");
_Static_assert(offsetof(struct inventory,error_path)==96,"Inventory error ABI");
_Static_assert(sizeof(struct inventory)==888,"Inventory ABI");

static void *inventory_allocate(struct inventory *a,uint64_t size){
 if(!a->allocate_block||size<0x100000)return a->allocate(size);
 if(size>UINT64_MAX-0x1010)return 0;
 uint64_t bytes=(size+16+4095)&~UINT64_C(4095);void *memory=0;
 if(a->allocate_block(a->memory_manager,&memory,bytes)||!memory)return 0;
 *(uint64_t *)memory=bytes;return (uint8_t *)memory+16;
}
static void inventory_free(struct inventory *a,void *memory,uint64_t size){
 if(a->allocate_block&&size>=0x100000){void *block=(uint8_t *)memory-16;a->free_block(a->memory_manager,block,*(uint64_t *)block);}
 else a->free(memory,size);
}
uint64_t lfs_inventory_release(struct inventory *a){
 if(a->data){inventory_free(a,a->data,a->capacity);a->data=0;a->bytes=a->capacity=a->count=0;}return 0;
}

static uint64_t text_length(const char *s){
 for(uint64_t n=0;n<0x301;n++)if(!s[n])return n;
 return 0x301;
}
static void copy_bytes(void *destination,const void *source,uint64_t size){
 uint8_t *to=destination;const uint8_t *from=source;
 for(uint64_t i=0;i<size;i++)to[i]=from[i];
}
static uint32_t fail(struct inventory *a,uint32_t result,const char *path){
 a->error=result;
 uint64_t n=text_length(path);if(n>=sizeof(a->error_path))n=sizeof(a->error_path)-1;
 copy_bytes(a->error_path,path,n);a->error_path[n]=0;return result;
}
static int append(struct inventory *a,const char *path,uint8_t type,uint8_t root,uint64_t size){
 uint64_t n=text_length(path),length=(16+n+1+7)&~UINT64_C(7);
 if(n>=0x301||a->bytes>UINT64_MAX-length)return 0;
 if(a->bytes+length>a->capacity){
  uint64_t capacity=a->capacity?a->capacity:0x10000;
  while(capacity<a->bytes+length){if(capacity>UINT64_MAX/2)return 0;capacity*=2;}
  uint8_t *data=inventory_allocate(a,capacity);if(!data)return 0;
  copy_bytes(data,a->data,a->bytes);
  if(a->data)inventory_free(a,a->data,a->capacity);
  a->data=data;a->capacity=capacity;
 }
 uint8_t *row=a->data+a->bytes;lfs_zero(row,length);
 *(uint32_t *)row=(uint32_t)n;row[4]=type;row[5]=root;*(uint64_t *)(row+8)=size;
 copy_bytes(row+16,path,n);a->bytes+=length;a->count++;return 1;
}

// The output also serves as the directory queue. Only one SDK directory and
// one small read buffer are open while the console walks the complete tree.
uint64_t lfs_inventory(struct inventory *a){
 if(!a||a->data||a->bytes||a->capacity||a->count)return 0xd401;
 char current[0x301],child[0x301];uint64_t root_length=text_length(a->root);
 if(root_length+15>=sizeof(current))return fail(a,0xd401,a->root);
 copy_bytes(current,a->root,root_length);copy_bytes(current+root_length,"/contents",10);
 if(!append(a,current,0,1,0))return fail(a,0xd401,current);
 copy_bytes(current+root_length,"/exefs_patches",15);
 if(!append(a,current,0,1,0))return fail(a,0xd401,current);
 uint8_t *buffer=a->allocate(32*0x310);if(!buffer)return fail(a,0xd401,a->root);
 void *directory=0;uint32_t result=0;
 for(uint64_t cursor=0;cursor<a->bytes;){
  uint8_t *row=a->data+cursor;uint32_t length=*(uint32_t *)row;uint64_t next=cursor+((16+(uint64_t)length+1+7)&~UINT64_C(7));
  if(row[4]){cursor=next;continue;}
  uint8_t is_root=row[5];copy_bytes(current,row+16,(uint64_t)length+1);
  struct ns_out out={&directory};result=a->open(a->fs,&out,current,3);
  if(result){if(is_root&&(result&0x3fffff)==0x202){a->data[cursor+4]=2;result=0;cursor=next;continue;}break;}
  if(!directory){result=0xd401;break;}
  for(;;){
   uint64_t count=0;struct ns_buffer b={buffer,32*0x310};result=a->read(directory,&count,&b);
   if(result)break;
   if(count>32){result=0xd401;break;}
   if(!count)break;
   for(uint64_t i=0;i<count;i++){
    const uint8_t *entry=buffer+i*0x310;uint64_t name=text_length((const char *)entry);
    if(!name||name>=0x301||length+1+name>=sizeof(child)||entry[0x304]>1){result=0xd401;break;}
    for(uint64_t j=0;j<name;j++)if(entry[j]=='/'||entry[j]=='\\'){result=0xd401;break;}
    if(result)break;
    if((name==1&&entry[0]=='.')||(name==2&&entry[0]=='.'&&entry[1]=='.')){result=0xd401;break;}
    copy_bytes(child,current,length);child[length]='/';copy_bytes(child+length+1,entry,name);child[length+1+name]=0;
    if(!append(a,child,entry[0x304],0,*(const uint64_t *)(entry+0x308))){result=0xd401;break;}
   }
   if(result)break;
  }
  a->release(directory);directory=0;if(result)break;cursor=next;
 }
 if(directory)a->release(directory);
 a->free(buffer,32*0x310);
 return result?fail(a,result,current):0;
}
