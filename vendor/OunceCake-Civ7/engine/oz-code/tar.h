typedef struct {
    FtpConfig *c;
    int fd;
    u32 used, limited;
    u64 position, restart, end;
} TarOutput;
typedef struct {
    Server *s;
    const Node *archive;
    FsObject object;
} TarReader;

static void tar_octal(u8 *out,u32 bytes,u64 value) {
    memset(out,'0',bytes-1);out[bytes-1]=0;
    for(u32 i=bytes-1;i&&value;value>>=3)out[--i]=(u8)('0'+(value&7));
}
static void tar_header(Server *s,const TarMember *m,int extended,u8 *out) {
    memset(out,0,512);
    if(extended)memcpy(out,"PaxHeaders/entry",16);
    else {
        memcpy(out,s->strings+m->name_offset,m->name_length);
        memcpy(out+345,s->strings+m->prefix_offset,m->prefix_length);
    }
    tar_octal(out+100,8,!extended&&m->directory?0755:0644);
    tar_octal(out+108,8,0);tar_octal(out+116,8,0);
    tar_octal(out+124,12,extended?m->pax_bytes:m->size>0x1ffffffffULL?0:m->size);
    tar_octal(out+136,12,0);memset(out+148,' ',8);
    out[156]=extended?'x':m->directory?'5':'0';
    memcpy(out+257,"ustar",5);memcpy(out+263,"00",2);
    memcpy(out+265,"root",4);memcpy(out+297,"root",4);
    u64 sum=0;for(u32 i=0;i<512;i++)sum+=out[i];
    tar_octal(out+148,7,sum);out[155]=' ';
}
static int tar_flush(TarOutput *out) {
    if(!out->used)return !out->c->stop;
    int ok=send_all(out->c,out->fd,out->c->ipc_buffer+8192,out->used,1);
    out->used=0;return ok;
}
static int tar_emit(TarOutput *out,const u8 *data,u64 bytes) {
    u64 skip=out->position<out->restart?out->restart-out->position:0;
    if(skip>bytes)skip=bytes;
    out->position+=skip;bytes-=skip;if(data)data+=skip;
    if(out->position>=out->end) {out->limited=1;return !out->c->stop;}
    if(bytes>out->end-out->position) {bytes=out->end-out->position;out->limited=1;}
    while(bytes&&!out->c->stop) {
        u64 count=out->c->output_bytes-out->used;if(count>bytes)count=bytes;
        u8 *target=out->c->ipc_buffer+8192+out->used;
        if(data) {memcpy(target,data,count);data+=count;}else memset(target,0,count);
        out->used+=(u32)count;out->position+=count;bytes-=count;
        if(out->used==out->c->output_bytes&&!tar_flush(out))return 0;
    }
    if(out->position==out->end)out->limited=1;
    return !bytes&&!out->c->stop;
}

