"""Check compiled NSO Build-ID selection for title-local and global IPS files."""
import runpy,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn import arm64_const as R

s=runpy.run_path(str(Path(__file__).with_name('verify-arm64.py')))
u,q,invoke=s['u'],s['q'],s['invoke'];CTX,LAZY=s['CTX'],s['LAZY']
FILE,SPEC,HEADER,COUNT,GAMES,PATCHES,NAMES=0x480000,0x481000,0x482000,0x483000,0x484000,0x485000,0x486000
READ=0x700500;PROGRAM=0x0400c3f00006e000
u.mem_write(HEADER,b'NSO0'+bytes(60)+bytes([0x12])+bytes(191))
u.mem_write(SPEC,bytes(112));q(SPEC,NAMES+128);q(SPEC+8,1024);u.mem_write(NAMES+128,b'main\0')
u.mem_write(PATCHES,bytes(240));u.mem_write(NAMES,b'exefs/12.ips\0');q(PATCHES,NAMES);u.mem_write(PATCHES+72,struct.pack('<I',6))
u.mem_write(NAMES+32,b'exefs/34.ips32\0');q(PATCHES+80,NAMES+32);u.mem_write(PATCHES+80+72,struct.pack('<I',6))
u.mem_write(NAMES+64,b'sdk\0');q(PATCHES+160,NAMES+64);u.mem_write(PATCHES+160+72,struct.pack('<I',2))
q(GAMES,PROGRAM);q(GAMES+8,3);q(GAMES+16,PATCHES);q(LAZY+72,1);q(LAZY+80,GAMES);q(LAZY+88,0);q(CTX+304,READ);q(CTX+160,0)
reads=[]
def native(uc,pc,size,_):
 if pc!=READ:return
 args=[u.reg_read(getattr(R,'UC_ARM64_REG_X'+str(i))) for i in range(6)]
 obj,count,at,pair,n,opt=args;assert obj==FILE and at==0 and n==256 and opt==0
 out,capacity=struct.unpack('<QQ',u.mem_read(pair,16));assert capacity>=n
 u.mem_write(out,bytes(u.mem_read(HEADER,n)));q(count,n);reads.append(obj)
 u.reg_write(R.UC_ARM64_REG_X0,0);u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30))
u.hook_add(UC_HOOK_CODE,native)
def probe(program):
 q(COUNT,0xffff);assert invoke('lfs_lazy_probe_nso',[FILE,SPEC,program,COUNT])==0
 return struct.unpack('<Q',u.mem_read(COUNT,8))[0]
assert probe(PROGRAM)==1 and len(reads)==1
assert probe(PROGRAM+1)==0 and len(reads)==1 # Same NSO, different title: no probe/read.
u.mem_write(PATCHES+72,struct.pack('<I',7));assert probe(PROGRAM)==1
q(LAZY+88,1);q(LAZY+96,PATCHES)
assert probe(PROGRAM)==2 and probe(PROGRAM+1)==1
u.mem_write(HEADER+64,b'\x34');assert probe(PROGRAM)==1 and probe(PROGRAM+1)==0
u.mem_write(HEADER,b'DATA');assert probe(PROGRAM)==0
print('Compiled ARM64 IPS: scoped/global Build-ID matching, unchanged foreign title without global patches, shared modules, non-NSO passthrough: passed')
