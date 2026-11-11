"""Run compiled SDK releases with fair interleaving or a preempted mutex owner.

--sdk-capture executes qualified SDK mutex slow paths from a private FS capture;
no captured system bytes are included in this repository or package.
"""
import argparse,base64,hashlib,json,random,struct
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE,UcError
from unicorn import arm64_const as R
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--templates',type=Path);parser.add_argument('--expect-race',action='store_true')
parser.add_argument('--priority-case',action='store_true');parser.add_argument('--sdk-capture',type=Path)
args=parser.parse_args();root=Path(__file__).resolve().parents[2]
template=args.templates or root/'native/prebuilt/templates.json'
t=json.loads(template.read_text())['runtime'];offsets=t['offsets'];code=bytearray(base64.b64decode(t['code']))
BASE=0x100000;CTX=0x400000;LAZY=0x410000;NODE=0x460000;OBJECT=0x470000;TLS=0x480000
SDK=0x700400;STACK=0x800000;RET=0x900000;FS=0x20000000;TAGS=[0x101,0x102];WAIT=0x40000000
for name,value in [('resident_context',CTX),('lazy_context',LAZY),('namespace_context',0)]:struct.pack_into('<Q',code,offsets[name],value)
sdk_page=None
if args.sdk_capture:
 raw=args.sdk_capture.read_bytes();range_=next(r for r in json.loads((root/'lib/native/fs-abi.json').read_text())['ranges'] if r['offset']==0x2187d0)
 assert hashlib.sha256(raw[range_['offset']:range_['offset']+range_['size']]).hexdigest()==range_['sha256']
 sdk_page=raw[0x218000:0x219000]
