/* Host regression checks for the on-mount reader. Build and run:
 * cc -pthread -I native native/verify-lazy.c native/{romfs,namespace,diagnostics,trace,lazy,lazy-romfs,lazy-codefs,lazy-nso}.c -o /tmp/verify-lazy
 * /tmp/verify-lazy
 * Add -fsanitize=address,undefined for allocation and bounds checks. */
#include "lazy.h"
#include "trace.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <pthread.h>
#include <sched.h>

struct object {void **vt; uint64_t pad[2];uint32_t refs,kind;uint64_t cursor;uint8_t *data;uint64_t size;const char *name;uint64_t reserved[8];};
struct input {const char *path;uint8_t *data;uint64_t size;};
static struct lfs_context context;
static struct ns_context ns;
static struct lfs_lazy_config lazy;
static struct input inputs[20];static unsigned input_count;
static struct object *source,*gamefs;
static void *vt[16];
static uint64_t blocks,block_bytes,objects,fail_at,allocations,source_opens;
static uint64_t writes,flushes,log_end;static uint32_t write_error;
static uint64_t storage_reads,storage_bytes;static uint32_t storage_error;
static uint8_t npdm[192];
static void (*native_probe)(void);
static uint64_t trace_writes,progress_writes;static uint32_t progress_write_error;static uint32_t trace_write_error;
static struct input codefiles[12];static unsigned codecount;
static uint64_t code_mount_args[6];static uint32_t code_mount_result;
extern uint64_t lfs_activate(void);
extern uint32_t lfs_file_read(void *,uint64_t *,int64_t,const struct ns_buffer *,int64_t,uint32_t);
extern uint32_t lfs_file_size(void *,uint64_t *);
extern void lfs_storage_release(void *);
extern void lfs_filesystem_release(void *);
extern void lfs_directory_release(void *);
extern uint32_t lfs_directory_read(void *,uint64_t *,const struct ns_buffer *);
struct lfs_context *lfs_context(void){return &context;}
struct lfs_lazy_config *lfs_lazy_config(void){return &lazy;}
static uint32_t code_mount(void *root,struct ns_out *out,const void *verification,uint32_t attr,uint64_t program,uint32_t storage){
 code_mount_args[0]=(uintptr_t)root;code_mount_args[1]=(uintptr_t)out;code_mount_args[2]=(uintptr_t)verification;code_mount_args[3]=attr;code_mount_args[4]=program;code_mount_args[5]=storage;
 if(verification)((uint8_t *)((const struct ns_buffer *)verification)->data)[0]=0x7e;
 *out->value=code_mount_result?0:gamefs;return code_mount_result;
}
ns_code_open_fn lfs_codefs_original(void){return code_mount;}
#ifndef QA_REAL_ZBIC
void *lfs_zbic_create(void){return 0;}
void lfs_zbic_release(void *s){(void)s;}
uint32_t lfs_zbic_read(void *s,void *n,uint32_t (*read)(void *,uint64_t,void *,uint64_t),uint64_t o,uint64_t p,uint64_t z,uint64_t a,void *d,uint64_t l){(void)s;(void)n;(void)read;(void)o;(void)p;(void)z;(void)a;(void)d;(void)l;return 0xd401;}
#endif
static uint32_t allocate_block(void *manager,void **out,uint64_t bytes){if(native_probe)native_probe();(void)manager;if(fail_at&&++allocations==fail_at)return 0xd401;*out=calloc(1,bytes);if(!*out)return 0xd401;blocks++;block_bytes+=bytes;return 0;}
static uint32_t free_block(void *manager,void *memory,uint64_t bytes){if(native_probe)native_probe();(void)manager;assert(memory&&blocks&&bytes<=block_bytes);blocks--;block_bytes-=bytes;free(memory);return 0;}
static void *allocate(uint64_t bytes){return calloc(1,bytes);}
static void sdk_free(void *memory,uint64_t bytes){(void)bytes;free(memory);}
static void retain(void *memory){if(native_probe)native_probe();struct object *o=memory;assert(o->vt==vt&&o->refs);o->refs++;}
static void release(void *memory){if(native_probe)native_probe();struct object *o=memory;assert(o->vt==vt&&o->refs);if(!--o->refs){objects--;free(o);}}
static struct object *object(uint32_t kind,uint8_t *data,uint64_t size){struct object *o=calloc(1,sizeof(*o));assert(o);o->vt=vt;o->refs=1;o->kind=kind;o->data=data;o->size=size;objects++;return o;}
static uint32_t file_read(void *memory,uint64_t *count,int64_t offset,const struct ns_buffer *buffer,int64_t size,uint32_t options){(void)options;struct object *o=memory;assert(o->refs);if(offset<0||size<0||(uint64_t)offset>o->size||(uint64_t)size>buffer->capacity)return 0xd401;uint64_t n=o->size-(uint64_t)offset;if(n>(uint64_t)size)n=(uint64_t)size;if(!o->data&&o->size>UINT32_MAX){for(uint64_t i=0;i<n;i++)((uint8_t *)buffer->data)[i]=(uint8_t)(((uint64_t)offset+i)%251);}else memcpy(buffer->data,o->data+offset,n);*count=n;return 0;}
static uint32_t storage_read(void *memory,int64_t offset,const struct ns_buffer *buffer,int64_t size){storage_reads++;storage_bytes+=(uint64_t)size;if(storage_error)return storage_error;struct object *o=(void *)((uint8_t *)memory-8);uint64_t count;uint32_t r=file_read(o,&count,offset,buffer,size,0);return r?r:count==(uint64_t)size?0:0xd401;}
static uint32_t file_size(void *memory,uint64_t *size){*size=((struct object *)memory)->size;return 0;}
static uint32_t open_file(void *memory,struct ns_out *out,const char *name,uint32_t mode){if(native_probe)native_probe();assert(mode==1||mode==3);struct object *fs=(void *)((uint8_t *)memory-8);*out->value=0;struct input *list=fs==source?inputs:codefiles;unsigned n=fs==source?input_count:codecount;for(unsigned i=0;i<n;i++)if(!strcmp(name,list[i].path)){*out->value=object(1,list[i].data,list[i].size);((struct object *)*out->value)->name=list[i].path;if(fs==source)source_opens++;return 0;}return 0x202;}
static uint32_t open_directory(void *memory,struct ns_out *out,const char *name,uint32_t mode){(void)memory;(void)mode;assert(!strcmp(name,"/"));*out->value=object(2,0,0);return 0;}
static uint32_t directory_read(void *memory,uint64_t *count,const struct ns_buffer *buffer){struct object *o=memory;uint64_t capacity=buffer->capacity/0x310,n=0;while(n<capacity&&o->cursor<codecount){struct input *entry=&codefiles[o->cursor++];uint8_t *row=(uint8_t *)buffer->data+n++*0x310;memset(row,0,0x310);strcpy((char *)row,entry->path+1);row[0x304]=1;*(uint64_t *)(row+0x308)=entry->size;}*count=n;return 0;}
static uint32_t type(void *memory,uint32_t *out,const char *name){void *file=0;struct ns_out p={&file};uint32_t r=open_file(memory,&p,name,1);if(!r){*out=1;release(file);}return r;}
static void setup(void){assert(!blocks&&!block_bytes&&!objects);source_opens=input_count=codecount=0;storage_reads=storage_bytes=storage_error=0;fail_at=allocations=0;writes=flushes=write_error=0;log_end=100;memset(&context,0,sizeof(context));memset(&ns,0,sizeof(ns));memset(&lazy,0,sizeof(lazy));memset(vt,0,sizeof(vt));vt[0]=retain;vt[1]=release;context.enabled=ns.enabled=1;ns.magic=0x34465343;context.allocate=allocate;context.free=sdk_free;context.original_read=storage_read;context.original_size=file_size;context.read=file_read;context.open_file=open_file;context.codefs=&ns;context.sdk=(struct lfs_sdk){file_read,file_size,release,release,release,directory_read,file_size,release};ns.open_file=open_file;ns.open_directory=open_directory;ns.get_type=type;ns.read=file_read;ns.size=file_size;ns.release=release;lazy.allocate_block=allocate_block;lazy.free_block=free_block;source=object(3,0,0);gamefs=object(3,0,0);context.source_fs=source;ns.source_fs=(uint8_t *)source+8;}
static void cleanup(void){release(source);release(gamefs);struct lfs_life *next;for(struct lfs_life *life=context.objects;life;life=next){assert(!life->active);next=life->next;free(life);}assert(!blocks&&!block_bytes&&!objects);}
static void failure_test(void){setup();memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=0x0100000000000000;codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codecount=1;uint8_t malformed[16]={0};inputs[0]=(struct input){"/sd/image",malformed,sizeof(malformed)};input_count=1;struct lfs_lazy_file image={.name="exefs.nsp",.source={.path="/sd/image"},.size=sizeof(malformed),.kind=LAZY_EXEFS_IMAGE};struct lfs_lazy_game game={0x0100000000000000,1,&image};lazy.count=1;lazy.games=&game;lfs_namespace_register((uint8_t *)gamefs+8,game.program_id);for(unsigned i=0;i<20;i++){uint32_t value;assert(!lfs_namespace_type((uint8_t *)gamefs+8,&value,"/main.npdm",&ns)&&value==1);}assert(source_opens==1);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);cleanup();fprintf(stderr,"malformed ExeFS is reported once and does not repeat preparation: passed\n");}

