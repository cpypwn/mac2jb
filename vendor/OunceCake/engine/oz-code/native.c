/**
 * @file native.c
 * @brief Read-only HTTP/1.1 + WebDAV (class 1, no locks) server, pushed to the Switch 2.
 *
 * Eats the stuff (SDK functions etc.) SmileBASIC has. There is no libc here: sockets, IPC and
 * threads come in through ServerFunctions, and the few string helpers the code and the vendored
 * parser need are defined below.
 *
 * Served methods: OPTIONS, GET, HEAD (files with single byte ranges, directories as an HTML
 * index) and PROPFIND (Depth 0/1). Everything else is 405, which also makes Finder mount the
 * share read-only.
 *
 * Request parsing uses picohttpparser (vendor/picohttpparser, see its README.md for origin).
 */
#include "native.h"
#include "vendor/picohttpparser/picohttpparser.h"

#define NONE 0xffffffffu
#define BAD 0xd401u
#define CFG_MAGIC 0x313050544632534eULL   // "NS2FTP01", kept as-is so the host ABI stays unchanged.
#define INDEX_MAGIC 0x584950544632534eULL // "NS2FTPIX", written by engine/mounts.cjs.
#define PATH_BYTES 1024
#define DONTWAIT 0x80
#define IPC_BUFFER_BYTES 8192
#define REQUEST_BYTES 4096      ///< Request line + headers must fit here, otherwise 431.
#define SCRATCH_BYTES 8192      ///< Per-slot request buffer + decoded path; host reserves the same.
#define MAX_HEADERS 24
#define MAX_DISCARD_BYTES 65536 ///< Largest request body (PROPFIND XML) we are willing to skip.
#define KEEPALIVE_POLLS 300     ///< 100 ms polls, so idle keep-alive connections drop after ~30 s.
#define SLOT_WAIT_POLLS 30      ///< 100 ms polls a new connection waits for a slot before getting 503.
#define YIELD_IDLE_POLLS 5      ///< Only connections idle this long yield under pressure; a just-finished one is likely reused.
#define LISTEN_BACKLOG 32       ///< Queue for connections waiting on claim_slot; a short queue makes clients see resets.
#define LAST_MODIFIED "Thu, 01 Jan 1970 00:00:00 GMT"
// nn::socket uses BSD values.
#define AF_INET 2
#define SOCK_STREAM 1
#define SOCK_DGRAM 2
#define SOL_SOCKET 0xffff
#define SO_REUSEADDR 0x0004
#define ROUTE_PROBE_ADDRESS 0x01010101u ///< 1.1.1.1; only used to pick the outgoing interface, nothing is sent.

_Static_assert(REQUEST_BYTES + PATH_BYTES + 1 <= SCRATCH_BYTES, "scratch layout");

/* The compiler may emit calls to these for struct copies, and picohttpparser needs the
   <string.h> subset declared in shim/string.h. -fno-builtin keeps the loops below from
   being "optimized" back into calls to themselves. */
void* memset(void* p, int value, __SIZE_TYPE__ n) {u8* b=p; for (__SIZE_TYPE__ i=0;i<n;i++) b[i]=(u8)value; return p;}
void* memcpy(void* p, const void* q, __SIZE_TYPE__ n) {u8* a=p;const u8* b=q;for (__SIZE_TYPE__ i=0;i<n;i++) a[i]=b[i];return p;}
void* memmove(void* p, const void* q, __SIZE_TYPE__ n) {
    u8* a=p;const u8* b=q;
    if(a<b) {for(__SIZE_TYPE__ i=0;i<n;i++)a[i]=b[i];}
    else {for(__SIZE_TYPE__ i=n;i>0;i--)a[i-1]=b[i-1];}
    return p;
}
static u64 length(const char* s) {u64 n=0;while(s[n])n++;return n;}
static int same(const void* a,const void* b,u64 n) {const u8* x=a;const u8* y=b;for(u64 i=0;i<n;i++)if(x[i]!=y[i])return 0;return 1;}
static u16 swap16(u16 n) {return (n>>8)|(n<<8);}
static u64 minimum(u64 a,u64 b) {return a<b?a:b;}
static int transient(ServerConfig* c) {int e=c->functions->get_errno();return e==4||e==11||e==35;}

/// ASCII lowercase, for case-insensitive header names and tokens.
static u8 lower(u8 b) {return b>='A'&&b<='Z'?(u8)(b+32):b;}

/// Case-insensitive compare of a length-delimited token against a NUL-terminated literal.
static int token_is(const char* text,u64 bytes,const char* literal) {
    if(bytes!=length(literal))return 0;
    for(u64 i=0;i<bytes;i++)if(lower((u8)text[i])!=lower((u8)literal[i]))return 0;
    return 1;
}

/// Case-insensitive substring search, used for comma lists like "Connection: keep-alive, close".
static int token_contains(const char* text,u64 bytes,const char* literal) {
    u64 n=length(literal);
    for(u64 at=0;at+n<=bytes;at++)if(token_is(text+at,n,literal))return 1;
    return 0;
}

