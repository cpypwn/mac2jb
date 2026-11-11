#include "namespace.h"

struct capture {
 void *object;
 ns_open_fn open_directory;
 ns_directory_read_fn read_directory;
 ns_ref_fn release_directory;
 ns_open_fn open_file;
 ns_read_fn read_file;
 ns_ref_fn release_file;
 uint32_t (*read_storage)(void *,int64_t,const struct ns_buffer *,int64_t);
 void *(*allocate)(uint64_t);
 void (*free)(void *,uint64_t);
 uint8_t *data;
 uint64_t bytes,capacity,count;
 uint32_t result,reserved;
 uint64_t storage_size;
};
_Static_assert(offsetof(struct capture,data)==80,"Capture output ABI");
_Static_assert(sizeof(struct capture)==128,"Capture ABI");
static void copy_bytes(void *to,const void *from,uint64_t n){
 for(uint64_t i=0;i<n;i++)((uint8_t *)to)[i]=((const uint8_t *)from)[i];
}
static int reserve(struct capture *c,uint64_t bytes){
 if(bytes<=c->capacity)return 1;
 uint64_t capacity=c->capacity?c->capacity:0x10000;
 while(capacity<bytes){if(capacity>UINT64_MAX/2)return 0;capacity*=2;}
 uint8_t *data=c->allocate(capacity);if(!data)return 0;
 copy_bytes(data,c->data,c->bytes);if(c->data)c->free(c->data,c->capacity);
 c->data=data;c->capacity=capacity;return 1;
}
static uint32_t read_range(struct capture *c,uint64_t at,uint8_t *data,uint64_t length){
 while(length){
  uint64_t n=length>0x100000?0x100000:length;struct ns_buffer b={data,n};
  uint32_t result=c->read_storage(c->object,at,&b,n);if(result)return result;
  at+=n;data+=n;length-=n;
 }
 return 0;
}
uint64_t lfs_capture_romfs(struct capture *c){
 if(!c||c->data||c->bytes||c->capacity||c->count||c->storage_size<80||c->storage_size>INT64_MAX)return 0xd401;
 uint64_t header[10];uint32_t result=read_range(c,0,(uint8_t *)header,80);
 if(result)goto done;
 if(header[0]!=80||header[4]<24||header[4]>0x4000000||header[8]>0x4000000-header[4]||header[9]<80||header[9]>c->storage_size){result=0xd401;goto done;}
 for(unsigned i=1;i<9;i+=2){
  if(header[i]<80||header[i]>c->storage_size||header[i+1]>0x4000000||header[i+1]>c->storage_size-header[i]){result=0xd401;goto done;}
  for(unsigned j=1;j<i;j+=2)if(header[i]<header[j]+header[j+1]&&header[j]<header[i]+header[i+1]){result=0xd401;goto done;}
 }
 c->capacity=80+header[4]+header[8];c->data=c->allocate(c->capacity);
 if(!c->data){c->capacity=0;result=0xd401;goto done;}
 copy_bytes(c->data,header,80);c->bytes=80;
 result=read_range(c,header[3],c->data+80,header[4]);if(result)goto done;
 c->bytes+=header[4];result=read_range(c,header[7],c->data+c->bytes,header[8]);if(result)goto done;
 c->bytes+=header[8];c->count=3;
 done:c->result=result;return result;
}
uint64_t lfs_capture_codefs(struct capture *c){
 if(!c||c->data||c->bytes||c->capacity||c->count)return 0xd401;
 uint8_t *buffer=c->allocate(32*0x310);if(!buffer)return c->result=0xd401;
 void *directory=0,*file=0;struct ns_out out={&directory};
 uint32_t result=c->open_directory(c->object,&out,"/",3);if(result)goto done;
 if(!directory){result=0xd401;goto done;}
 for(;;){
  uint64_t count=0;struct ns_buffer b={buffer,32*0x310};result=c->read_directory(directory,&count,&b);
  if(result)break;
  if(count>32){result=0xd401;break;}
  if(!count)break;
  for(uint64_t i=0;i<count;i++){
   const uint8_t *entry=buffer+i*0x310;uint64_t n=0;
   while(n<0x301&&entry[n])n++;
   if(!n||n>=0x300||entry[0x304]!=1){result=0xd401;break;}
   char path[0x301];path[0]='/';
   for(uint64_t j=0;j<n;j++){if(entry[j]=='/'||entry[j]=='\\'){result=0xd401;break;}path[j+1]=(char)entry[j];}
   if(result)break;
   path[n+1]=0;
   uint64_t size=*(const uint64_t *)(entry+0x308),length=size<256?size:256,read=0;
   uint8_t header[256];out.value=&file;result=c->open_file(c->object,&out,path,1);if(result)break;
   if(!file){result=0xd401;break;}
   if(length){b.data=header;b.capacity=sizeof(header);result=c->read_file(file,&read,0,&b,length,0);if(!result&&read!=length)result=0xd401;}
   c->release_file(file);file=0;if(result)break;
   uint64_t name_end=(16+n+1+7)&~UINT64_C(7),row_size=(name_end+length+7)&~UINT64_C(7);
   if(c->bytes>UINT64_MAX-row_size||!reserve(c,c->bytes+row_size)){result=0xd401;break;}
   uint8_t *row=c->data+c->bytes;lfs_zero(row,row_size);*(uint64_t *)row=size;*(uint32_t *)(row+8)=(uint32_t)n;*(uint32_t *)(row+12)=(uint32_t)length;
   copy_bytes(row+16,entry,n);copy_bytes(row+name_end,header,length);c->bytes+=row_size;c->count++;
  }
  if(result)break;
 }
 done:
 if(file)c->release_file(file);
 if(directory)c->release_directory(directory);
 c->free(buffer,32*0x310);c->result=result;return result;
}