static uint32_t log_write(void *file,int64_t at,const struct ns_buffer *buffer,int64_t size,uint32_t mode){(void)mode;struct object *o=file;if(o->name&&strstr(o->name,".trace")){if(at>=LFS_TRACE_PAGE*2){progress_writes++;if(progress_write_error)return progress_write_error;}else trace_writes++;if(trace_write_error)return trace_write_error;assert(at>=0&&size>=0&&(uint64_t)size<=buffer->capacity&&(uint64_t)at<=o->size&&(uint64_t)size<=o->size-at);memcpy(o->data+at,buffer->data,size);return 0;}writes++;if(write_error)return write_error;assert((uint64_t)at==log_end||(size==1&&context.log_ready&&at==context.log_ready-context.log));if((uint64_t)at==log_end)log_end+=(uint64_t)size;assert(at>=0&&size>=0&&(uint64_t)size<=buffer->capacity&&(uint64_t)at<=o->size&&(uint64_t)size<=o->size-at);memcpy(o->data+at,buffer->data,size);return 0;}
static uint32_t log_flush(void *file){(void)file;flushes++;return 0;}
static void logs(void){setup();uint8_t *data=calloc(1,1024*1024),*buffer=malloc(0x4000);context.log_file=object(1,data,1024*1024);context.write=log_write;context.flush=log_flush;lazy.log_buffer=buffer;lazy.log_limit=1024*1024;lazy.log_cursor=100;
 for(unsigned i=0;i<20000;i++)lfs_lazy_log("RomFS mounted",i,25,0,"/path/file");lfs_lazy_log_flush();assert(lazy.log_cursor<=1024*1024-4096&&writes<100);lfs_lazy_log("First native error",1,0,0x1234,"/path/failure");lfs_lazy_log_flush();assert(strstr((char *)data+100,"00001234 /path/failure"));uint64_t old=writes;for(unsigned i=0;i<10000;i++)lfs_lazy_log("Late event",i,0,0,"/full");lfs_lazy_log_flush();assert(writes==old);lazy.log_cursor=100;write_error=0x55;lfs_lazy_log("One failed flush",1,1,0,0);lfs_lazy_log_flush();assert(lazy.log_failed);old=writes;for(unsigned i=0;i<10000;i++){lfs_lazy_log("Disabled logger",i,0,0,0);lfs_lazy_log_flush();}assert(writes==old);release(context.log_file);context.log_file=0;free(data);free(buffer);cleanup();fprintf(stderr,"bounded logs and disabled-on-write-error: passed\n");}
static void codefs_test(void){
 for(unsigned image=0;image<2;image++){
 setup();uint8_t original[4]={1,2,3,4},replacement[4]={8,7,6,5},extra[5]={9,8,7,6,5};memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=0x0100000000000000;
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",original,4};codefiles[2]=(struct input){"/sdk",original,4};codefiles[3]=(struct input){"/subsdk1",original,4};codecount=4;uint8_t pfs[512]={0};const char names[]="main\0main.npdm\0subsdk7\0";unsigned start=16+72+sizeof(names);memcpy(pfs,"PFS0",4);*(uint32_t *)(pfs+4)=3;*(uint32_t *)(pfs+8)=sizeof(names);memcpy(pfs+88,names,sizeof(names));unsigned offsets[3]={0,4,4+sizeof(npdm)},sizes[3]={4,sizeof(npdm),5},name_at[3]={0,5,15};for(unsigned i=0;i<3;i++){*(uint64_t *)(pfs+16+i*24)=offsets[i];*(uint64_t *)(pfs+24+i*24)=sizes[i];*(uint32_t *)(pfs+32+i*24)=name_at[i];}memcpy(pfs+start,replacement,4);memcpy(pfs+start+4,npdm,sizeof(npdm));memcpy(pfs+start+4+sizeof(npdm),extra,5);
 inputs[0]=(struct input){"/sd/main",replacement,4};inputs[1]=(struct input){"/sd/image",pfs,start+4+sizeof(npdm)+5};input_count=2;struct lfs_lazy_file mods[3]={{.name="/main",.source={.path="/sd/main"},.size=4,.kind=LAZY_EXEFS},{.name="sdk",.kind=LAZY_STUB},{.name="exefs.nsp",.source={.path="/sd/image"},.size=inputs[1].size,.kind=LAZY_EXEFS_IMAGE}};struct lfs_lazy_game game={0x0100000000000000, image?1:2,image?mods+2:mods};lazy.games=&game;lazy.count=1;lfs_namespace_register((uint8_t *)gamefs+8,game.program_id);
 void *file=0;struct ns_out out={&file};assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));uint8_t data[16];struct ns_buffer b={data,sizeof(data)};uint64_t count;assert(!lfs_file_read(file,&count,0,&b,16,0)&&count==4&&!memcmp(data,replacement,4));lfs_file_release(file);uint32_t t;assert(lfs_namespace_type((uint8_t *)gamefs+8,&t,"/sdk",&ns)==0x202);void *directory=0;out.value=&directory;assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));uint8_t rows[4*0x310];b=(struct ns_buffer){rows,sizeof(rows)};assert(!lfs_directory_read(directory,&count,&b)&&count==3);for(uint64_t i=0;i<count;i++)assert(strcmp((char *)rows+i*0x310,"sdk"));lfs_directory_release(directory);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);assert(!blocks);cleanup();}
 fprintf(stderr,"native ExeFS replacement, stub and PFS0 namespace: passed\n");
}

