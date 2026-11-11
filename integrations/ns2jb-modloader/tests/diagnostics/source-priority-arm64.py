"""Exercise source-cache priority waits or reproduce an older spin baseline."""
import argparse,base64,hashlib,json,struct
from pathlib import Path
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
from unicorn import arm64_const as R
root=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--expect-starvation',action='store_true');parser.add_argument('--templates',type=Path);parser.add_argument('--sdk-capture',type=Path)
args=parser.parse_args();template=args.templates or root/'native/prebuilt/templates.json'
t=json.loads(template.read_text())['runtime'];offsets=t['offsets'];code=bytearray(base64.b64decode(t['code']))
BASE=0x100000;CTX=0x400000;LAZY=0x410000;PLAN=0x420000;OWNER=PLAN+224;SOURCE=0x430000;FILE=0x440000;VT=0x441000;OUT=0x450000;PATH=0x460000;SRCFS=0x470000
TLS=0x480000;FS=0x20000000;TAGS=[0x101,0x102];WAIT=0x40000000
OPEN=0x700100;RETAIN=0x700200;RELEASE=0x700300;READ=0x700400;STACK=0x800000;RET=0x900000
for name,value in [('resident_context',CTX),('lazy_context',LAZY),('namespace_context',0)]:struct.pack_into('<Q',code,offsets[name],value)
u=Uc(UC_ARCH_ARM64,UC_MODE_ARM);u.mem_map(BASE,(len(code)+4095)&~4095);u.mem_write(BASE,bytes(code))
for at,n in [(CTX,0x100000),(OPEN&~4095,4096),(STACK,0x40000),(RET,4096),(FS+0x1000,4096),(FS+0x218000,4096)]:u.mem_map(at,n)
sdk_page=None
if args.sdk_capture:
 raw=args.sdk_capture.read_bytes();profile=json.loads((root/'lib/native/fs-abi.json').read_text());r=next(r for r in profile['ranges'] if r['offset']==0x2187d0)
 assert hashlib.sha256(raw[r['offset']:r['offset']+r['size']]).hexdigest()==r['sha256']
 sdk_page=raw[0x218000:0x219000];u.mem_write(FS+0x218000,sdk_page)
def reg(name):return getattr(R,'UC_ARM64_REG_'+name.upper())
def q(at,value):u.mem_write(at,struct.pack('<Q',value))
def w(at,value):u.mem_write(at,struct.pack('<I',value))
def rq(at):return int.from_bytes(u.mem_read(at,8),'little')
def rw(at):return int.from_bytes(u.mem_read(at,4),'little')
def returned(value=0):u.reg_write(R.UC_ARM64_REG_X0,value);u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30))
q(CTX+112,FS+0x1077b0);q(CTX+40,SRCFS);q(CTX+48,READ);q(CTX+128,OPEN);q(CTX+320,RELEASE)
q(PLAN+8,1);q(SOURCE,PATH);u.mem_write(PATH,b'/test/character.bntx.zs\0')
q(FILE,VT);q(VT,RETAIN);q(VT+8,RELEASE);w(FILE+32,1)
insns={i.address:i for i in Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN).disasm(code,BASE)}
if sdk_page:insns.update({i.address:i for i in Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN).disasm(sdk_page,FS+0x218000)})
blocked={};waits=[]
def lock(owner,address,tag):
 assert address==PLAN+16 and tag==TAGS[who]
 value=rw(address)
 if sdk_page and value!=(owner|WAIT):returned();return
 if not sdk_page and not value:w(address,tag);returned();return
 assert owner in TAGS and owner!=tag
 w(address,value|WAIT);blocked[who]=(address,tag);waits.append((who,owner));u.emu_stop()
def unlock(address):
 assert address==PLAN+16 and rw(address)&~WAIT==TAGS[who]
 waiter=next((i for i in blocked if blocked[i][0]==address),None)
 if waiter is None:w(address,0)
 else:
  _,tag=blocked.pop(waiter);w(address,tag|(WAIT if blocked else 0))
 returned()
