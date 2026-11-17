"""Check that a void block-free callback cannot introduce trace errors."""
import runpy,struct
from pathlib import Path
from unicorn import UC_HOOK_CODE
from unicorn import arm64_const as R

s=runpy.run_path(str(Path(__file__).with_name('verify-arm64.py')))
u,q,readq,invoke=s['u'],s['q'],s['readq'],s['invoke']
LAZY,TRACE,live=s['LAZY'],s['TRACE'],s['live']
BLOCK,MANAGER,BLOCK_BYTES=0x480000,0x490000,0x3000
FREE,ALLOCATE=0x700400,0x700500
LAST=live+128+(64+16)*128+64*80
FIRST_ERROR=LAST+128
q(LAZY+24,MANAGER);q(LAZY+32,ALLOCATE);q(LAZY+40,FREE)
free_calls=[];scratch=0

def read32(at):return struct.unpack('<I',u.mem_read(at,4))[0]
def callback(uc,pc,size,_):
 if pc==FREE:
  args=[uc.reg_read(getattr(R,'UC_ARM64_REG_X'+str(i))) for i in range(3)]
  assert args==[MANAGER,BLOCK,BLOCK_BYTES],args
  free_calls.append(args)
  uc.mem_write(BLOCK,b'\xcc'*16)
  # A void callback may leave any value in the caller-saved result register.
  uc.reg_write(R.UC_ARM64_REG_X0,scratch)
 elif pc==ALLOCATE:
  assert uc.reg_read(R.UC_ARM64_REG_X0)==MANAGER
  assert uc.reg_read(R.UC_ARM64_REG_X2)==4096
  q(uc.reg_read(R.UC_ARM64_REG_X1),0)
  uc.reg_write(R.UC_ARM64_REG_X0,0x1234)
 else:return
 uc.reg_write(R.UC_ARM64_REG_PC,uc.reg_read(R.UC_ARM64_REG_X30))
u.hook_add(UC_HOOK_CODE,callback)

def check_free(register):
 global scratch
 scratch=register;q(BLOCK,BLOCK_BYTES)
 completed,errors,calls,writes=readq(live+56),readq(live+64),len(free_calls),len(s['writes'])
 first=bytes(u.mem_read(FIRST_ERROR,128))
 invoke('lfs_system_free',[BLOCK+16])
 assert len(free_calls)==calls+1
 assert readq(live+56)==completed+1 and read32(live+84)==0
 assert readq(live+64)==errors, 'Void block-free must not increment trace errors'
 assert bytes(u.mem_read(FIRST_ERROR,128))==first
 assert read32(LAST+64)==2 and read32(LAST+68)==22 and read32(LAST+76)==0
 assert readq(LAST+24)==BLOCK and readq(LAST+40)==BLOCK_BYTES
 assert readq(LAST+48)==0 and len(s['writes'])==writes

assert readq(live+64)==0 and readq(FIRST_ERROR)==0
for register in [0,0x1234,0xffffffffffffffff,MANAGER]:check_free(register)

# Allocation still reports real failures, and later frees preserve that error.
completed,writes=readq(live+56),len(s['writes'])
assert invoke('lfs_system_allocate',[1])==0
assert readq(live+56)==completed+1 and readq(live+64)==1
assert read32(FIRST_ERROR+68)==21 and read32(FIRST_ERROR+76)==0x1234
assert len(s['writes'])==writes
check_free(0xdeadbeef)

# A null free has no callback or trace activity.
before=bytes(u.mem_read(TRACE,49152));calls=len(free_calls)
invoke('lfs_system_free',[0])
assert len(free_calls)==calls and bytes(u.mem_read(TRACE,49152))==before

# Disabling tracing must still release the original block exactly once.
q(LAZY+s['abi']['trace'],0);q(BLOCK,BLOCK_BYTES)
invoke('lfs_system_free',[BLOCK+16])
assert len(free_calls)==calls+1 and bytes(u.mem_read(TRACE,49152))==before
assert len(s['writes'])==writes
print('Compiled ARM64 block-free: void callback, completion records, error preservation, null free and disabled tracing: passed')