typedef struct {
    ServerConfig* c;
    const Node* nodes;
    const char* strings;
    u64 count, string_bytes;
    u32 cache_source;
    u64 cache_offset, cache_bytes;
} Server;
typedef struct {
    Server* server;
    int fd;
    int close;      ///< Set once the response must end the connection.
    int head;       ///< HEAD request: send headers only.
    char* request;  ///< REQUEST_BYTES of slot scratch memory.
    char* path;     ///< PATH_BYTES + 1 of slot scratch memory, decoded request path.
} Client;
typedef struct {
    ServerConfig config;
    Server server;
    u64 thread;
    volatile u32 running;
    int control;
    Address peer;
} ClientSlot;
_Static_assert(sizeof(ClientSlot)<=4096, "client slot ABI");

static int io_enter(ServerConfig* c) {
    ServerConfig* owner=c->owner?(ServerConfig*)c->owner:c;
    while(__atomic_exchange_n(&owner->io_lock,1,__ATOMIC_ACQUIRE)) {
        if(c->stop)return 0;
        // we share fs connections. everyone play nice and wait for the system to finish your request
        PollFd delay={-1,0,0};
        c->functions->poll(&delay,1,1);
    }
    return 1;
}
static void io_leave(ServerConfig* c) {
    ServerConfig* owner=c->owner?(ServerConfig*)c->owner:c;
    __atomic_store_n(&owner->io_lock,0,__ATOMIC_RELEASE);
}
static u32 ipc_call(ServerConfig* c,u32 handle) {
    if(!io_enter(c))return BAD;
    u32 result=c->functions->ipc(c->ipc_buffer,4096,handle);
    io_leave(c);return result;
}

static int wait_fd(ServerConfig* c,int fd,short events,int attempts) {
    for(int i=0;i<attempts&&!c->stop;i++) {
        PollFd p={fd,events,0};int n=c->functions->poll(&p,1,100);
        if(n<0) {if(transient(c))continue;return -1;}
        if(n&&p.revents&events)return 1;
        if(n&&p.revents&0x38)return -1;
    }
    return 0;
}
static int send_all(ServerConfig* c,int fd,const void* data,u64 bytes,int payload) {
    u64 sent=0;
    while(sent<bytes&&!c->stop) {
        if(wait_fd(c,fd,4,300)!=1)return 0;
        s64 n=c->functions->send(fd,(const u8*)data+sent,bytes-sent,DONTWAIT);
        if(n<0&&transient(c))continue;
        if(n<=0||(u64)n>bytes-sent)return 0;
        sent+=(u64)n;if(payload)c->sent+=(u64)n;
    }
    return sent==bytes;
}
static u64 decimal(char* out,u64 value) {
    char reverse[20];u64 count=0;
    do {reverse[count++]=(char)('0'+value%10);value/=10;}while(value);
    for(u64 i=0;i<count;i++)out[i]=reverse[count-1-i];
    return count;
}

/**
 * @brief Parse an unsigned decimal prefix of a length-delimited string.
 * @return Digits consumed, or 0 on no digits / overflow.
 */
static u64 parse_decimal(const char* s,u64 bytes,u64* out) {
    u64 n=0,i=0;
    for(;i<bytes&&s[i]>='0'&&s[i]<='9';i++) {
        u64 digit=(u64)(s[i]-'0');
        if(n>(0xffffffffffffffffULL-digit)/10)return 0;
        n=n*10+digit;
    }
    *out=n;return i;
}

static int string_valid(Server* s,u32 at,u64 limit) {
    if(at>=s->string_bytes)return 0;
    for(u64 i=0;i<=limit&&at+i<s->string_bytes;i++) {if(!s->strings[at+i])return 1;}
    return 0;
}
static int index_valid(Server* s) {
    ServerConfig* c=s->c;
    if(!c->index||c->index_bytes<64||c->source_count>0xffffffffULL||!c->sources||!c->source_count)return 0;
    const u64* header=(const u64*)c->index;
    if(header[0]!=INDEX_MAGIC||((const u32*)header)[2]!=1||((const u32*)header)[3]!=48||
        !header[2]||header[2]>=NONE||header[3]!=64||header[4]!=64+header[2]*48||header[6]!=c->index_bytes||
        header[4]>c->index_bytes||header[5]!=c->index_bytes-header[4])return 0;
    s->nodes=(const Node*)(c->index+64);s->count=header[2];s->strings=(const char*)c->index+header[4];s->string_bytes=header[5];
    for(u32 i=0;i<s->count;i++) {
        const Node* n=s->nodes+i;
        if(n->type>1||(!i&&(n->type||n->parent||n->name_length))||(i&&n->parent>=i)||
            n->name_length>=PATH_BYTES||!string_valid(s,n->name_offset,n->name_length)||
            length(s->strings+n->name_offset)!=n->name_length)return 0;
        const char* name=s->strings+n->name_offset;
        if(i&&(!n->name_length||(n->name_length==1&&name[0]=='.')||(n->name_length==2&&name[0]=='.'&&name[1]=='.')))return 0;
        for(u32 j=0;j<n->name_length;j++)if(name[j]=='/'||name[j]=='\\'||name[j]=='\r'||name[j]=='\n')return 0;
        if(n->child!=NONE&&(n->type||n->child<=i||n->child>=s->count||s->nodes[n->child].parent!=i))return 0;
        if(!i&&n->next!=NONE)return 0;
        if(n->next!=NONE&&(n->next>=s->count||s->nodes[n->next].parent!=n->parent||n->next<=i))return 0;
        if(i&&s->nodes[n->parent].type)return 0;
        if(n->type) {
            if(n->mount>=c->source_count)return 0;
            const Source* source=c->sources+n->mount;
            if(!source->handle||source->kind>2||source->reserved||source->attributes>15||
                (source->kind!=2&&source->attributes)||n->offset+n->size<n->offset)return 0;
            if(source->kind!=1&&n->offset+n->size>source->size)return 0;
            if(source->kind&&(!string_valid(s,n->source_path,0x300)||
                s->strings[n->source_path]!=(source->kind==1?'/':'@')))return 0;
        }
    }
    return 1;
}