static void unrelated_filesystem_native(void){
 /* Matching executable names/metadata on an ordinary FS must never opt it
  * into code overlays or retain a negative-cache reference. */
 setup();uint8_t original[]={1,2,3,4},replacement[]={8,7,6,5};
 memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=UINT64_C(0x0400c3f00006e000);
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",original,sizeof(original)};codecount=2;
 inputs[0]=(struct input){"/sd/main",replacement,sizeof(replacement)};input_count=1;
 struct lfs_lazy_file mod={.name="main",.source={.path="/sd/main"},.size=sizeof(replacement),.kind=LAZY_EXEFS};
 struct lfs_lazy_game game={UINT64_C(0x0400c3f00006e000),1,&mod};lazy.games=&game;lazy.count=1;
 for(unsigned i=0;i<100;i++){
  void *file=0;struct ns_out out={&file};assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));
  uint8_t bytes[4];uint64_t count;struct ns_buffer b={bytes,sizeof(bytes)};
  assert(!lfs_file_read(file,&count,0,&b,sizeof(bytes),0)&&count==sizeof(bytes)&&!memcmp(bytes,original,sizeof(bytes)));
  assert(!lfs_lookup(file,LFS_SLICE)&&gamefs->refs==1&&!lfs_lookup(gamefs,LFS_CODEFS));lfs_file_release(file);
  uint32_t t;assert(!lfs_namespace_type((uint8_t *)gamefs+8,&t,"/main",&ns)&&t==1);
  void *dir=0;out.value=&dir;assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));assert(!lfs_lookup(dir,LFS_DIRECTORY));lfs_directory_release(dir);
  assert(!blocks&&!source_opens&&gamefs->refs==1&&!context.objects);
 }
 cleanup();fprintf(stderr,"unrelated filesystem with matching NPDM/program/name: native bytes, directory, ownership and zero mod reads: passed\n");
}
static void codefs_factory_contract(void){
 setup();void *out_value=0;struct ns_out out={&out_value};uint8_t bytes[8]={0};struct ns_buffer verification={bytes,sizeof(bytes)};
 const uint64_t program=UINT64_C(0x04006e001823c001);void *root=(void *)(uintptr_t)UINT64_C(0x123456788000);
 code_mount_result=0;
 assert(!lfs_namespace_mount(root,&out,&verification,13,program,5)&&out_value==gamefs&&bytes[0]==0x7e);
 const uint64_t expected[]={(uintptr_t)root,(uintptr_t)&out,(uintptr_t)&verification,13,program,5};
 assert(!memcmp(code_mount_args,expected,sizeof(expected))&&!context.objects&&gamefs->refs==1);
 out_value=0;code_mount_result=0x1234;assert(lfs_namespace_mount(root,&out,&verification,13,program,5)==0x1234&&!out_value&&!context.objects);
 code_mount_result=0;ns.enabled=0;assert(!lfs_namespace_mount(root,&out,&verification,13,program,5)&&out_value==gamefs&&!context.objects);
 cleanup();fprintf(stderr,"CodeFS factory six-argument ABI, verification output, original failure and inactive namespace forwarding: passed\n");
}
static void repeated_codefs_lifetime(void){
 setup();uint8_t original[]={1,2,3,4},replacement[]={9,7,5,3};
 memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=UINT64_C(0x04006e001823c001);
 codefiles[0]=(struct input){"/main",original,sizeof(original)};codefiles[1]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codecount=2;
 inputs[0]=(struct input){"/sd/main",replacement,sizeof(replacement)};input_count=1;
 struct lfs_lazy_file mod={.name="main",.source={.path="/sd/main"},.size=sizeof(replacement),.kind=LAZY_EXEFS};
 struct lfs_lazy_game game={UINT64_C(0x04006e001823c001),1,&mod};lazy.games=&game;lazy.count=1;code_mount_result=0;
 for(unsigned i=0;i<128;i++){
  void *mounted=0;struct ns_out mount={&mounted};uint64_t id=i%3==0?game.program_id:i%3==1?UINT64_C(0x01006e001823c001):UINT64_C(0x04006e001823c000);
  assert(!lfs_namespace_mount((void *)(uintptr_t)0x1234,&mount,0,1,id,3)&&mounted==gamefs&&lfs_lookup(gamefs,LFS_CODEFS));
  void *file=0;struct ns_out out={&file};assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));assert(lfs_lookup(file,LFS_SLICE));
  lfs_filesystem_release(gamefs);gamefs=object(3,0,0);
  uint8_t bytes[4];uint64_t count;struct ns_buffer b={bytes,sizeof(bytes)};
  assert(!lfs_file_read(file,&count,0,&b,sizeof(bytes),0)&&count==sizeof(bytes)&&!memcmp(bytes,replacement,sizeof(bytes)));
  lfs_file_release(file);assert(!blocks&&objects==2);
 }
 cleanup();fprintf(stderr,"128 reopened CodeFS mounts, base-to-child NPDM resolution/application aliases, real ExeFS overlay and file surviving filesystem release: passed\n");
}