insns={i.address:i for i in Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN).disasm(bytes(code),BASE)}
if sdk_page:insns.update({i.address:i for i in Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN).disasm(sdk_page,FS+0x218000)})
def reg(name):return getattr(R,'UC_ARM64_REG_'+name.upper())
def check(seed,priority=False):
 u=Uc(UC_ARCH_ARM64,UC_MODE_ARM);u.mem_map(BASE,(len(code)+4095)&~4095);u.mem_write(BASE,bytes(code))
 for at,n in [(CTX,0x100000),(STACK,0x40000),(SDK&~4095,4096),(RET,4096),(FS+0x1000,4096),(FS+0x218000,4096)]:u.mem_map(at,n)
 if sdk_page:u.mem_write(FS+0x218000,sdk_page)
 def q(at,n):u.mem_write(at,struct.pack('<Q',n))
 def w(at,n):u.mem_write(at,struct.pack('<I',n))
 def readw(at):return int.from_bytes(u.mem_read(at,4),'little')
 q(CTX+64,NODE);q(CTX+112,FS+0x1077b0);q(CTX+336,SDK);q(NODE+8,OBJECT);w(NODE+32,24);w(NODE+36,1);w(NODE+44,1);w(OBJECT+24,3)
 for i,tag in enumerate(TAGS):w(TLS+i*4096+0x110,tag)
 who=0;freed=0;calls=[];blocked={};waits=[];contexts=[];pause_owner=priority;paused=False
 def returned(value=0):u.reg_write(R.UC_ARM64_REG_X0,value);u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30))
 def lock(owner,address,tag):
  assert address==NODE+40 and tag==TAGS[who]
  value=readw(address)
  if value&~WAIT==tag:returned();return
  # The owner can unlock after WAIT is set but before ArbitrateLock enters.
  # The kernel returns without sleeping when the owner word has changed;
  # the actual SDK slow path then retries its acquire CAS.
  if sdk_page and value!=(owner|WAIT):returned();return
  if not sdk_page and not value:w(address,tag);returned();return
  assert owner in TAGS and owner!=tag
  w(address,readw(address)|WAIT);blocked[who]=(address,tag);waits.append((who,owner));u.emu_stop()
 def unlock(address):
  assert address==NODE+40 and readw(address)&~WAIT==TAGS[who]
  waiter=next((i for i in blocked if blocked[i][0]==address),None)
  if waiter is not None:
   _,tag=blocked.pop(waiter);w(address,tag|(WAIT if blocked else 0))
  else:w(address,0)
  returned()
 def hook(uc,pc,size,_):
  nonlocal freed,paused
  if pc==RET:u.emu_stop();return
  if pause_owner and who==0 and readw(NODE+40)==TAGS[0]:paused=True;u.emu_stop();return
  if pc==SDK:
   assert u.reg_read(R.UC_ARM64_REG_X0)==OBJECT
   refs=readw(OBJECT+24)-1;assert refs>=0
   if refs==0:assert readw(NODE+40)==0,'Native destruction must run after unlocking'
   elif not args.expect_race:assert readw(NODE+40)&~WAIT==TAGS[who]
   w(OBJECT+24,refs);calls.append((who,refs))
   if not refs:freed+=1;u.mem_unmap(OBJECT,4096)
   returned();return
  if pc==FS+0x1248:
   lock(u.reg_read(R.UC_ARM64_REG_X0),u.reg_read(R.UC_ARM64_REG_X1),u.reg_read(R.UC_ARM64_REG_X2));return
  if pc==FS+0x1250:unlock(u.reg_read(R.UC_ARM64_REG_X0));return
  if not sdk_page and pc==FS+0x2187d0:
   address,owner,tag=[u.reg_read(reg('x'+str(i))) for i in range(3)];lock(owner&~WAIT,address,tag);return
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
 for i,sp in enumerate([STACK+0xf000,STACK+0x2f000]):
  u.reg_write(R.UC_ARM64_REG_TPIDRRO_EL0,TLS+i*4096);u.reg_write(R.UC_ARM64_REG_SP,sp);u.reg_write(R.UC_ARM64_REG_X30,RET);u.reg_write(R.UC_ARM64_REG_X0,OBJECT);u.reg_write(R.UC_ARM64_REG_PC,BASE+offsets['lfs_storage_release']);contexts.append(u.context_save())
 done=set();rng=random.Random(seed)
 def run(i,count):
  nonlocal who
  who=i;u.context_restore(contexts[i]);u.emu_start(u.reg_read(R.UC_ARM64_REG_PC),RET,count=count);contexts[i]=u.context_save()
  if u.reg_read(R.UC_ARM64_REG_PC)==RET:done.add(i)
 try:
  if priority:
   run(0,10000);assert paused and not calls
   pause_owner=False;run(1,10000);assert 1 in blocked and waits==[(1,TAGS[0])] and not calls,'Higher-priority waiter must ask kernel to wait'
   run(0,10000);assert 0 in done and 1 not in blocked
   run(1,10000);assert 1 in done
  else:
   for _ in range(20000):
    if len(done)==2:break
    eligible=[i for i in range(2) if i not in done and i not in blocked];assert eligible,('No runnable owner',seed,blocked,waits,calls,hex(readw(NODE+40)))
    run(rng.choice(eligible),rng.randrange(1,8))
   else:raise AssertionError('Release callbacks failed to finish')
 except UcError as error:
  pc=u.reg_read(R.UC_ARM64_REG_PC);return {'seed':seed,'race':True,'nativeOffset':hex(pc-BASE),'instruction':str(insns.get(pc)),'sdkReleases':calls,'error':str(error)}
 assert freed==1 and len(calls)==3 and not readw(NODE+36) and not readw(NODE+40),(freed,calls)
 return {'seed':seed,'race':False,'kernelWaits':len(waits),'qualifiedSdkExecuted':bool(sdk_page)}
if args.priority_case:
 result=check(0,True);assert not result['race'];print('Compiled ARM64 preempted owner: higher-priority waiter blocks in kernel, owner unlocks, single destruction outside mutex: passed',json.dumps(result))
else:
 for seed in range(400):
  r=check(seed)
  if r['race']:
   if args.expect_race:print(json.dumps(r,indent=2));break
   raise AssertionError(r)
 else:assert not args.expect_race,'Baseline race was not reproduced'
 if not args.expect_race:print('Compiled ARM64 final-release ownership: 400 interleaved schedules, priority mutex, single destruction outside lock, no freed-memory access: passed')