who=0;pause=True;paused=False;opens=[];reads=[];retains=[];releases=[]
def hook(uc,pc,size,_):
 global paused
 if pc==RET:u.emu_stop();return
 if pc==OPEN:
  assert rw(PLAN+16)&~WAIT==(1 if args.expect_starvation else TAGS[who]) and rq(SOURCE)==PATH
  if pause and who==0:paused=True;u.emu_stop();return
  assert u.reg_read(R.UC_ARM64_REG_X0)==SRCFS+8
  q(rq(u.reg_read(R.UC_ARM64_REG_X1)),FILE);opens.append(who);returned();return
 if pc==RETAIN:
  assert u.reg_read(R.UC_ARM64_REG_X0)==FILE;w(FILE+32,rw(FILE+32)+1);retains.append(who);returned();return
 if pc==RELEASE:
  assert u.reg_read(R.UC_ARM64_REG_X0)==FILE;assert rw(FILE+32)>1;w(FILE+32,rw(FILE+32)-1);releases.append(who);returned();return
 if pc==READ:
  assert u.reg_read(R.UC_ARM64_REG_X0)==FILE
  assert not rw(PLAN+16) if args.expect_starvation else rw(PLAN+16)&~WAIT!=TAGS[who]
  n=u.reg_read(R.UC_ARM64_REG_X4);pair=u.reg_read(R.UC_ARM64_REG_X3);assert rq(pair+8)>=n
  u.mem_write(rq(pair),bytes([0x6a])*n);q(u.reg_read(R.UC_ARM64_REG_X1),n);reads.append(who);returned();return
 if pc==FS+0x1248:lock(u.reg_read(R.UC_ARM64_REG_X0),u.reg_read(R.UC_ARM64_REG_X1),u.reg_read(R.UC_ARM64_REG_X2));return
 if pc==FS+0x1250:unlock(u.reg_read(R.UC_ARM64_REG_X0));return
 if not sdk_page and pc==FS+0x2187d0:lock(u.reg_read(R.UC_ARM64_REG_X1)&~WAIT,u.reg_read(R.UC_ARM64_REG_X0),u.reg_read(R.UC_ARM64_REG_X2));return
 if not sdk_page and pc==FS+0x218870:unlock(u.reg_read(R.UC_ARM64_REG_X0));return
 i=insns.get(pc)
 if not i:return
 if i.mnemonic in ['bti','pacibsp','autibsp','xpaci','xpaclri']:u.reg_write(R.UC_ARM64_REG_PC,pc+4);return
 if i.mnemonic=='retab':u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30));return
 if i.mnemonic=='ldapr':
  dst,src=i.op_str.replace('[','').replace(']','').split(', ');n=4 if dst.startswith('w') else 8;u.reg_write(reg(dst),int.from_bytes(u.mem_read(u.reg_read(reg(src)),n),'little'));u.reg_write(R.UC_ARM64_REG_PC,pc+4);return
 if i.mnemonic.startswith(('ldadd','stadd','ldset','stset','cas','swp')):
  a=i.op_str.replace('[','').replace(']','').split(', ');n=4 if a[0].startswith('w') else 8;at=u.reg_read(reg(a[-1]));old=int.from_bytes(u.mem_read(at,n),'little');src=0 if a[0].endswith('zr') else u.reg_read(reg(a[0]));new=old
  if i.mnemonic.startswith('cas'):
   if old==src:new=u.reg_read(reg(a[1]))
   u.reg_write(reg(a[0]),old)
  else:
   new=src if i.mnemonic.startswith('swp') else old|src if i.mnemonic.startswith(('ldset','stset')) else old+src
   if len(a)==3 and not a[1].endswith('zr'):u.reg_write(reg(a[1]),old)
  u.mem_write(at,(new%2**(8*n)).to_bytes(n,'little'));u.reg_write(R.UC_ARM64_REG_PC,pc+4)
u.hook_add(UC_HOOK_CODE,hook)
contexts=[]
for i in range(2):
 w(TLS+i*4096+0x110,TAGS[i]);u.reg_write(R.UC_ARM64_REG_TPIDRRO_EL0,TLS+i*4096)
 u.reg_write(R.UC_ARM64_REG_SP,STACK+0xf000+i*0x20000);u.reg_write(R.UC_ARM64_REG_X30,RET)
 for r,value in enumerate([OWNER,SOURCE,0,OUT+i*4096,64]):u.reg_write(reg('x'+str(r)),value)
 u.reg_write(R.UC_ARM64_REG_PC,BASE+offsets['lfs_lazy_source_read']);contexts.append(u.context_save())
def run(i,count):
 global who
 who=i;u.context_restore(contexts[i]);u.emu_start(u.reg_read(R.UC_ARM64_REG_PC),RET,count=count);contexts[i]=u.context_save();return u.reg_read(R.UC_ARM64_REG_PC)
run(0,20000);assert paused and not opens and rw(PLAN+16)==(1 if args.expect_starvation else TAGS[0])
waiter=run(1,50000);assert waiter!=RET and not opens and not reads
waitingInstruction=str(insns.get(waiter))
if args.expect_starvation:
 assert not blocked and rw(PLAN+16)==1
else:
 assert blocked=={1:(PLAN+16,TAGS[1])} and waits==[(1,TAGS[0])]
pause=False;assert run(0,100000)==RET
assert not blocked and run(1,100000)==RET
assert rw(PLAN+16)==0 and rw(FILE+32)==1 and opens==[0] and reads==[0,1]
assert bytes(u.mem_read(OUT,64))==bytes([0x6a])*64 and bytes(u.mem_read(OUT+4096,64))==bytes([0x6a])*64
report={'expectedBaselineStarvation':args.expect_starvation,'qualifiedSdkExecuted':bool(sdk_page),'preemptedOwnerAtSdkOpen':True,'waiterSpinInstructions':50000 if args.expect_starvation else 0,'kernelWaits':waits,'bothReadsCompleted':True,'sourceCacheReferencePreserved':rw(FILE+32)==1,'cacheMutexReleased':rw(PLAN+16)==0}
print('Compiled ARM64 source-cache priority case:',json.dumps(report))