static void handles(void){
 setup();const unsigned files=20;uint8_t values[20][128];char names[20][16];struct lfs_source sources[20];memset(sources,0,sizeof(sources));
 input_count=files;for(unsigned i=0;i<files;i++){snprintf(names[i],sizeof(names[i]),"/sd/file%u",i);for(unsigned j=0;j<128;j++)values[i][j]=(uint8_t)(i+j);inputs[i]=(struct input){names[i],values[i],128};sources[i].path=names[i];}
 struct lfs_arena *arena=0;void *owner=lfs_lazy_plan_allocate(&arena,32);assert(owner);lfs_lazy_plan_finish(owner,arena);
 for(unsigned i=0;i<1000;i++){unsigned n=i<500?0:i%files;uint8_t data[13];assert(!lfs_lazy_source_read(owner,&sources[n],17,data,sizeof(data)));assert(!memcmp(data,values[n]+17,sizeof(data)));assert(objects<=10);}
 assert(source_opens==500);lfs_lazy_owner_release(owner);assert(objects==2&&!blocks);cleanup();fprintf(stderr,"bounded file reuse, 20 sources, eviction, per-read ownership and cleanup: passed\n");
}
static void unrelated_ips_native_files(void){
 setup();uint8_t raw[1024]={0},patch[]={ 'P','A','T','C','H','E','O','F' };
 memcpy(raw,"NSO0",4);raw[0x40]=0x12;
 memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=UINT64_C(0x0400c3f00006e000);
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",raw,sizeof(raw)};codecount=2;
 inputs[0]=(struct input){"/sd/unrelated.ips",patch,sizeof(patch)};input_count=1;
 struct lfs_lazy_file unrelated={.name="34.ips",.source={.path="/sd/unrelated.ips"},.size=sizeof(patch)};lazy.patches=&unrelated;lazy.patch_count=1;lfs_namespace_register((uint8_t *)gamefs+8,UINT64_C(0x0400c3f00006e000));
 void *file=0,*directory=0;struct ns_out out={&file};
 assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));
 /* A patch for another build must not turn a native file or its directory
  * into a virtual object, retain extra references, or read the IPS body. */
 assert(!lfs_lookup(file,LFS_SLICE)&&((struct object *)file)->refs==1);
 assert(!lfs_lookup(gamefs,LFS_CODEFS)&&gamefs->refs==1);
 uint8_t bytes[16];uint64_t count,size;struct ns_buffer b={bytes,sizeof(bytes)};
 assert(!lfs_file_size(file,&size)&&size==sizeof(raw));assert(!lfs_file_read(file,&count,0,&b,sizeof(bytes),0)&&count==sizeof(bytes)&&!memcmp(bytes,raw,sizeof(bytes)));
 lfs_file_release(file);out.value=&directory;assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));assert(!lfs_lookup(directory,LFS_DIRECTORY));
 uint8_t rows[2*0x310];b=(struct ns_buffer){rows,sizeof(rows)};assert(!lfs_directory_read(directory,&count,&b)&&count==2);
 assert(!strcmp((char *)rows,"main.npdm")&&!strcmp((char *)rows+0x310,"main"));assert(!source_opens&&!blocks);
 lfs_directory_release(directory);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);cleanup();
 fprintf(stderr,"unrelated global IPS preserves native files, directory order, references and zero IPS reads: passed\n");
}
static void mixed_ips_native_files(void){
 setup();uint8_t main[4096]={0},sdk[1024]={0},patch[]={ 'P','A','T','C','H',0,1,8,0,1,'X','E','O','F' };
 memcpy(main,"NSO0",4);main[0x40]=0x12;memcpy(sdk,"NSO0",4);sdk[0x40]=0x34;
 for(unsigned i=0;i<3;i++){*(uint32_t *)(main+16+i*16)=256+i*256;*(uint32_t *)(main+20+i*16)=i*0x1000;*(uint32_t *)(main+24+i*16)=64;}
 memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=UINT64_C(0x0400c3f00006e000);
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",main,sizeof(main)};codefiles[2]=(struct input){"/sdk",sdk,sizeof(sdk)};codecount=3;
 inputs[0]=(struct input){"/sd/matching.ips",patch,sizeof(patch)};input_count=1;
 struct lfs_lazy_file matching_patch={.name="12.ips",.source={.path="/sd/matching.ips"},.size=sizeof(patch)};lazy.patches=&matching_patch;lazy.patch_count=1;lfs_namespace_register((uint8_t *)gamefs+8,UINT64_C(0x0400c3f00006e000));
 void *file=0,*directory=0;struct ns_out out={&file};
 assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/sdk",1,&ns));assert(!lfs_lookup(file,LFS_SLICE)&&((struct object *)file)->refs==1);lfs_file_release(file);
 assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));struct lfs_life *life=lfs_lookup(file,LFS_SLICE);assert(life&&life->stream);
 uint8_t byte=0;uint64_t count;struct ns_buffer b={&byte,1};assert(!lfs_file_read(file,&count,264,&b,1,0)&&count==1&&byte=='X');lfs_file_release(file);
 out.value=&directory;assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));uint8_t rows[3*0x310];b=(struct ns_buffer){rows,sizeof(rows)};assert(!lfs_directory_read(directory,&count,&b)&&count==3);
 int seen_main=0,seen_sdk=0;for(uint64_t i=0;i<count;i++){uint8_t *row=rows+i*0x310;if(!strcmp((char *)row,"main")){assert(*(uint64_t *)(row+0x308)==448);seen_main=1;}if(!strcmp((char *)row,"sdk")){assert(*(uint64_t *)(row+0x308)==sizeof(sdk));seen_sdk=1;}}
 assert(seen_main&&seen_sdk);lfs_directory_release(directory);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);cleanup();
 fprintf(stderr,"mixed NSO builds: matching IPS remains active, unrelated file uses native SDK object and size: passed\n");
}
static pthread_barrier_t release_gate;
static void concurrent_retain(void *memory){struct object *o=memory;assert(__atomic_fetch_add(&o->refs,1,__ATOMIC_RELAXED));}
static void concurrent_release(void *memory){
 struct object *o=memory;uint32_t before=__atomic_fetch_sub(&o->refs,1,__ATOMIC_ACQ_REL);assert(before);
 if(before==1){__atomic_fetch_sub(&objects,1,__ATOMIC_RELAXED);free(o);}else sched_yield();
}
static void *release_worker(void *memory){pthread_barrier_wait(&release_gate);lfs_storage_release(memory);return 0;}
static void concurrent_releases(void){
 setup();vt[0]=concurrent_retain;vt[1]=concurrent_release;context.sdk.storage_release=concurrent_release;
 assert(!pthread_barrier_init(&release_gate,0,3));
 for(unsigned i=0;i<1000;i++){
  struct object *storage=object(4,0,0);concurrent_retain(storage);
  struct lfs_life *life=lfs_track(storage,0,LFS_STORAGE);assert(life&&storage->refs==3);
  pthread_t a,b;assert(!pthread_create(&a,0,release_worker,storage));assert(!pthread_create(&b,0,release_worker,storage));
  pthread_barrier_wait(&release_gate);assert(!pthread_join(a,0));assert(!pthread_join(b,0));
  assert(!life->active&&!life->release_mutex&&objects==2);
 }
 assert(!pthread_barrier_destroy(&release_gate));cleanup();
 fprintf(stderr,"concurrent final SDK releases, single destruction and lifetime entry reuse: passed\n");
}
static uint32_t exact_sdk_reference_offset;
static void exact_sdk_retain(void *object){assert(__atomic_fetch_add((uint32_t *)((uint8_t *)object+exact_sdk_reference_offset),1,__ATOMIC_RELAXED));}
static void exact_sdk_release(void *object){assert(__atomic_fetch_sub((uint32_t *)((uint8_t *)object+exact_sdk_reference_offset),1,__ATOMIC_ACQ_REL));}
static void exact_sdk_object_bounds(void){
 const struct {uint32_t kind,size,counter;} layouts[]={
  {LFS_STORAGE,0x20,0x18},{LFS_DIRECTORY,0x20,0x18},{LFS_SLICE,0x28,0x20},{LFS_CODEFS,0x30,0x28}
 };
 for(unsigned i=0;i<sizeof(layouts)/sizeof(layouts[0]);i++){
  setup();void *methods[2]={(void *)exact_sdk_retain,(void *)exact_sdk_release};
  exact_sdk_reference_offset=layouts[i].counter;
  uint8_t *sdk=calloc(1,layouts[i].size);assert(sdk);*(void ***)sdk=methods;*(uint32_t *)(sdk+exact_sdk_reference_offset)=1;
  struct lfs_life *life=lfs_track(sdk,0,layouts[i].kind);assert(life&&life->ref_offset==exact_sdk_reference_offset);
  assert(*(uint32_t *)(sdk+exact_sdk_reference_offset)==2);
  lfs_release(sdk,exact_sdk_release);assert(!life->active&&!life->release_mutex&&*(uint32_t *)(sdk+exact_sdk_reference_offset)==0);
  free(sdk);cleanup();
 }
 fprintf(stderr,"exact SDK adapter allocation bounds, all four counter layouts and final release: passed\n");
}
static void *range_object;static uint64_t range_calls,batch_calls;
static uint32_t base_range(void *o,void *info,int32_t operation,int64_t offset,int64_t size){
 assert(o==(uint8_t *)range_object+8&&info&&operation==3&&offset==INT64_C(0x4652b0000)&&size==147456);range_calls++;memset(info,0xab,64);return 0x9876;
}
static const struct ns_buffer *batch_arguments[8];
static uint32_t base_batch(void *o,const struct ns_buffer *a,const struct ns_buffer *b,const struct ns_buffer *c,const struct ns_buffer *d,const struct ns_buffer *e,const struct ns_buffer *f,const struct ns_buffer *g,const struct ns_buffer *in){
 const struct ns_buffer *args[]={a,b,c,d,e,f,g,in};assert(o==(uint8_t *)range_object+8);
 for(unsigned i=0;i<8;i++)assert(args[i]==batch_arguments[i]);batch_calls++;return 0x7654;
}
static void storage_optional_commands(void){
 setup();range_calls=batch_calls=0;lazy.storage_range=base_range;lazy.storage_batch=base_batch;
 uint8_t *disk=calloc(1,LFS_TRACE_DISK);lazy.trace=calloc(1,LFS_TRACE_STATE);lazy.trace->file=object(1,disk,LFS_TRACE_DISK);((struct object *)lazy.trace->file)->name="/optional.trace";
 context.write=log_write;context.flush=log_flush;trace_writes=progress_writes=0;lfs_trace_initialize();
 range_object=object(4,0,0);struct ns_buffer args[8];for(unsigned i=0;i<8;i++){args[i]=(struct ns_buffer){(void *)(uintptr_t)(0x1000+i*16),i*8};batch_arguments[i]=args+i;}
 uint8_t info[80];memset(info,0x5a,sizeof(info));
 /* Untracked and tracked-without-a-view requests retain every SDK argument. */
 for(unsigned tracked=0;tracked<2;tracked++){
  if(tracked)assert(lfs_track(range_object,0,LFS_STORAGE));
  assert(lfs_storage_range(range_object,info+8,3,INT64_C(0x4652b0000),147456)==0x9876);
  assert(lfs_storage_batch(range_object,args,args+1,args+2,args+3,args+4,args+5,args+6,args+7)==0x7654);
 }
 struct lfs_life *life=lfs_lookup(range_object,LFS_STORAGE);struct lfs_view view={0};life->owner=&view;
 for(unsigned op=2;op<=3;op++){
  memset(info,0x5a,sizeof(info));assert(!lfs_storage_range(range_object,info+8,(int32_t)op,INT64_C(0x4652b0000),0));
  for(unsigned i=0;i<80;i++)assert(info[i]==(i>=8&&i<72?0:0x5a));
  assert(lfs_storage_range(range_object,info+8,(int32_t)op,INT64_C(0x4652b0000),147456)==((6300u<<9)|2u));
  assert(lfs_storage_range(range_object,info+8,(int32_t)op,-1,-1)==((6300u<<9)|2u));
 }
 assert(lfs_storage_range(range_object,0,3,0,0)==((6063u<<9)|2u));
 assert(!lfs_storage_range(range_object,info+8,99,0,1));
 assert(lfs_storage_batch(range_object,args,args+1,args+2,args+3,args+4,args+5,args+6,args+7)==((6300u<<9)|2u));
 assert(lazy.trace->live.last_completed.operation==LFS_T_STORAGE_BATCH&&!lazy.trace->live.h.pending_count);
 assert(!trace_writes&&!progress_writes&&!writes&&!flushes);
 context.enabled=0;assert(lfs_storage_range(range_object,info+8,3,INT64_C(0x4652b0000),147456)==0x9876);
 assert(lfs_storage_batch(range_object,args,args+1,args+2,args+3,args+4,args+5,args+6,args+7)==0x7654);
 assert(range_calls==3&&batch_calls==3);lfs_storage_release(range_object);
 release(lazy.trace->file);free(lazy.trace);lazy.trace=0;free(disk);cleanup();
 fprintf(stderr,"optional storage commands: virtual ranges, batch rejection, exact SDK forwarding and no diagnostic I/O: passed\n");
}
static void final_release_trace(void){
 setup();trace_writes=progress_writes=trace_write_error=progress_write_error=0;
 uint8_t *disk=calloc(1,LFS_TRACE_DISK),*text=calloc(1,1024*1024),*buffer=malloc(0x4000);
 lazy.trace=calloc(1,LFS_TRACE_STATE);lazy.trace->file=object(1,disk,LFS_TRACE_DISK);((struct object *)lazy.trace->file)->name="/release.trace";
 context.log_file=object(1,text,1024*1024);context.write=log_write;context.flush=log_flush;
 lazy.log_buffer=buffer;lazy.log_limit=1024*1024-LFS_TRACE_DISK;lazy.log_cursor=100;lfs_trace_initialize();
 struct lfs_arena *arena=0;void *owner=lfs_lazy_plan_allocate(&arena,32);assert(owner);lfs_lazy_plan_finish(owner,arena);
 uint8_t bytes[32]={0};struct lfs_source file={.path="/sd/file"};inputs[0]=(struct input){file.path,bytes,sizeof(bytes)};input_count=1;
 uint8_t data;assert(!lfs_lazy_source_read(owner,&file,0,&data,1));
 struct object *storage=object(4,0,0);struct lfs_life *life=lfs_track(storage,0,LFS_STORAGE);assert(life);life->plan_owner=owner;
 lfs_lazy_log("Before final release",0,0,0,0);lfs_storage_release(storage);
 /* Cleanup flushes can preserve the Release entry before it returns. The
  * retained SDK object, cached file and arena have all been freed by return. */
 assert(!life->active&&!life->release_mutex&&!blocks&&objects==4);
 assert(!lazy.trace->live.h.pending_count&&lazy.trace->live.last_completed.operation==LFS_T_OBJECT_RELEASE);
 assert(lazy.trace->progress.pending==1&&lazy.trace->progress.pending_records[0].operation==LFS_T_OBJECT_RELEASE);
 uint64_t generation=lazy.trace->progress_generation;lfs_trace_checkpoint(1);
 assert(lazy.trace->progress_generation>generation&&!lazy.trace->progress.pending&&!lazy.trace->saved.h.pending_count);
 release(lazy.trace->file);free(lazy.trace);lazy.trace=0;release(context.log_file);context.log_file=0;free(disk);free(text);free(buffer);cleanup();
 fprintf(stderr,"saved pending final Release completes, frees owned resources and is cleared by the next snapshot: passed\n");
}
static void report_test(void){
 setup();uint8_t *data=calloc(1,1024*1024),*buffer=malloc(0x4000);context.log_file=object(1,data,1024*1024);context.write=log_write;context.flush=log_flush;lazy.log_buffer=buffer;lazy.log_limit=1024*1024;lazy.log_cursor=100;
 context.log=(char *)data;context.log_ready=(char *)data+85;*context.log_ready='0';context.enabled=ns.enabled=0;assert(!lfs_activate()&&context.enabled&&ns.enabled&&*context.log_ready=='1');
 uint8_t sample[100];for(unsigned i=0;i<100;i++)sample[i]=(uint8_t)i;inputs[0]=(struct input){"/sd/audio.pak",sample,100};input_count=1;struct lfs_source entry={.path="/sd/audio.pak"};uint8_t output[80];
 assert(!lfs_source_read((const char *)&entry,7,output,sizeof(output)));lfs_lazy_log_flush();
 assert(strstr((char *)data+100,"Source first read")&&strstr((char *)data+100,"0000000000000050"));
 assert(strstr((char *)data+100,"Source offset")&&strstr((char *)data+100,"0000000000000007"));uint64_t hash=UINT64_C(14695981039346656037);for(unsigned i=7;i<71;i++){hash^=sample[i];hash*=UINT64_C(1099511628211);}char encoded[17];snprintf(encoded,sizeof(encoded),"%016llx",(unsigned long long)hash);assert(strstr((char *)data+100,encoded));
 uint64_t cursor=lazy.log_cursor;assert(!lfs_source_read((const char *)&entry,0,output,sizeof(output)));lfs_lazy_log_flush();assert(lazy.log_cursor==cursor);
 for(unsigned i=0;i<1000;i++)lfs_lazy_unconfigured(UINT64_C(0x0400000000010000)+i,1);assert(lazy.unconfigured_mounts==1000);assert(lazy.log_cursor-cursor<2048);
 release(context.log_file);context.log_file=0;free(data);free(buffer);cleanup();fprintf(stderr,"automatic source ranges/fingerprints, bounded identity reports and no repeated read logging: passed\n");
}

