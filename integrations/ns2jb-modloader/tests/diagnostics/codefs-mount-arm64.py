"""Exercise compiled CodeFS mount ABI and ordinary FS passthrough."""
import runpy,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn import arm64_const as R

s=runpy.run_path(str(Path(__file__).with_name('verify-arm64.py')))
u,q,invoke=s['u'],s['q'],s['invoke'];CTX,LAZY,BASE=s['CTX'],s['LAZY'],s['BASE']
NS,OUT,DEST,VERIFY,PATH,FSOBJ=0x480000,0x481000,0x482000,0x483000,0x484000,0x485000
FACTORY,OPEN,TYPE,DIRECTORY=0x700400,0x700500,0x700600,0x700700
ROOT,PROGRAM,ATTR,STORAGE=0x123456788000,0x04006e001823c001,13,5
q(BASE+s['offsets']['lfs_codefs_original_address'],FACTORY)
q(CTX+56,NS);q(CTX+64,0);q(CTX+160,0)
u.mem_write(NS,struct.pack('<II',0,0x34465343)+bytes(104))
q(NS+8,OPEN);q(NS+16,DIRECTORY);q(NS+24,TYPE)
q(LAZY+72,0);q(LAZY+88,0)
q(OUT,DEST);q(FSOBJ+40,1)
u.mem_write(VERIFY,b'Verification')
calls=[];failure=0;identity_probes=0
def returned(value=0):
 u.reg_write(R.UC_ARM64_REG_X0,value)
 u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30))
def args(n):return [u.reg_read(getattr(R,'UC_ARM64_REG_X'+str(i))) for i in range(n)]
def native(uc,pc,size,_):
 global identity_probes
 if pc==FACTORY:
  a=args(6);assert a==[ROOT,OUT,VERIFY,ATTR,PROGRAM,STORAGE],a
  q(DEST,0 if failure else FSOBJ);u.mem_write(VERIFY,b'WrittenByFactory');calls.append('mount');returned(failure)
 elif pc==OPEN:
  fs,out,p,mode=args(4);name=bytes(u.mem_read(p,64)).split(b'\0')[0]
  if fs==FSOBJ+8 and name==b'/main.npdm':
   identity_probes+=1;q(struct.unpack('<Q',u.mem_read(out,8))[0],0);returned(0x202)
  else:
   assert fs==FSOBJ+0x1008 and name==b'/save/progress' and mode==1,(hex(fs),name,mode)
   q(struct.unpack('<Q',u.mem_read(out,8))[0],FSOBJ+0x2000);calls.append('open');returned()
 elif pc==TYPE:
  fs,out,p=args(3);assert fs==FSOBJ+0x1008 and bytes(u.mem_read(p,64)).split(b'\0')[0]==b'/save/progress'
  u.mem_write(out,struct.pack('<I',1));calls.append('type');returned()
 elif pc==DIRECTORY:
  fs,out,p,mode=args(4);assert fs==FSOBJ+0x1008 and bytes(u.mem_read(p,64)).split(b'\0')[0]==b'/' and mode==0x80000002
  q(struct.unpack('<Q',u.mem_read(out,8))[0],FSOBJ+0x3000);calls.append('directory');returned()
u.hook_add(UC_HOOK_CODE,native)
before=len(s['writes'])
assert invoke('lfs_namespace_mount',[ROOT,OUT,VERIFY,ATTR,PROGRAM,STORAGE])==0
assert bytes(u.mem_read(VERIFY,16))==b'WrittenByFactory' and struct.unpack('<Q',u.mem_read(DEST,8))[0]==FSOBJ
failure=0x1234
assert invoke('lfs_namespace_mount',[ROOT,OUT,VERIFY,ATTR,PROGRAM,STORAGE])==failure
assert struct.unpack('<Q',u.mem_read(DEST,8))[0]==0 and not identity_probes
# Active CodeFS preparation may inspect NPDM only on the known mount. An
# unchanged code mount retains no SDK object/cache reference and does no I/O.
failure=0;u.mem_write(NS,struct.pack('<I',1))
assert invoke('lfs_namespace_mount',[ROOT,OUT,VERIFY,ATTR,PROGRAM,STORAGE])==0
assert identity_probes==1 and struct.unpack('<I',u.mem_read(FSOBJ+40,4))[0]==1
for _ in range(32):
 u.mem_write(PATH,b'/save/progress\0')
 assert invoke('lfs_namespace_open',[FSOBJ+0x1008,OUT,PATH,1,NS])==0
 assert invoke('lfs_namespace_type',[FSOBJ+0x1008,DEST,PATH,NS])==0
 u.mem_write(PATH,b'/\0')
 assert invoke('lfs_namespace_directory',[FSOBJ+0x1008,OUT,PATH,0x80000002,NS])==0
assert identity_probes==1 and len(s['writes'])==before
assert struct.unpack('<Q',u.mem_read(CTX+64,8))[0]==0
assert calls.count('mount')==3 and calls.count('open')==32 and calls.count('type')==32 and calls.count('directory')==32
print('Compiled ARM64 CodeFS: six arguments/output/error forwarding, scoped identity read, 96 ordinary FS calls without probes/references and memory-only trace: passed')
