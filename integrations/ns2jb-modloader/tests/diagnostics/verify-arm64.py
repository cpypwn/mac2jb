import base64,json,struct
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
from unicorn import arm64_const as R
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN

root=Path(__file__).resolve().parents[2]
t=json.loads((root/'native/prebuilt/templates.json').read_text())['runtime']
abi={'trace':168,'file':8,'initialized':40,'next_checkpoint':16,'live':200,'saved':16584,'page':16384}
offsets=t['offsets'];code=bytearray(base64.b64decode(t['code']))
BASE=0x100000;CTX=0x400000;LAZY=0x410000;TRACE=0x420000;FILE=0x450000;STACK=0x800000;RET=0x900000
for field,value in [('resident_context',CTX),('lazy_context',LAZY),('namespace_context',0)]:struct.pack_into('<Q',code,offsets[field],value)
u=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
u.mem_map(BASE,(len(code)+4095)&~4095);u.mem_write(BASE,bytes(code))
for at,size in [(CTX,0x100000),(STACK,0x20000),(RET,0x1000),(0x700000,0x1000),(0x600000,0x1000)]:u.mem_map(at,size)
def q(at,n):u.mem_write(at,struct.pack('<Q',n))
def readq(at):return struct.unpack('<Q',u.mem_read(at,8))[0]
q(LAZY+abi['trace'],TRACE);q(TRACE+abi['file'],FILE);u.mem_write(0x600110,struct.pack('<I',0x101))
u.mem_write(TRACE+abi['initialized'],struct.pack('<I',0))
live=TRACE+abi['live'];u.mem_write(live,b'NS2TRC01'+struct.pack('<II',1,16384));q(live+32,19200000)
q(CTX+168,0x700100);q(CTX+176,0x700200)
md=Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN);insns={i.address:i for i in md.disasm(bytes(code),BASE)}
writes=[];ticks=0;native_sizes=0
def reg(name):return getattr(R,'UC_ARM64_REG_'+name.upper())
def ret(value=0):u.reg_write(R.UC_ARM64_REG_X0,value);u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30))
def hook(uc,pc,size,_):
 global ticks,native_sizes
 if pc==RET:uc.emu_stop();return
 if pc==0x700100:
  file,at,pair,n=[uc.reg_read(reg('x'+str(i))) for i in range(4)];assert file==FILE and ((n==16384 and at in [0,16384]) or (n==4096 and at in [32768,36864]))
  address,capacity=struct.unpack('<QQ',uc.mem_read(pair,16));assert capacity==n
  if n==4096:assert uc.reg_read(R.UC_ARM64_REG_X4)==1
  writes.append((at,bytes(uc.mem_read(address,n))));ret();return
 if pc==0x700200:ret();return
 if pc==0x700300:
  native_sizes+=1;ret(0x1234);return
 i=insns.get(pc)
 if not i:return
 if i.mnemonic in ['bti','pacibsp','autibsp']:uc.reg_write(R.UC_ARM64_REG_PC,pc+4);return
 if i.mnemonic=='retab':ret(uc.reg_read(R.UC_ARM64_REG_X0));return
 if i.mnemonic=='mrs':
  dst,src=i.op_str.split(', ')
  assert src.lower()!='cntvct_el0', 'Virtual counter must never be used on Horizon'
  if src.lower() in ['cntpct_el0','cntfrq_el0','tpidrro_el0']:
   if src.lower()=='tpidrro_el0':value=0x600000
   else:
    ticks+=100;value=ticks if src.lower()=='cntpct_el0' else 19200000
   uc.reg_write(reg(dst),value);uc.reg_write(R.UC_ARM64_REG_PC,pc+4);return
 if i.mnemonic=='ldapr':
  dst,base=i.op_str.replace('[','').replace(']','').split(', ');width=4 if dst.startswith('w') else 8;uc.reg_write(reg(dst),int.from_bytes(uc.mem_read(uc.reg_read(reg(base)),width),'little'));uc.reg_write(R.UC_ARM64_REG_PC,pc+4);return
 if i.mnemonic.startswith(('ldadd','stadd','ldset','stset','cas','swp')):
  op=i.op_str.replace('[','').replace(']','').split(', ');width=4 if op[0].startswith('w') else 8;at=uc.reg_read(reg(op[-1]));old=int.from_bytes(uc.mem_read(at,width),'little');src=0 if op[0].endswith('zr') else uc.reg_read(reg(op[0]));new=old
  if i.mnemonic.startswith('cas'):
   if old==src:new=uc.reg_read(reg(op[1]))
   uc.reg_write(reg(op[0]),old)
  else:
   new=src if i.mnemonic.startswith('swp') else old|src if i.mnemonic.startswith(('ldset','stset')) else old+src
   if len(op)==3 and not op[1].endswith('zr'):uc.reg_write(reg(op[1]),old)
  uc.mem_write(at,(new%2**(8*width)).to_bytes(width,'little'));uc.reg_write(R.UC_ARM64_REG_PC,pc+4)
u.hook_add(UC_HOOK_CODE,hook)
def invoke(name,args):
 u.reg_write(R.UC_ARM64_REG_SP,STACK+0x1f000);u.reg_write(R.UC_ARM64_REG_X30,RET)
 for i,v in enumerate(args):u.reg_write(reg('x'+str(i)),v)
 u.emu_start(BASE+offsets[name],RET,count=2000000);assert u.reg_read(R.UC_ARM64_REG_PC)==RET
 return u.reg_read(R.UC_ARM64_REG_X0)