static void ips_test(void){
 for(unsigned inline_mask=0;inline_mask<4;inline_mask++)
 for(unsigned patch_scope=0;patch_scope<3;patch_scope++)
 for(unsigned source_kind=0;source_kind<3;source_kind++){
 setup();uint8_t raw[4096]={0},first[]={ 'P','A','T','C','H',0,1,8,0,4,'a','b','c','d','E','O','F' },second[]={ 'I','P','S','3','2',0,0,1,9,0,2,'X','Y','E','E','O','F' };
 memcpy(raw,"NSO0",4);raw[0x40]=0x12;for(unsigned i=0;i<3;i++){*(uint32_t *)(raw+16+i*16)=256+i*256;*(uint32_t *)(raw+20+i*16)=i*0x1000;*(uint32_t *)(raw+24+i*16)=64;}
 memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=0x0100000000000000;
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",raw,sizeof(raw)};codecount=2;inputs[0]=(struct input){"/sd/first",first,sizeof(first)};inputs[1]=(struct input){"/sd/second",second,sizeof(second)};input_count=2;
 struct lfs_lazy_file patches[2]={{.name="12.ips",.source={.path="/sd/first"},.size=sizeof(first),.kind=LAZY_PATCH},{.name="12.ips32",.source={.path="/sd/second"},.size=sizeof(second),.kind=LAZY_PATCH}};lazy.patch_count=patch_scope==0?2:patch_scope==2?1:0;lazy.patches=patches+(patch_scope==2?1:0);
 if(inline_mask&1){patches[0].kind=LAZY_INLINE_PATCH;patches[0].offset=(uintptr_t)first;}
 if(inline_mask&2){patches[1].kind=LAZY_INLINE_PATCH;patches[1].offset=(uintptr_t)second;}
 uint8_t image[4608]={0};const char names[]="main\0main.npdm";unsigned data_at=16+48+sizeof(names);memcpy(image,"PFS0",4);*(uint32_t *)(image+4)=2;*(uint32_t *)(image+8)=sizeof(names);*(uint64_t *)(image+24)=sizeof(raw);*(uint64_t *)(image+40)=sizeof(raw);*(uint64_t *)(image+48)=sizeof(npdm);*(uint32_t *)(image+56)=5;memcpy(image+64,names,sizeof(names));memcpy(image+data_at,raw,sizeof(raw));memcpy(image+data_at+sizeof(raw),npdm,sizeof(npdm));
 struct lfs_lazy_file mods[3]={{.name=source_kind==2?"exefs.nsp":"/main",.source={.path="/sd/replacement"},.size=source_kind==2?data_at+sizeof(raw)+sizeof(npdm):sizeof(raw),.kind=source_kind==2?LAZY_EXEFS_IMAGE:LAZY_EXEFS},patches[0],patches[1]};
 struct lfs_lazy_game game={0x0100000000000000,(source_kind?1:0)+(patch_scope==1?2:patch_scope==2?1:0),mods+(source_kind?0:1)};
 if(source_kind){inputs[2]=(struct input){"/sd/replacement",source_kind==2?image:raw,mods[0].size};input_count=3;}if(game.count){lazy.games=&game;lazy.count=1;}
 lfs_namespace_register((uint8_t *)gamefs+8,game.program_id);
 void *directory=0,*file=0;struct ns_out out={&directory};assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));uint8_t rows[2*0x310];struct ns_buffer dirbuf={rows,sizeof(rows)};uint64_t count,listed=0;
 assert(!lfs_directory_read(directory,&count,&dirbuf)&&count==2);for(uint64_t i=0;i<count;i++)if(!strcmp((char *)rows+i*0x310,"main"))listed=*(uint64_t *)(rows+i*0x310+0x308);
 out.value=&file;assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));uint64_t size;assert(!lfs_file_size(file,&size));if(size!=448||listed!=size)fprintf(stderr,"patch_scope=%u source_kind=%u size=%llu listed=%llu\n",patch_scope,source_kind,(unsigned long long)size,(unsigned long long)listed);assert(size==448&&listed==size);uint8_t bytes[4];struct ns_buffer b={bytes,sizeof(bytes)};
 assert(!lfs_file_read(file,&count,264,&b,4,0)&&count==4&&!memcmp(bytes,"aXYd",4));lfs_filesystem_release(gamefs);gamefs=object(3,0,0);
 lfs_lookup(directory,LFS_DIRECTORY)->cursor=0;assert(!lfs_directory_read(directory,&count,&dirbuf)&&count==2);assert(!lfs_file_read(file,&count,264,&b,4,0)&&!memcmp(bytes,"aXYd",4));lfs_file_release(file);lfs_directory_release(directory);cleanup();
 }
 fprintf(stderr,"Global/title-scoped/mixed SD and inline IPS ordering, directory sizes, original/loose/PFS sources and object lifetime: passed\n");
}