static int tar_open(TarReader *reader) {
    if(reader->object.handle)return 1;
    Server *s=reader->s;FtpConfig *c=s->c;
    const Source *source=c->sources+reader->archive->mount;
    if(source->kind<2)reader->object=source_object(source);
    else if(source->kind==2)reader->object=open_source(s,reader->archive);
    else {
        u64 input[2]={source->attributes|((u64)source->proxy_type<<32),source->program_id};
        reader->object=open_path(c,source_object(source),10,input,16,s->strings+reader->archive->source_path);
    }
    return reader->object.handle!=0;
}
static int tar_chunk(TarReader *reader,const TarMember *m,FsObject *file,u64 offset,u64 *inside,u64 *bytes) {
    Server *s=reader->s;FtpConfig *c=s->c;u32 mount=reader->archive->mount;
    const Source *source=c->sources+mount;
    *inside=0;*bytes=m->size-offset;
    if(source->kind==1||source->kind==3) {
        if(*bytes>c->data_bytes)*bytes=c->data_bytes;
        if(!io_enter(c))return 0;
        int ok=tar_open(reader);
        if(ok&&!file->handle) {
            u32 mode=1;*file=open_path(c,reader->object,8,&mode,4,s->strings+m->source_path);
            ok=file->handle!=0;
        }
        if(ok)ok=read_storage(s,*file,1,offset,(u32)*bytes);
        io_leave(c);s->cache_source=NONE;return ok;
    }
    u64 at=m->offset+offset,start=(at/c->data_bytes)*c->data_bytes;
    if(s->cache_source!=mount||s->cache_offset!=start) {
        s->cache_source=NONE;
        u64 count=source->size-start;if(count>c->data_bytes)count=c->data_bytes;
        if(!io_enter(c))return 0;
        int ok=tar_open(reader)&&read_storage(s,reader->object,0,start,(u32)count);
        io_leave(c);if(!ok)return 0;
        s->cache_source=mount;s->cache_offset=start;s->cache_bytes=count;
    }
    *inside=at-start;
    if(*bytes>s->cache_bytes-*inside)*bytes=s->cache_bytes-*inside;
    return 1;
}
// Generate at most `limit` bytes of an archive. Reconstructing the tar stream
// from an absolute offset lets the host renew its native call while the FTP
// data socket remains open, without retaining filesystem objects across calls.
// Returns 0 on failure, 1 when paused, and 2 when the archive is complete.
static int tar_transfer_slice(Server *s,const Node *archive,int fd,u64 restart,u64 limit,u64 *next) {
    FtpConfig *c=s->c;
    if(c->output_bytes!=TAR_OUTPUT_BYTES||restart>archive->size||!limit)return 0;
    u32 first=(u32)archive->offset,count=(u32)(archive->offset>>32);
    const TarMember *members=s->members+first;
    
    u32 low=0,high=count;
    while(low<high) {u32 mid=low+(high-low)/2;if(members[mid].end<=restart)low=mid+1;else high=mid;}
    u64 end=archive->size-restart<limit?archive->size:restart+limit;
    TarOutput out={c,fd,0,0,low<count?members[low].start:archive->size-1024,restart,end};
    TarReader reader={s,archive,{0}};
    int ok=1;FsObject file={0};
    for(u32 i=low;i<count&&ok&&!c->stop&&!out.limited;i++) {
        const TarMember *m=members+i;u8 header[512];
        if(m->pax_bytes) {
            tar_header(s,m,1,header);
            ok=tar_emit(&out,header,512)&&tar_emit(&out,(const u8 *)s->strings+m->pax_offset,m->pax_bytes)&&
                tar_emit(&out,0,tar_padded(m->pax_bytes)-m->pax_bytes);
        }
        if(ok&&!out.limited) {tar_header(s,m,0,header);ok=tar_emit(&out,header,512);}
        u64 offset=out.position<restart?restart-out.position:0;if(offset>m->size)offset=m->size;
        out.position+=offset;
        while(ok&&offset<m->size&&!c->stop&&!out.limited) {
            u64 inside,bytes;
            ok=tar_chunk(&reader,m,&file,offset,&inside,&bytes);
            if(ok) {
                u64 before=out.position;ok=tar_emit(&out,c->data+inside,bytes);
                offset+=out.position-before;
            }
        }
        if(file.handle) {if(!close_reader_object(c,file))ok=0;file=(FsObject){0};}
        if(ok&&!out.limited)ok=tar_emit(&out,0,tar_padded(m->size)-m->size);
    }
    if(ok&&!out.limited)ok=tar_emit(&out,0,1024);
    if(ok)ok=tar_flush(&out);
    const Source *source=c->sources+archive->mount;
    if(reader.object.handle&&source->kind>=2&&!close_reader_object(c,reader.object))ok=0;
    *next=out.position;
    if(!ok||c->stop||out.position<restart||out.position>archive->size)return 0;
    return out.position==archive->size?2:1;
}