q(CTX+120,0x700300)
# In the default text-only mode the trace pointer is null: no counter/TLS
# access from tracing, recorder state changes or trace SD operations may occur.
# The preparation mutex independently uses its normal SDK TLS owner tag.
q(LAZY+abi['trace'],0)
before_ticks=ticks;before_writes=len(writes);before=bytes(u.mem_read(TRACE,49152))
invoke('lfs_trace_initialize',[])
assert invoke('lfs_trace_begin',[3,FILE,1,0,512])==0
invoke('lfs_trace_end',[1,0,512,0,0]);invoke('lfs_trace_checkpoint',[1]);invoke('lfs_trace_io_progress',[1,1,0,512,0])
invoke('lfs_lazy_plan_lock',[]);invoke('lfs_lazy_plan_unlock',[])
assert ticks==before_ticks and len(writes)==before_writes and bytes(u.mem_read(TRACE,49152))==before
q(LAZY+abi['trace'],TRACE)
assert invoke('lfs_trace_clock_probe',[TRACE+49136])==0 and readq(TRACE+49144)==19200000
invoke('lfs_activate',[]);assert not writes and struct.unpack('<I',u.mem_read(TRACE+abi['initialized'],4))[0]==2
token=invoke('lfs_trace_begin',[3,FILE,0,0x100000007,512]);assert token and writes
assert struct.unpack('<I',u.mem_read(live+84,4))[0]==1
invoke('lfs_trace_end',[token,0,512,0,0]);assert struct.unpack('<I',u.mem_read(live+84,4))[0]==0
invoke('lfs_trace_checkpoint',[1]);assert len(writes)>=2
page=[b for _,b in writes if len(b)==16384][-1];assert struct.unpack_from('<Q',page,56)[0]==1
records=[page[128+i*128:256+i*128] for i in range(64)]
assert any(struct.unpack_from('<Q',r,32)[0]==0x100000007 and struct.unpack_from('<I',r,64)[0]==2 for r in records)
q(TRACE+abi['next_checkpoint'],0xffffffffffffffff)
for i in range(100):
 token=invoke('lfs_trace_begin',[3,FILE,0,i,64]);invoke('lfs_trace_end',[token,0,64,0,0])
before=len(writes);invoke('lfs_trace_checkpoint',[1]);assert len(writes)==before+5
out=bytearray(40960)
for at,page in writes:out[at:at+len(page)]=page
qa=root/'state/qa';qa.mkdir(parents=True,exist_ok=True);(qa/'arm64-checkpoint4.trace').write_bytes(out)
# An immutable view bypasses the original native GetSize and performs no journal I/O.
NODE=0x460000;VIEW=0x461000;OUT=0x462000;OBJECT=0x463000
q(CTX+64,NODE);q(NODE+8,OBJECT);q(NODE+24,VIEW);q(NODE+64,VIEW);q(VIEW+8,19071029520)
u.mem_write(NODE+36,struct.pack('<I',1));u.mem_write(NODE+44,struct.pack('<I',1))
before=len(writes)
for i in range(100):assert invoke('lfs_size',[OBJECT,OUT])==0 and readq(OUT)==19071029520
assert len(writes)==before and native_sizes==0
assert invoke('lfs_size',[OBJECT+0x100,OUT])==0x1234 and native_sizes==1
before=len(writes)
# The actual plan-lock wrappers and native lifecycle breadcrumbs stay in RAM,
# even with the next snapshot overdue. A later normal snapshot retains them.
q(TRACE+abi['next_checkpoint'],0)
invoke('lfs_lazy_plan_lock',[])
assert len(writes)==before
pending=bytes(u.mem_read(live+128+64*128,16*128))
assert any(struct.unpack_from('<Q',pending,i*128)[0] and struct.unpack_from('<I',pending,i*128+68)[0]==15 for i in range(16))
invoke('lfs_lazy_plan_unlock',[]);assert len(writes)==before
holder=invoke('lfs_trace_begin',[14,0xabc,1,0,0]);native=invoke('lfs_trace_begin',[19,FILE,1,0,64])
assert holder and native and len(writes)==before
invoke('lfs_trace_checkpoint',[1]);assert len(writes)==before+5
page=[b for _,b in writes if len(b)==16384][-1]
assert struct.unpack_from('<I',page,84)[0]==2
pending=[page[128+64*128+i*128:128+64*128+(i+1)*128] for i in range(16)]
assert {struct.unpack_from('<I',r,68)[0] for r in pending if struct.unpack_from('<Q',r)[0]}=={14,19}
before=len(writes);invoke('lfs_trace_end',[native,0,64,0,0]);invoke('lfs_trace_end',[holder,0,0,0,0]);assert len(writes)==before
out=bytearray(40960)
for at,page in writes:out[at:at+len(page)]=page
(qa/'arm64-checkpoint4.trace').write_bytes(out)
print('Compiled ARM64 trace: physical counter, ABI, 64-bit ranges, ring, journal, immutable size, memory-only lock ownership and lifecycle snapshots: passed')