static void ips_title_isolation(void){
 /* These programs deliberately share an NSO Build ID. A title-local IPS
  * must not become a global patch just because that module is shared. */
 for(unsigned which=0;which<3;which++){
  setup();uint8_t raw[1024]={0},first[]={'P','A','T','C','H',0,1,8,0,1,'A','E','O','F'},second[]={'P','A','T','C','H',0,1,8,0,1,'B','E','O','F'};
  memcpy(raw,"NSO0",4);raw[0x40]=0x12;for(unsigned i=0;i<3;i++){*(uint32_t *)(raw+16+i*16)=256+i*256;*(uint32_t *)(raw+20+i*16)=i*0x1000;*(uint32_t *)(raw+24+i*16)=64;}
  const uint64_t base=UINT64_C(0x0400c3f00006e000),program=base+which;
  memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=program;
  codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",raw,sizeof(raw)};codecount=2;
  inputs[0]=(struct input){"/sd/first",first,sizeof(first)};inputs[1]=(struct input){"/sd/second",second,sizeof(second)};input_count=2;
  struct lfs_lazy_file patches[2]={{.name="/exefs/12.ips",.source={.path="/sd/first"},.size=sizeof(first),.kind=LAZY_PATCH},{.name="exefs_patches/test/12.ips",.source={.path="/sd/second"},.size=sizeof(second),.kind=LAZY_PATCH}};
  struct lfs_lazy_game games[2]={{base,1,patches},{base+1,1,patches+1}};lazy.games=games;lazy.count=2;
  lfs_namespace_register((uint8_t *)gamefs+8,program);
  void *file=0;struct ns_out out={&file};assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));
  uint8_t value=0;uint64_t count;struct ns_buffer b={&value,1};assert(!lfs_file_read(file,&count,264,&b,1,0)&&count==1&&value==(which==0?'A':which==1?'B':0));
  assert((lfs_lookup(file,LFS_SLICE)!=0)==(which<2));assert(source_opens==(which<2?1:0));
  lfs_file_release(file);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);cleanup();
 }
 fprintf(stderr,"Three titles sharing one NSO Build ID: isolated local patches, unconfigured title uses native object: passed\n");
}

static uint32_t trace_set_size(void *file,uint64_t size){(void)file;assert(size==100);return 0;}
static void trace_activation_test(void){
 setup();trace_writes=progress_writes=trace_write_error=0;vt[5]=log_write;vt[6]=log_flush;
 uint8_t *text=calloc(1,1024*1024),*buffer=malloc(0x4000),*disk=calloc(1,LFS_TRACE_DISK);
 context.log_file=object(1,text,1024*1024);context.write=log_write;context.flush=log_flush;context.log=(char *)text;context.log_ready=(char *)text+85;*context.log_ready='0';
 lazy.log_buffer=buffer;lazy.log_limit=1024*1024-LFS_TRACE_DISK;lazy.log_cursor=100;lazy.set_log_size=trace_set_size;
 lazy.trace=calloc(1,LFS_TRACE_STATE);lazy.trace->path="/test.trace";lazy.trace->file=object(1,disk,LFS_TRACE_DISK);((struct object *)lazy.trace->file)->name="/test.trace";
 extern uint64_t lfs_initialize(void);assert(!lfs_initialize());
 assert(source->refs==2&&((struct object *)context.log_file)->refs==2&&((struct object *)lazy.trace->file)->refs==2);
 release(context.log_file);release(lazy.trace->file);release(source);
 assert(((struct object *)lazy.trace->file)->refs==1);context.enabled=ns.enabled=0;
 assert(!lfs_activate()&&context.enabled&&ns.enabled&&lazy.trace->initialized==2);
 assert(trace_writes==0&&progress_writes==0&&source_opens==0);assert(strstr((char *)text+100,"Diagnostic trace enabled"));
 lfs_trace_checkpoint(1);assert(trace_writes==1);
 release(lazy.trace->file);free(lazy.trace);lazy.trace=0;release(context.log_file);context.log_file=0;free(text);free(buffer);free(disk);cleanup();
 fprintf(stderr,"trace references survive app closure; activation performs no trace opens/writes: passed\n");
}

static uint64_t original_size_calls;
static uint32_t failing_storage_size(void *object,uint64_t *out){(void)object;(void)out;original_size_calls++;return 0x1234;}
static void size_test(void){
 setup();trace_writes=progress_writes=trace_write_error=0;vt[5]=log_write;vt[6]=log_flush;
 uint8_t *disk=calloc(1,LFS_TRACE_DISK);lazy.trace=calloc(1,LFS_TRACE_STATE);lazy.trace->file=object(1,disk,LFS_TRACE_DISK);((struct object *)lazy.trace->file)->name="/size.trace";
 context.write=log_write;context.flush=log_flush;lfs_trace_initialize();
 struct lfs_arena *arena=0;struct lfs_view *view=lfs_lazy_plan_allocate(&arena,sizeof(*view));assert(view);view->original_size=256;view->size=UINT64_C(19071029520);lfs_lazy_plan_finish(view,arena);
 struct object *storage=object(4,0,256);struct lfs_life *life=lfs_track(storage,view,LFS_STORAGE);assert(life);life->plan_owner=view;
 context.original_size=failing_storage_size;original_size_calls=0;
 for(unsigned i=0;i<1000;i++){uint64_t size=0;assert(!lfs_size(storage,&size)&&size==view->size);}
 assert(original_size_calls==0&&trace_writes==0&&progress_writes==0&&lazy.trace->size_queries==1000&&!lazy.trace->live.h.pending_count);
 context.enabled=0;uint64_t size=0;assert(lfs_size(storage,&size)==0x1234&&original_size_calls==1);context.enabled=1;
 struct object *plain=object(4,0,128);assert(lfs_size(plain,&size)==0x1234&&original_size_calls==2);release(plain);
 struct lfs_life *null_owner=life;const void *owner=null_owner->owner;null_owner->owner=0;
 assert(lfs_size(storage,&size)==0x1234&&original_size_calls==3);null_owner->owner=owner;
 context.original_size=file_size;
 lfs_trace_checkpoint(1);assert(trace_writes==1&&progress_writes==4&&lazy.trace->progress.size_queries==1002);
 assert(lazy.trace->progress.last_size.result==0x1234&&lazy.trace->progress.operation==LFS_IO_TRACE_FLUSH&&lazy.trace->progress.phase==2);
 lfs_storage_release(storage);release(lazy.trace->file);free(lazy.trace);lazy.trace=0;free(disk);cleanup();
 fprintf(stderr,"immutable 64-bit virtual size without native queries or diagnostic SD I/O; original fallback and progress journal: passed\n");
}

