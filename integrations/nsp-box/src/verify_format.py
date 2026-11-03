"""Independent mmap reader for produced NSP files and embedded content."""
import hashlib,json,mmap,struct,sys,time
from pathlib import Path
from contextlib import closing

def checkpoint(): pass

class Region:
    """Bounded mmap range without exported buffer views; always safe to close."""
    def __init__(self,mapping,offset=0,size=None):
        self.mapping=mapping;self.offset=offset;self.size=len(mapping)-offset if size is None else size
        if offset<0 or self.size<0 or offset+self.size>len(mapping):raise ValueError('Range is outside the container')
    def __len__(self):return self.size
    def __getitem__(self,key):
        if isinstance(key,slice):
            start,stop,step=key.indices(self.size)
            if step!=1:return bytes(self)[key]
            return Region(self.mapping,self.offset+start,max(0,stop-start))
        if key<0:key+=self.size
        if not 0<=key<self.size:raise IndexError(key)
        return self.mapping[self.offset+key]
    def __bytes__(self):return self.mapping[self.offset:self.offset+self.size]
    def read(self,offset,size):return self.mapping[self.offset+offset:self.offset+offset+size]

def u(fmt,buf,off=0):
    if isinstance(buf,Region):return struct.unpack('<'+fmt,buf.read(off,struct.calcsize('<'+fmt)))
    return struct.unpack_from('<'+fmt,buf,off)

def digest(buf):
    h=hashlib.sha256()
    if isinstance(buf,Region):
        # Views are scoped and explicitly released, including on cancellation.
        # No exported mmap buffers survive this function or an error traceback.
        with memoryview(buf.mapping) as mapped:
            for off in range(0,len(buf),4*1024*1024):
                checkpoint()
                with mapped[buf.offset+off:buf.offset+min(off+4*1024*1024,len(buf))] as block:
                    h.update(block)
    else:h.update(buf)
    return h.digest()

def block_digests(buf,block_size,padded=False):
    if isinstance(buf,Region):
        with memoryview(buf.mapping) as mapped:
            for k,off in enumerate(range(0,len(buf),block_size)):
                if k%128==0:checkpoint()
                count=min(block_size,len(buf)-off)
                with mapped[buf.offset+off:buf.offset+off+count] as block:
                    h=hashlib.sha256(block)
                if padded and count<block_size:h.update(bytes(block_size-count))
                yield h.digest()
    else:
        for k,off in enumerate(range(0,len(buf),block_size)):
            if k%128==0:checkpoint()
            b=bytes(buf[off:off+block_size]);h=hashlib.sha256(b)
            if padded and len(b)<block_size:h.update(bytes(block_size-len(b)))
            yield h.digest()
def file_digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        while b:=f.read(4*1024*1024):h.update(b)
    return h.digest()

def partition(buf,offset=0):
    magic,n,stsize,_=u('4sIII',buf,offset);assert magic in (b'PFS0',b'HFS0')
    es=0x40 if magic==b'HFS0' else 0x18;strings=offset+16+n*es;data=strings+stsize
    result={}
    for i in range(n):
        checkpoint()
        at=offset+16+i*es;rel,size,nameoff=u('QQI',buf,at)
        name=bytes(buf[strings+nameoff:strings+stsize]).split(b'\0')[0].decode()
        view=buf[data+rel:data+rel+size];assert len(view)==size
        if magic==b'HFS0':
            hn,ho=u('IQ',buf,at+20)
            assert digest(view[ho:ho+hn])==bytes(buf[at+32:at+64]),('HFS hash',name)
        result[name]=view
    return result

def nca_sections(buf):
    assert bytes(buf[0x200:0x204])==b'NCA3'
    assert u('Q',buf,0x208)[0]==len(buf)
    title=u('Q',buf,0x210)[0];sections=[]
    for i in range(4):
        start,end=u('II',buf,0x240+16*i)
        if not start and not end:continue
        header=buf[0x400+512*i:0x600+512*i]
        assert digest(header)==bytes(buf[0x280+32*i:0x2a0+32*i])
        assert header[4]==1,'Expected plaintext section'
        body=buf[start*512:end*512];assert len(body)==(end-start)*512
        if header[3]==2:
            block,count=u('II',header,0x28);assert count==2
            ho,hs,do,ds=u('4Q',header,0x30)
            hashes=body[ho:ho+hs];data=body[do:do+ds]
            assert digest(hashes)==bytes(header[8:40]),'PFS master hash'
            with closing(block_digests(data,block)) as generated:
                for k,actual in enumerate(generated):
                    assert actual==bytes(hashes[k*32:k*32+32]),'PFS block hash'
            sections.append(('pfs',data))
        elif header[3]==3:
            assert bytes(header[8:12])==b'IVFC'
            count=u('I',header,0x14)[0]-1;assert count==6
            expected=header[0xc8:0xe8]
            for j in range(count):
                off,size,order=u('QQI',header,0x18+j*24);block=1<<order
                data=body[off:off+size];assert len(data)==size
                with closing(block_digests(data,block,padded=True)) as generated:
                    for k,actual in enumerate(generated):
                        assert actual==bytes(expected[k*32:k*32+32]),('IVFC',j,k)
                expected=data
            sections.append(('romfs',data))
        else:raise ValueError('Unsupported hash')
    return title,buf[0x205],sections

def romfs_files(buf):
    vals=u('10Q',buf);assert vals[0]==0x50
    dt=vals[3];ft=vals[7];data=vals[9];result={}
    def walk(off,parent):
        while off!=0xffffffff:
            checkpoint()
            par,sib,child,first,hashlink,n=u('6I',buf,dt+off)
            name=bytes(buf[dt+off+24:dt+off+24+n]).decode()
            prefix=(parent+'/'+name).strip('/')
            f=first
            while f!=0xffffffff:
                fp,fs,fo,size,fh,fn=u('IIQQII',buf,ft+f)
                fname=bytes(buf[ft+f+32:ft+f+32+fn]).decode()
                result[(prefix+'/'+fname).strip('/')]=buf[data+fo:data+fo+size]
                assert len(result[(prefix+'/'+fname).strip('/')])==size
                f=fs
            if child!=0xffffffff:walk(child,prefix)
            off=sib
    walk(0,'');return result