/// Resolve an absolute, already percent-decoded path to a node id, or NONE.
static u32 lookup(const Server* s,const char* name) {
    u32 current=0;
    while(*name) {
        while(*name=='/')name++;
        const char* begin=name;while(*name&&*name!='/')name++;u64 n=(u64)(name-begin);
        if(!n)break;
        if(n==1&&*begin=='.')continue;
        if(n==2&&begin[0]=='.'&&begin[1]=='.') {current=s->nodes[current].parent;continue;}
        if(s->nodes[current].type)return NONE;
        u32 child=s->nodes[current].child,visited=0;
        while(child!=NONE&&visited++<s->count) {
            const Node* node=s->nodes+child;
            if(node->name_length==n&&same(s->strings+node->name_offset,begin,n))break;
            child=node->next;
        }
        if(child==NONE||visited>s->count)return NONE;
        current=child;
    }
    return current;
}

static int hex_value(u8 b) {
    if(b>='0'&&b<='9')return b-'0';
    b=lower(b);
    return b>='a'&&b<='f'?b-'a'+10:-1;
}

/**
 * @brief Turn a request-target into a NUL-terminated, percent-decoded path.
 *
 * Accepts origin-form ("/a%20b?x") and absolute-form ("http://host/a"). The query string is
 * dropped. Decoded NULs are rejected; a decoded '/' is harmless because index_valid already
 * guarantees that no node name contains one.
 * @return 1 on success, 0 for a malformed or oversized target.
 */
static int decode_path(const char* target,u64 bytes,char* out) {
    u64 i=0,at=0;
    if(bytes>=7&&token_is(target,7,"http://")) {
        i=7;while(i<bytes&&target[i]!='/')i++;
        if(i==bytes) {out[0]='/';out[1]=0;return 1;}
    }
    if(i>=bytes||target[i]!='/')return 0;
    for(;i<bytes&&target[i]!='?'&&target[i]!='#';i++) {
        u8 b=(u8)target[i];
        if(b=='%') {
            if(i+2>=bytes)return 0;
            int high=hex_value((u8)target[i+1]),low=hex_value((u8)target[i+2]);
            if(high<0||low<0)return 0;
            b=(u8)(high*16+low);i+=2;
        }
        if(!b||at==PATH_BYTES)return 0;
        out[at++]=(char)b;
    }
    out[at]=0;return 1;
}

/// Bounded text builder for response headers; output is always NUL-terminated and `ok` latches to 0 on overflow.
typedef struct {char* out; u64 capacity, at; int ok;} Text;
static Text text_init(char* out,u64 capacity) {out[0]=0;Text t={out,capacity,0,1};return t;}
static void text_bytes(Text* t,const void* data,u64 bytes) {
    // `>=` keeps one byte free for the terminator.
    if(!t->ok||bytes>=t->capacity-t->at) {t->ok=0;return;}
    memcpy(t->out+t->at,data,bytes);t->at+=bytes;t->out[t->at]=0;
}
static void text_str(Text* t,const char* s) {text_bytes(t,s,length(s));}
static void text_dec(Text* t,u64 value) {char digits[20];text_bytes(t,digits,decimal(digits,value));}

/**
 * @brief Send a status line and headers.
 * @param type Content-Type, or 0 to omit.
 * @param extra Additional pre-formatted "Name: value\r\n" lines, or 0.
 */
static int send_head(Client* p,const char* status,const char* type,u64 content_length,const char* extra) {
    char buffer[768];Text t=text_init(buffer,sizeof(buffer));
    text_str(&t,"HTTP/1.1 ");text_str(&t,status);
    text_str(&t,"\r\nServer: OunceCake\r\nContent-Length: ");text_dec(&t,content_length);text_str(&t,"\r\n");
    if(type) {text_str(&t,"Content-Type: ");text_str(&t,type);text_str(&t,"\r\n");}
    if(extra)text_str(&t,extra);
    if(p->close)text_str(&t,"Connection: close\r\n");
    text_str(&t,"\r\n");
    return t.ok&&send_all(p->server->c,p->fd,buffer,t.at,0);
}

/// Status-only response with a short text/plain body (omitted for HEAD).
static int send_status(Client* p,const char* status,const char* extra) {
    u64 bytes=length(status);
    if(!send_head(p,status,"text/plain; charset=utf-8",bytes+1,extra))return 0;
    if(p->head)return 1;
    return send_all(p->server->c,p->fd,status,bytes,0)&&send_all(p->server->c,p->fd,"\n",1,0);
}

/**
 * @brief Body writer that runs twice: once counting (sending == 0) for Content-Length, then sending.
 *
 * Output is staged in the slot's data buffer, which is also the RomFS block cache, so the cache
 * is invalidated before a sending pass.
 */
typedef struct {Client* p; int sending, ok; u64 total, used;} Sink;
typedef void (*Writer)(Sink*,const char*,u64);