static void *trace_worker(void *unused){(void)unused;for(unsigned i=0;i<2000;i++){uint64_t token=lfs_trace_begin(LFS_T_STORAGE_READ,(void *)(uintptr_t)1,0,i,16);lfs_trace_end(token,0,16,0,0);}return 0;}
static void trace_test(void){
 setup();trace_writes=progress_writes=trace_write_error=0;vt[5]=log_write;vt[6]=log_flush;
 uint8_t *data=calloc(1,1024*1024),*buffer=malloc(0x4000),*disk=calloc(1,LFS_TRACE_DISK);
 context.log_file=object(1,data,1024*1024);context.write=log_write;context.flush=log_flush;
 lazy.log_buffer=buffer;lazy.log_limit=1024*1024-LFS_TRACE_DISK;lazy.log_cursor=100;
 lazy.trace=calloc(1,LFS_TRACE_STATE);lazy.trace->path="/test.trace";
 uint8_t pak[1024]={0};uint32_t magic=0x5a6f12e1,version=8;uint64_t index=64,length=32;
 memcpy(pak+803+17,&magic,4);memcpy(pak+803+21,&version,4);memcpy(pak+803+25,&index,8);memcpy(pak+803+33,&length,8);
 for(unsigned i=0;i<32;i++)pak[64+i]=(uint8_t)(17+i);
 inputs[0]=(struct input){"/test.trace",disk,LFS_TRACE_PAGE*2};inputs[1]=(struct input){"/sd/test.pak",pak,sizeof(pak)};input_count=2;
 struct lfs_lazy_file file={.name="/UNION/Content/Paks/test.pak",.source={.path="/sd/test.pak",.reserved=1},.size=sizeof(pak),.kind=LAZY_ROMFS};struct lfs_lazy_game game={0x04006e001823c001,1,&file};lazy.games=&game;lazy.count=1;
 lazy.trace->file=object(1,disk,LFS_TRACE_DISK);((struct object *)lazy.trace->file)->name="/test.trace";
 uint64_t opens=source_opens;lfs_trace_initialize();assert(lazy.trace->file&&!lazy.trace->failed&&trace_writes==0&&source_opens==opens);
 lfs_trace_checkpoint(1);assert(trace_writes==1);
 uint8_t bytes[256];assert(!lfs_source_read((const char *)&file.source,803,bytes,221));assert(!memcmp(bytes,pak+803,221));
 assert(lazy.trace->live.files[0].pak_version==8&&lazy.trace->live.files[0].index_offset==64&&lazy.trace->live.files[0].index_size==32);
 assert(!lfs_source_read((const char *)&file.source,64,bytes,32));assert(!memcmp(bytes,pak+64,32));assert((lazy.trace->live.files[0].flags&12)==12);
 inputs[2]=(struct input){"/sd/large.bin",0,UINT64_C(8589934592)};input_count=3;
 struct lfs_source large={.path="/sd/large.bin"};assert(!lfs_source_read((const char *)&large,UINT64_C(4294967303),bytes,33));for(unsigned i=0;i<33;i++)assert(bytes[i]==(uint8_t)((UINT64_C(4294967303)+i)%251));
 for(unsigned i=0;i<4000;i++)assert(!lfs_source_read((const char *)&file.source,i%64,bytes,32));
 assert(lazy.trace->live.files[0].reads==4002&&lazy.trace->live.h.pending_count==0&&lazy.trace->live.h.next_record>64&&trace_writes<400);
 /* A small PAK index can sit inside a successful footer read. */
 uint8_t compact[200]={0};uint32_t compact_magic=0x5a6f12e1,compact_version=3;uint64_t compact_offset=34,compact_length=122;
 memcpy(compact+156,&compact_magic,4);memcpy(compact+160,&compact_version,4);memcpy(compact+164,&compact_offset,8);memcpy(compact+172,&compact_length,8);
 inputs[3]=(struct input){"/sd/compact.pak",compact,sizeof(compact)};input_count=4;
 struct lfs_lazy_file compact_file={.name="/compact.pak",.source={.path="/sd/compact.pak",.reserved=4},.size=sizeof(compact),.kind=LAZY_ROMFS};
 struct lfs_lazy_game extra_game={0x0400000000000001,1,&compact_file};lazy.games=&extra_game;
 assert(!lfs_source_read((const char *)&compact_file.source,0,bytes,sizeof(compact)));
 int found_compact=0;for(unsigned i=0;i<LFS_TRACE_FILES;i++)if(lazy.trace->live.files[i].file==4){assert((lazy.trace->live.files[i].flags&12)==12);found_compact=1;}assert(found_compact);lazy.games=&game;
 /* Saturation and concurrent collection must stay bounded and retire lost ends. */
 uint64_t tokens[17];for(unsigned i=0;i<17;i++)tokens[i]=lfs_trace_begin(LFS_T_STORAGE_READ,(void *)(uintptr_t)2,0,i,1);
 assert(tokens[0]&&tokens[15]&&!tokens[16]&&lazy.trace->live.h.pending_count==16);for(unsigned i=0;i<16;i++)lfs_trace_end(tokens[i],0,1,0,0);assert(!lazy.trace->live.h.pending_count);
 uint64_t deferred=lfs_trace_begin(LFS_T_STORAGE_READ,(void *)3,0,0,1);lazy.trace->lock=1;lfs_trace_end(deferred,0,1,0,0);lazy.trace->lock=0;
 uint64_t next=lfs_trace_begin(LFS_T_STORAGE_READ,(void *)3,0,0,1);lfs_trace_end(next,0,1,0,0);assert(!lazy.trace->live.h.pending_count);
 __atomic_store_n(&lazy.trace->next_checkpoint,UINT64_MAX,__ATOMIC_RELAXED);
 pthread_t workers[4];for(unsigned i=0;i<4;i++)assert(!pthread_create(&workers[i],0,trace_worker,0));for(unsigned i=0;i<4;i++)assert(!pthread_join(workers[i],0));
 next=lfs_trace_begin(LFS_T_STORAGE_READ,(void *)3,0,0,1);lfs_trace_end(next,0,1,0,0);assert(!lazy.trace->live.h.pending_count);
 __atomic_store_n(&lazy.trace->next_checkpoint,0,__ATOMIC_RELAXED);
 uint64_t token=lfs_trace_begin(LFS_T_SOURCE_READ,(void *)123,1,88,9);assert(token&&lazy.trace->live.h.pending_count==1);lfs_trace_checkpoint(1);
 assert(lazy.trace->saved.h.pending_count==1&&lazy.trace->saved.h.checksum);
 FILE *out=fopen("state/qa/fixture.trace","wb");assert(out);assert(fwrite(disk,1,LFS_TRACE_DISK,out)==LFS_TRACE_DISK);fclose(out);
 lfs_trace_end(token,0xd401,0,0,0);assert(lazy.trace->live.h.pending_count==0&&lazy.trace->live.h.errors==1);
 /* Added PAKs must report the original sibling package names without reading their data. */
 uint8_t rom[4096]={0};uint64_t fields[10]={80,80,4,96,116,224,4,240,52,1024};memcpy(rom,fields,80);
 uint32_t dir_offsets[4]={0,24,56,88},parents[4]={0,0,24,56};const char *dir_names[4]={"","UNION","Content","Paks"};
 *(uint32_t *)(rom+80)=88;*(uint32_t *)(rom+224)=0;
 for(unsigned i=0;i<4;i++){uint8_t *d=rom+96+dir_offsets[i];*(uint32_t *)d=parents[i];*(uint32_t *)(d+4)=UINT32_MAX;*(uint32_t *)(d+8)=i<3?dir_offsets[i+1]:UINT32_MAX;*(uint32_t *)(d+12)=i==3?0:UINT32_MAX;*(uint32_t *)(d+16)=i?dir_offsets[i-1]:UINT32_MAX;*(uint32_t *)(d+20)=(uint32_t)strlen(dir_names[i]);memcpy(d+24,dir_names[i],strlen(dir_names[i]));}
 const char *base_name="pakchunk0-Ounce.pak";uint8_t *f=rom+240;*(uint32_t *)f=88;*(uint32_t *)(f+4)=UINT32_MAX;*(uint64_t *)(f+16)=64;*(uint32_t *)(f+24)=UINT32_MAX;*(uint32_t *)(f+28)=(uint32_t)strlen(base_name);memcpy(f+32,base_name,strlen(base_name));
 struct object *original=object(4,rom,sizeof(rom));assert(!lfs_lazy_attach_storage(original,game.program_id));lfs_storage_release(original);lfs_lazy_log_flush();assert(strstr((char *)data+100,"Original directory file")&&strstr((char *)data+100,"/UNION/Content/Paks/pakchunk0-Ounce.pak")&&strstr((char *)data+100,"Original directory offset")&&strstr((char *)data+100,"RomFS storage object"));
 /* An original (non-overlaid) read error must also be observable. */
 struct lfs_arena *arena=0;struct lfs_view *view=lfs_lazy_plan_allocate(&arena,sizeof(*view));assert(view);view->size=view->original_size=sizeof(pak);view->count=0;lfs_lazy_plan_finish(view,arena);
 struct object *storage=object(4,pak,sizeof(pak));struct lfs_life *life=lfs_track(storage,view,LFS_STORAGE);assert(life);life->plan_owner=view;
 struct ns_buffer b={bytes,sizeof(bytes)};assert(lfs_read(storage,-1,&b,32)==0xd401);assert(lazy.trace->live.h.errors==3);assert(lazy.trace->live.last_original.result==0xd401&&lazy.trace->live.first_error.result==0xd401&&lazy.trace->live.last_source.sequence);lfs_storage_release(storage);
 /* A short successful SDK read must preserve its actual byte count and
  * become the same native failure that the loader would return without trace. */
 inputs[3]=(struct input){"/sd/short",pak,8};input_count=4;struct lfs_source short_source={.path="/sd/short",.reserved=2};
 assert(lfs_source_read((const char *)&short_source,0,bytes,16)==0xd401);
 assert(lazy.trace->live.last_source.actual==8&&lazy.trace->live.last_source.requested==16&&lazy.trace->live.last_source.result==0xd401);
 struct lfs_arena *missing_arena=0;void *missing_owner=lfs_lazy_plan_allocate(&missing_arena,8);assert(missing_owner);lfs_lazy_plan_finish(missing_owner,missing_arena);
 struct lfs_source missing_source={.path="/sd/missing",.reserved=3};
 assert(lfs_lazy_source_read(missing_owner,&missing_source,0,bytes,8)==0x202);
 assert(lazy.trace->live.last_completed.operation==LFS_T_SOURCE_OPEN&&lazy.trace->live.last_completed.result==0x202);
 lfs_lazy_owner_release(missing_owner);
 /* Unconfigured storage traffic must not fill the trace or trigger writes. */
 struct object *unmodded=object(4,pak,sizeof(pak));uint64_t sequence=lazy.trace->live.h.sequence;
 assert(!lfs_read(unmodded,0,&b,32)&&!memcmp(bytes,pak,32));assert(lazy.trace->live.h.sequence==sequence);release(unmodded);
 /* Journal failure alone disables that journal, leaving regular trace and reads intact. */
 progress_write_error=0x66;lfs_trace_checkpoint(1);assert(lazy.trace->progress_failed==0x66&&!lazy.trace->failed);
 uint64_t progress_before=progress_writes;assert(!lfs_source_read((const char *)&file.source,64,bytes,32)&&!memcmp(bytes,pak+64,32));assert(progress_writes==progress_before);progress_write_error=0;
 /* Diagnostic failure cannot alter the mod read's result or bytes. */
 trace_write_error=0x55;lfs_trace_checkpoint(1);assert(lazy.trace->failed==0x55);
 uint64_t before=trace_writes;assert(!lfs_source_read((const char *)&file.source,64,bytes,32)&&!memcmp(bytes,pak+64,32));assert(trace_writes==before);
 release(lazy.trace->file);free(lazy.trace);lazy.trace=0;release(context.log_file);context.log_file=0;free(data);free(buffer);free(disk);trace_write_error=0;cleanup();
 fprintf(stderr,"trace PAK/index phases, counters, wraparound, pending operations, original errors and nonfatal write failure: passed\n");
}