static void sink_bytes(Sink* k,const char* data,u64 bytes) {
    k->total+=bytes;
    if(!k->sending||!k->ok)return;
    ServerConfig* c=k->p->server->c;
    while(bytes) {
        if(k->used==c->data_bytes) {
            k->ok=send_all(c,k->p->fd,c->data,k->used,0);k->used=0;
            if(!k->ok)return;
        }
        u64 n=minimum(bytes,c->data_bytes-k->used);
        memcpy(c->data+k->used,data,n);k->used+=n;data+=n;bytes-=n;
    }
}
static void sink_str(Sink* k,const char* s) {sink_bytes(k,s,length(s));}
static void sink_dec(Sink* k,u64 value) {char digits[20];sink_bytes(k,digits,decimal(digits,value));}
static int sink_finish(Sink* k) {
    if(k->sending&&k->ok&&k->used)k->ok=send_all(k->p->server->c,k->p->fd,k->p->server->c->data,k->used,0);
    k->used=0;return k->ok;
}

/// Percent-encode everything but RFC 3986 unreserved characters, for hrefs.
static void write_encoded(Sink* k,const char* s,u64 bytes) {
    static const char digits[]="0123456789ABCDEF";
    u64 run=0;
    for(u64 i=0;i<bytes;i++) {
        u8 b=(u8)s[i];
        if((b>='A'&&b<='Z')||(b>='a'&&b<='z')||(b>='0'&&b<='9')||b=='-'||b=='.'||b=='_'||b=='~')continue;
        sink_bytes(k,s+run,i-run);run=i+1;
        char escape[3]={'%',digits[b>>4],digits[b&15]};sink_bytes(k,escape,3);
    }
    sink_bytes(k,s+run,bytes-run);
}

/// Escape the five XML/HTML special characters, for text content.
static void write_escaped(Sink* k,const char* s,u64 bytes) {
    u64 run=0;
    for(u64 i=0;i<bytes;i++) {
        const char* entity=0;
        switch(s[i]) {
            case '&': entity="&amp;";break;
            case '<': entity="&lt;";break;
            case '>': entity="&gt;";break;
            case '"': entity="&quot;";break;
            case '\'': entity="&#39;";break;
            default: continue;
        }
        sink_bytes(k,s+run,i-run);run=i+1;sink_str(k,entity);
    }
    sink_bytes(k,s+run,bytes-run);
}

/**
 * @brief Write the canonical path of a node ("/a/b", directories end in '/').
 *
 * Walks the parent chain from the top down without recursion or a stack array (thread stack size
 * is unknown); O(depth^2), and real RomFS trees are shallow. Termination is guaranteed by
 * index_valid's parent < child rule.
 */
static void write_path(Sink* k,const Server* s,u32 id,Writer write) {
    u32 depth=0;
    for(u32 at=id;at;at=s->nodes[at].parent)depth++;
    for(u32 level=depth;level>0;level--) {
        u32 at=id;
        for(u32 up=1;up<level;up++)at=s->nodes[at].parent;
        sink_str(k,"/");write(k,s->strings+s->nodes[at].name_offset,s->nodes[at].name_length);
    }
    if(!s->nodes[id].type)sink_str(k,"/");
}

static void html_listing(Sink* k,const Server* s,u32 id) {
    sink_str(k,"<!doctype html>\n<meta charset=\"utf-8\">\n<title>Index of ");write_path(k,s,id,write_escaped);
    sink_str(k,"</title>\n<h1>Index of ");write_path(k,s,id,write_escaped);sink_str(k,"</h1>\n");
    if(!id&&s->c->zip_port){
        sink_str(k,"<p><a href=\"http://127.0.0.1:");sink_dec(k,s->c->zip_port);
        sink_str(k,"/download-all.zip\">Download all as ZIP on this Mac</a></p>\n");
    }
    sink_str(k,"<ul>\n");
    if(id)sink_str(k,"<li><a href=\"../\">../</a></li>\n");
    u32 visited=0;
    for(u32 at=s->nodes[id].child;at!=NONE&&visited++<s->count;at=s->nodes[at].next) {
        const Node* n=s->nodes+at;
        sink_str(k,"<li><a href=\"");write_path(k,s,at,write_encoded);sink_str(k,"\">");
        write_escaped(k,s->strings+n->name_offset,n->name_length);
        if(n->type) {sink_str(k,"</a> ");sink_dec(k,n->size);sink_str(k,"</li>\n");}
        else sink_str(k,"/</a></li>\n");
    }
    sink_str(k,"</ul>\n");
}

static void propfind_entry(Sink* k,const Server* s,u32 id) {
    const Node* n=s->nodes+id;
    sink_str(k,"<D:response><D:href>");write_path(k,s,id,write_encoded);
    sink_str(k,"</D:href><D:propstat><D:prop><D:displayname>");write_escaped(k,s->strings+n->name_offset,n->name_length);
    sink_str(k,"</D:displayname>");
    if(n->type) {
        sink_str(k,"<D:resourcetype/><D:getcontentlength>");sink_dec(k,n->size);
        sink_str(k,"</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>");
    } else sink_str(k,"<D:resourcetype><D:collection/></D:resourcetype>");
    sink_str(k,"<D:getlastmodified>" LAST_MODIFIED "</D:getlastmodified><D:supportedlock/><D:lockdiscovery/>"
        "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>\n");
}

static void propfind_listing(Sink* k,const Server* s,u32 id,int depth) {
    sink_str(k,"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">\n");
    propfind_entry(k,s,id);
    u32 visited=0;
    if(depth&&!s->nodes[id].type)
        for(u32 at=s->nodes[id].child;at!=NONE&&visited++<s->count;at=s->nodes[at].next)propfind_entry(k,s,at);
    sink_str(k,"</D:multistatus>\n");
}

/**
 * @brief Measure, then send, a generated body.
 * @param depth Only used by propfind_listing.
 */
static int send_generated(Client* p,const char* status,const char* type,u32 id,int propfind,int depth) {
    Server* s=p->server;Sink k={p,0,1,0,0};
    if(propfind)propfind_listing(&k,s,id,depth);else html_listing(&k,s,id);
    if(!send_head(p,status,type,k.total,0))return 0;
    if(p->head)return 1;
    s->cache_source=NONE;
    k.sending=1;k.total=0;
    if(propfind)propfind_listing(&k,s,id,depth);else html_listing(&k,s,id);
    return sink_finish(&k);
}

// put together the fs ipc requests for downloads
static void packet(ServerConfig* c,u32 command,const void* input,u32 bytes,u8* output,u32 count) {
    u32* p=(u32*)c->ipc_buffer;memset(p,0,256);p[0]=4|(count?1u<<24:0);p[1]=(32+bytes+3)/4;
    u32 at=16;
    if(count) {u64 a=(u64)output;p[2]=count;p[3]=(u32)a;p[4]=1u|((u32)(a>>36)<<2)|((u32)((a>>32)&15)<<28);at=32;}
    *(u32*)((u8*)p+at)=0x49434653;*(u32*)((u8*)p+at+8)=command;memcpy((u8*)p+at+16,input,bytes);
}
static u8* response(ServerConfig* c,u32* moved) {
    u32* p=(u32*)c->ipc_buffer;u32 at=2;*moved=0;
    if(p[1]>>31) {
        u32 special=p[at++],copies=(special>>1)&15,moves=(special>>5)&15;
        if(special&1)at+=2;
        if(copies||moves>1)return 0;
        if(moves)*moved=p[at++];
    }
    at+=((p[0]>>16)&15)*2+(((p[0]>>20)&15)+((p[0]>>24)&15)+((p[0]>>28)&15))*3;at=(at+3)&~3u;
    if(at+4>64||p[at]!=0x4f434653)return 0;
    if(p[at+2]) {c->native_result=p[at+2];return 0;}
    return (u8*)(p+at+4);
}
static u32 open_source(Server* s,const Node* n) {
    ServerConfig* c=s->c;const char* filename=s->strings+n->source_path;u8* name=c->ipc_buffer+4096;
    const Source* source=c->sources+n->mount;
    u64 bytes=length(filename);if(bytes>0x300)return 0;memset(name,0,0x301);memcpy(name,filename,bytes);
    u32 input[2]={source->kind==1?1:source->attributes,6};
    packet(c,source->kind==1?8:206,input,source->kind==1?4:8,0,0);u32* p=(u32*)c->ipc_buffer;u64 a=(u64)name;
    p[0]=4|1u<<16;p[2]=(0x301u<<16)|((u32)((a>>36)&7)<<6)|((u32)((a>>32)&15)<<12);p[3]=(u32)a;
    c->native_result=ipc_call(c,source->handle);if(c->native_result)return 0;
    u32 handle;if(!response(c,&handle)||!handle)return 0;
    if(source->kind==2) {
        packet(c,4,0,0,0,0);c->native_result=ipc_call(c,handle);
        u32 moved=0;u8* out=c->native_result?0:response(c,&moved);
        if(!out||moved||*(u64*)out!=source->size) {
            if(moved)c->functions->close_handle(moved);
            c->functions->close_handle(handle);return 0;
        }
    }
    return handle;
}
static int read_storage(Server* s,u32 handle,int file,u64 offset,u32 count) {
    ServerConfig* c=s->c;u64 input[3]={file?0:offset,file?offset:count,count};
    packet(c,0,input,file?24:16,c->data,count);
    c->native_result=ipc_call(c,handle);if(c->native_result)return 0;
    u32 moved;u8* out=response(c,&moved);if(!out||moved)return 0;
    if(file&&*(u64*)out!=count)return 0;
    return 1;
}

/// Send bytes [start, end) of a file node. Storage reads go through the per-slot block cache.
static int stream_file(Client* p,const Node* n,u32 handle,u64 start,u64 end) {
    Server* s=p->server;ServerConfig* c=s->c;const Source* source=c->sources+n->mount;
    int ok=1;u64 offset=start;
    if(source->kind)s->cache_source=NONE;
    while(ok&&offset<end&&!c->stop) {
        u64 count,inside=0;
        if(source->kind==1) {
            count=minimum(end-offset,c->data_bytes);
            ok=read_storage(s,handle,1,offset,(u32)count);
        } else {
            u64 at=n->offset+offset,block=(at/c->data_bytes)*c->data_bytes;
            if(s->cache_source!=n->mount||s->cache_offset!=block) {
                count=minimum(source->size-block,c->data_bytes);
                ok=read_storage(s,handle,0,block,(u32)count);if(!ok)break;
                s->cache_source=n->mount;s->cache_offset=block;s->cache_bytes=count;
            }
            inside=at-s->cache_offset;count=minimum(s->cache_bytes-inside,end-offset);
        }
        if(ok)ok=send_all(c,p->fd,c->data+inside,count,1);
        offset+=count;
    }
    return ok&&offset==end&&!c->stop;
}

typedef struct {
    int present;       ///< A single "bytes=" range we understand was sent.
    int suffix;        ///< "bytes=-N": last N bytes.
    int open;          ///< "bytes=N-": from N to the end.
    u64 first, last;
} Range;

/// Parse a Range header. Multiple ranges or unknown units leave `present` at 0 (full 200 response).
static Range parse_range(const char* value,u64 bytes) {
    Range r={0,0,0,0,0};
    if(bytes<7||!token_is(value,6,"bytes=")||token_contains(value,bytes,","))return r;
    value+=6;bytes-=6;
    u64 used;
    if(*value=='-') {
        used=parse_decimal(value+1,bytes-1,&r.last);
        if(!used||1+used!=bytes)return r;
        r.suffix=1;r.present=1;return r;
    }
    used=parse_decimal(value,bytes,&r.first);
    if(!used||used>=bytes||value[used]!='-')return r;
    if(used+1==bytes) {r.open=1;r.present=1;return r;}
    if(used+1+parse_decimal(value+used+1,bytes-used-1,&r.last)!=bytes||r.last<r.first)return r;
    r.present=1;return r;
}

static int serve_file(Client* p,u32 id,Range range) {
    Server* s=p->server;ServerConfig* c=s->c;const Node* n=s->nodes+id;const Source* source=c->sources+n->mount;
    u64 start=0,end=n->size;
    char extra[192];Text t=text_init(extra,sizeof(extra));
    text_str(&t,"Accept-Ranges: bytes\r\nLast-Modified: " LAST_MODIFIED "\r\n");
    if(range.present&&n->size) {
        if(range.suffix) start=n->size-minimum(range.last,n->size);
        else {
            if(range.first>=n->size) {
                text_str(&t,"Content-Range: bytes */");text_dec(&t,n->size);text_str(&t,"\r\n");
                return t.ok&&send_status(p,"416 Range Not Satisfiable",extra);
            }
            start=range.first;
            // Clamp before the +1 so "bytes=0-18446744073709551615" cannot wrap to 0.
            if(!range.open)end=minimum(range.last,n->size-1)+1;
        }
        if(start==end)return send_status(p,"416 Range Not Satisfiable",0);
        text_str(&t,"Content-Range: bytes ");text_dec(&t,start);text_str(&t,"-");text_dec(&t,end-1);
        text_str(&t,"/");text_dec(&t,n->size);text_str(&t,"\r\n");
    }
    if(!t.ok)return 0;
    const char* status=range.present&&n->size?"206 Partial Content":"200 OK";
    if(p->head)return send_head(p,status,"application/octet-stream",end-start,extra);
    u32 handle=source->kind?open_source(s,n):source->handle;
    if(!handle)return send_status(p,"500 Source file could not be opened",0);
    int ok=send_head(p,status,"application/octet-stream",end-start,extra)&&stream_file(p,n,handle,start,end);
    if(source->kind&&c->functions->close_handle(handle))ok=0;
    if(source->kind)s->cache_source=NONE;
    if(ok)c->files++;
    return ok;
}

#define ALLOW_HEADER "Allow: OPTIONS, GET, HEAD, PROPFIND\r\n"

/**
 * @brief Handle one parsed request.
 * @return 0 when the connection has to be dropped (send failure or mid-body error).
 */
static int respond(Client* p,const char* method,u64 method_bytes,const char* target,u64 target_bytes,
    const struct phr_header* headers,u64 header_count) {
    Range range={0,0,0,0,0};int depth=1,infinite=0;
    for(u64 i=0;i<header_count;i++) {
        const struct phr_header* h=headers+i;
        if(token_is(h->name,h->name_len,"range"))range=parse_range(h->value,h->value_len);
        else if(token_is(h->name,h->name_len,"depth")) {
            if(token_is(h->value,h->value_len,"0"))depth=0;
            else if(token_is(h->value,h->value_len,"infinity"))infinite=1;
        }
    }
    p->head=token_is(method,method_bytes,"HEAD");
    int get=p->head||token_is(method,method_bytes,"GET"),propfind=token_is(method,method_bytes,"PROPFIND");
    if(token_is(method,method_bytes,"OPTIONS"))
        return send_head(p,"200 OK",0,0,ALLOW_HEADER "DAV: 1\r\nMS-Author-Via: DAV\r\n");
    if(!get&&!propfind)return send_status(p,"405 Method Not Allowed",ALLOW_HEADER);
    if(!decode_path(target,target_bytes,p->path))return send_status(p,"400 Bad Request",0);
    u32 id=lookup(p->server,p->path);
    if(id==NONE)return send_status(p,"404 Not Found",0);
    if(propfind) {
        // RFC 4918 lets servers refuse Depth: infinity; a missing Depth is treated as 1 for lenience.
        if(infinite)return send_status(p,"403 Forbidden",0);
        return send_generated(p,"207 Multi-Status","application/xml; charset=utf-8",id,1,depth);
    }
    if(p->server->nodes[id].type)return serve_file(p,id,range);
    return send_generated(p,"200 OK","text/html; charset=utf-8",id,0,0);
}

/// Read and drop `bytes` of request body that is not already buffered.
static int discard(Client* p,u64 bytes) {
    ServerConfig* c=p->server->c;
    while(bytes&&!c->stop) {
        int ready=wait_fd(c,p->fd,1,300);if(ready!=1)return 0;
        s64 n=c->functions->recv(p->fd,p->request,minimum(bytes,REQUEST_BYTES),DONTWAIT);
        if(n<0&&transient(c))continue;
        if(n<=0||(u64)n>bytes)return 0;
        bytes-=(u64)n;
    }
    return !bytes;
}

/**
 * @brief Run one keep-alive connection: parse, respond, repeat (pipelined requests included).
 */
static void session(ClientSlot* slot) {
    Server* s=&slot->server;ServerConfig* c=s->c;
    Client p;memset(&p,0,sizeof(p));p.server=s;p.fd=slot->control;
    p.request=(char*)c->ipc_buffer+IPC_BUFFER_BYTES;p.path=p.request+REQUEST_BYTES;
    Address local;u32 size=16;if(c->functions->sockname(p.fd,&local,&size)||size!=16)return;
    memcpy(c->ip,&local.address,4);
    u64 used=0;u32 idle=0;
    while(!c->stop&&idle<KEEPALIVE_POLLS) {
        if(used) {
            const char* method;const char* target;size_t method_bytes,target_bytes,header_count=MAX_HEADERS;int minor;
            struct phr_header headers[MAX_HEADERS];
            int consumed=phr_parse_request(p.request,used,&method,&method_bytes,&target,&target_bytes,&minor,headers,&header_count,0);
            if(consumed==-1) {p.close=1;send_status(&p,"400 Bad Request",0);return;}
            if(consumed==-2&&used==REQUEST_BYTES) {p.close=1;send_status(&p,"431 Request Header Fields Too Large",0);return;}
            if(consumed>0) {
                u64 body=0;
                p.close=minor==0;
                for(size_t i=0;i<header_count;i++) {
                    const struct phr_header* h=headers+i;
                    if(token_is(h->name,h->name_len,"connection")) {
                        if(token_contains(h->value,h->value_len,"close"))p.close=1;
                        else if(token_contains(h->value,h->value_len,"keep-alive"))p.close=0;
                    } else if(token_is(h->name,h->name_len,"content-length")) {
                        if(parse_decimal(h->value,h->value_len,&body)!=h->value_len) {p.close=1;send_status(&p,"400 Bad Request",0);return;}
                    } else if(token_is(h->name,h->name_len,"transfer-encoding")) {
                        // We never need a request body, and chunked bodies would need decoding just to skip them.
                        p.close=1;send_status(&p,"501 Not Implemented",0);return;
                    }
                }
                if(body>MAX_DISCARD_BYTES) {p.close=1;send_status(&p,"413 Content Too Large",0);return;}
                if(!respond(&p,method,method_bytes,target,target_bytes,headers,header_count)||p.close)return;
                // Header pointers die here: the buffer is reused for body draining and pipelining.
                u64 buffered=used-(u64)consumed;
                if(body>buffered) {
                    if(!discard(&p,body-buffered))return;
                    used=0;
                } else {
                    used=buffered-body;
                    memmove(p.request,p.request+consumed+body,used);
                }
                continue;
            }
        }
        // Between requests, give the slot up if another client is waiting for one.
        if(!used&&idle>=YIELD_IDLE_POLLS&&c->owner&&((ServerConfig*)c->owner)->pressure)break;
        int ready=wait_fd(c,p.fd,1,1);if(ready<0)break;if(!ready) {idle++;continue;}
        s64 count=c->functions->recv(p.fd,p.request+used,REQUEST_BYTES-used,DONTWAIT);
        if(count<0&&transient(c))continue;
        if(count<=0||(u64)count>REQUEST_BYTES-used)break;
        used+=(u64)count;idle=0;
    }
}
static void* client_worker(void* argument) {
    ClientSlot* slot=argument;
    session(slot);
    slot->config.functions->close(slot->control);
    __atomic_store_n(&slot->running,0,__ATOMIC_RELEASE);
    return 0;
}
static void collect_clients(ServerConfig* c,int stop) {
    u64 sent=0,files=0;
    for(u32 i=0;i<c->reserved;i++) {
        ClientSlot* slot=(ClientSlot*)(c->slots+i*c->slot_bytes);
        if(stop)slot->config.stop=1;
        if(slot->thread&&!__atomic_load_n(&slot->running,__ATOMIC_ACQUIRE)) {
            if(c->functions->thread_join(slot->thread,0))c->result=BAD;
            else slot->thread=0;
        }
        sent+=slot->config.sent;files+=slot->config.files;
        if(slot->config.native_result)c->native_result=slot->config.native_result;
        if(slot->config.ip[0])memcpy(c->ip,slot->config.ip,4);
    }
    c->sent=sent;c->files=files;
}

/**
 * @brief Find a free slot, reclaiming finished ones first.
 *
 * If all are busy, raise `pressure` so idle keep-alive sessions close, and wait up to
 * SLOT_WAIT_POLLS for one to free up. Returns 0 if none did.
 */
static ClientSlot* claim_slot(ServerConfig* c) {
    ClientSlot* slot=0;
    for(u32 attempt=0;!slot&&attempt<=SLOT_WAIT_POLLS&&!c->stop;attempt++) {
        if(attempt) {c->pressure=1;PollFd delay={-1,0,0};c->functions->poll(&delay,1,100);}
        collect_clients(c,0);
        for(u32 i=0;i<c->reserved&&!slot;i++) {
            ClientSlot* candidate=(ClientSlot*)(c->slots+i*c->slot_bytes);
            if(!candidate->thread)slot=candidate;
        }
    }
    c->pressure=0;
    return slot;
}

/**
 * @brief Record which startup step failed (and errno for socket steps) for the host, then bail out.
 * @param fd Listening socket to close, or -1.
 */
static void* startup_failed(ServerConfig* c,u32 phase,int fd) {
    c->phase=phase;
    if(phase>=PHASE_SOCKET)c->native_result=(u64)(u32)c->functions->get_errno();
    if(fd>=0)c->functions->close(fd);
    c->state=3;return (void*)(u64)BAD;
}

/**
 * @brief Fill c->ip with the console's LAN address before any client connects.
 *
 * connect() on a UDP socket only selects a route (no packet is sent), and getsockname() then
 * reports the local address of that route. Uses nothing beyond nn::socket, so it does not depend
 * on nifm being initialized in the host process. Leaves ip zero if there is no route.
 */
static void discover_address(ServerConfig* c) {
    ServerFunctions* f=c->functions;int fd=f->socket(AF_INET,SOCK_DGRAM,0);
    if(fd<0)return;
    Address probe={16,AF_INET,swap16(53),ROUTE_PROBE_ADDRESS,{0}},local={0,0,0,0,{0}};u32 size=16;
    if(!f->connect(fd,&probe,16)&&!f->sockname(fd,&local,&size)&&size==16)memcpy(c->ip,&local.address,4);
    f->close(fd);
}

/**
 * @brief Thread entry: validate the host config, listen, and hand each connection to a slot thread.
 *
 * Slot memory layout (slot_bytes each): ClientSlot (4096), data/cache (data_bytes),
 * IPC buffer (IPC_BUFFER_BYTES), request scratch (SCRATCH_BYTES).
 */
void* server_main(void* configuration) {
    ServerConfig* c=configuration;
    if(!c||c->magic!=CFG_MAGIC||c->version!=1)return (void*)(u64)BAD;
    Server s;memset(&s,0,sizeof(s));s.c=c;s.cache_source=NONE;c->state=0;c->result=BAD;c->phase=0;
    if(!c->functions||!c->ipc_buffer||!c->data||c->data_bytes<4096||c->data_bytes>0x400000||
        !c->port||c->port>65535||!c->slots||!c->reserved||c->reserved>SERVER_MAX_CLIENTS||
        c->slot_bytes<4096+c->data_bytes+IPC_BUFFER_BYTES+SCRATCH_BYTES)return startup_failed(c,PHASE_CONFIG,-1);
    if(!index_valid(&s))return startup_failed(c,PHASE_INDEX,-1);
    for(u32 i=0;i<c->reserved;i++)memset(c->slots+i*c->slot_bytes,0,sizeof(ClientSlot));
    ServerFunctions* f=c->functions;int fd=f->socket(AF_INET,SOCK_STREAM,0);
    if(fd<0)return startup_failed(c,PHASE_SOCKET,-1);
    // Without this, server-closed keep-alive connections in TIME_WAIT block a quick restart on the same port.
    // Failure is not fatal: bind will report the real problem if there is one.
    int reuse=1;f->setsockopt(fd,SOL_SOCKET,SO_REUSEADDR,&reuse,sizeof(reuse));
    Address address={16,AF_INET,swap16((u16)c->port),0,{0}};
    if(f->bind(fd,&address,16))return startup_failed(c,PHASE_BIND,fd);
    if(f->listen(fd,LISTEN_BACKLOG))return startup_failed(c,PHASE_LISTEN,fd);
    discover_address(c);
    c->result=0;c->state=1;
    while(!c->stop) {
        collect_clients(c,0);
        int ready=wait_fd(c,fd,1,1);if(ready<0) {c->result=BAD;break;}if(!ready)continue;
        Address peer={0};u32 bytes=16;int client=f->accept(fd,&peer,&bytes);
        if(client<0)continue;
        ClientSlot* slot=bytes==16&&peer.family==2?claim_slot(c):0;
        if(!slot) {
            static const char busy[]="HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 1\r\nConnection: close\r\n\r\n";
            send_all(c,client,busy,sizeof(busy)-1,0);f->close(client);continue;
        }
        u64 sent=slot->config.sent,files=slot->config.files;
        memcpy(&slot->config,c,sizeof(*c));slot->config.sent=sent;slot->config.files=files;slot->config.owner=(struct ServerConfigTag*)c;
        slot->config.data=(u8*)slot+4096;slot->config.ipc_buffer=slot->config.data+c->data_bytes;
        slot->server=s;slot->server.c=&slot->config;slot->server.cache_source=NONE;slot->control=client;slot->peer=peer;slot->running=1;
        if(f->thread_create(&slot->thread,0,client_worker,slot)) {slot->running=0;slot->thread=0;f->close(client);}
    }
    f->close(fd);
    for(;;) {
        collect_clients(c,1);int active=0;
        for(u32 i=0;i<c->reserved;i++)if(((ClientSlot*)(c->slots+i*c->slot_bytes))->thread)active=1;
        if(!active)break;
        PollFd delay={-1,0,0};f->poll(&delay,1,50);
    }
    c->state=c->result?3:2;return (void*)(u64)c->result;
}