static unsigned coverage_seen[26];
static void coverage_probe(void){
 struct lfs_trace_page *page=&lazy.trace->live;
 for(unsigned i=0;i<LFS_TRACE_PENDING;i++){
  struct lfs_trace_record *r=&page->pending[i];if(!r->sequence)continue;
  assert(r->operation<26);coverage_seen[r->operation]++;
  if(r->operation==LFS_T_SOURCE_NATIVE_OPEN||r->operation==LFS_T_SOURCE_RETAIN||r->operation==LFS_T_OBJECT_RETAIN){
   uint32_t held=r->operation==LFS_T_OBJECT_RETAIN?LFS_T_OBJECT_LOCK_HELD:LFS_T_SOURCE_LOCK_HELD;int owner=0;
   for(unsigned j=0;j<LFS_TRACE_PENDING;j++)if(page->pending[j].sequence&&page->pending[j].operation==held&&page->pending[j].thread==r->thread)owner=1;
   assert(owner);
  }
 }
 /* Even an overdue snapshot must never write from the new breadcrumbs. */
 assert(trace_writes==0&&progress_writes==0&&writes==0&&flushes==0);
}
static void coverage_test(void){
 setup();memset(coverage_seen,0,sizeof(coverage_seen));trace_writes=progress_writes=trace_write_error=0;
 uint8_t *disk=calloc(1,LFS_TRACE_DISK);lazy.trace=calloc(1,LFS_TRACE_STATE);lazy.trace->file=object(1,disk,LFS_TRACE_DISK);((struct object *)lazy.trace->file)->name="/coverage.trace";
 context.write=log_write;context.flush=log_flush;lfs_trace_initialize();native_probe=coverage_probe;
 /* Safe outer read boundaries are suppressed in this fixture only, leaving
  * every new lock/lifecycle event to prove that it is memory-only itself. */
 lazy.plan_lock=1;
 struct lfs_arena *arena=0;void *owner=lfs_lazy_plan_allocate(&arena,16);assert(owner);lfs_lazy_plan_finish(owner,arena);
 uint8_t values[9][16],out[4];char names[9][16];struct lfs_source sources[9];memset(sources,0,sizeof(sources));input_count=9;
 for(unsigned i=0;i<9;i++){snprintf(names[i],sizeof(names[i]),"/sd/cache%u",i);memset(values[i],(int)i,16);inputs[i]=(struct input){names[i],values[i],16};sources[i].path=names[i];sources[i].reserved=i+1;assert(!lfs_lazy_source_read(owner,&sources[i],0,out,sizeof(out))&&out[0]==i);}
 struct object *tracked=object(4,values[0],16);assert(lfs_track(tracked,0,LFS_STORAGE));lfs_storage_release(tracked);lfs_lazy_owner_release(owner);
 native_probe=0;lazy.plan_lock=0;
 for(unsigned op=LFS_T_OBJECT_LOCK_HELD;op<=LFS_T_OBJECT_RETAIN;op++)if(op!=LFS_T_PLAN_LOCK_HELD&&op!=LFS_T_PROGRAM_LOOKUP)assert(coverage_seen[op]);
 uint64_t w=trace_writes,j=progress_writes;
 lfs_lazy_plan_lock();assert(lazy.trace->plan_lock_trace&&lazy.plan_lock);
 int held=0;for(unsigned i=0;i<LFS_TRACE_PENDING;i++)if(lazy.trace->live.pending[i].sequence&&lazy.trace->live.pending[i].operation==LFS_T_PLAN_LOCK_HELD)held=1;assert(held);
 lfs_lazy_plan_unlock();assert(!lazy.trace->plan_lock_trace&&!lazy.plan_lock&&!lazy.trace->live.h.pending_count&&trace_writes==w&&progress_writes==j);
 /* Owners/waiters are saved by existing snapshots, with the same lock key. */
 uint64_t hold=lfs_trace_begin(LFS_T_SOURCE_LOCK_HELD,(void *)0xabc,1,0,0),wait=lfs_trace_begin(LFS_T_SOURCE_LOCK,(void *)0xabc,2,0,0);
 lfs_trace_checkpoint(1);assert(lazy.trace->saved.h.pending_count==2&&lazy.trace->progress.pending==2);
 lfs_trace_end(wait,0,0,0,0);lfs_trace_end(hold,0,0,0,0);assert(!lazy.trace->live.h.pending_count);
 release(lazy.trace->file);free(lazy.trace);lazy.trace=0;free(disk);cleanup();
 fprintf(stderr,"lock owners and native open/close/retain/release/allocation breadcrumbs; no extra writes in critical sections; snapshot/journal persistence: passed\n");
}

static void layered_read_spans(void){
 setup();uint8_t original[32],a[8],b[8],output[48],expected[40];
 for(unsigned i=0;i<32;i++)original[i]=(uint8_t)i;memset(a,0xa1,8);memset(b,0xb2,8);
 struct lfs_segment segments[2]={{8,8,(uintptr_t)a,(const char *)1},{16,8,(uintptr_t)b,(const char *)1}};
 struct lfs_arena *arena=0;struct lfs_view *view=lfs_lazy_plan_allocate(&arena,sizeof(*view));assert(view);
 view->original_size=32;view->size=40;view->count=2;view->segments=segments;lfs_lazy_plan_finish(view,arena);
 struct object *storage=object(4,original,32);struct lfs_life *life=lfs_track(storage,view,LFS_STORAGE);assert(life);life->plan_owner=view;
 memcpy(expected,original,32);memcpy(expected+8,a,8);memcpy(expected+16,b,8);memset(expected+32,0,8);
 for(unsigned start=0;start<40;start++)for(unsigned size=1;size<=40-start;size++){
  memset(output,0x5c,sizeof(output));struct ns_buffer buffer={output+4,size};
  assert(!lfs_read(storage,start,&buffer,size)&&!memcmp(output+4,expected+start,size));
  for(unsigned i=0;i<4;i++)assert(output[i]==0x5c&&output[4+size+i]==0x5c);
 }
 storage_reads=storage_bytes=0;struct ns_buffer buffer={output,40};assert(!lfs_read(storage,0,&buffer,40));assert(storage_reads==2&&storage_bytes==16);
 storage_reads=storage_bytes=0;storage_error=0x7777;buffer.capacity=16;assert(!lfs_read(storage,8,&buffer,16)&&storage_reads==0&&!memcmp(output,expected+8,16));
 buffer.capacity=40;assert(lfs_read(storage,0,&buffer,40)==0x7777&&storage_reads==1);storage_error=0;
 struct lfs_source broken={.path="/sd/short"};inputs[0]=(struct input){broken.path,a,3};input_count=1;
 segments[0].source_path=(const char *)&broken;segments[0].source_offset=0;buffer.capacity=16;assert(lfs_read(storage,8,&buffer,16)==0xd401);
 lfs_storage_release(storage);cleanup();fprintf(stderr,"Layered read spans: all 820 boundary ranges, base gaps only, zero virtual padding, no base I/O for covered ranges, native/short-source errors and buffer guards: passed\n");
}

int main(void){layered_read_spans();codefs_factory_contract();unrelated_filesystem_native();repeated_codefs_lifetime();exact_sdk_object_bounds();unrelated_ips_native_files();mixed_ips_native_files();failure_test();codefs_test();ips_test();ips_title_isolation();handles();concurrent_releases();storage_optional_commands();final_release_trace();logs();report_test();trace_activation_test();size_test();trace_test();coverage_test();return 0;}
