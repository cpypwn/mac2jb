import json,struct,random,sys
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
import unicorn.arm64_const as R
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN
import argparse,subprocess,hashlib
parser=argparse.ArgumentParser(description="Qualify compiled ARM64 readers with modeled SDK objects and source data.")
parser.add_argument('plan',type=Path);parser.add_argument('build',type=Path);parser.add_argument('--diagnostics',action='store_true');args=parser.parse_args()
D=args.build.resolve().parent
plan=json.loads(args.plan.read_text());layout=json.loads((args.build/'combined-layout.json').read_text());payload=(args.plan.parent/plan['payload']['filename']).read_bytes()
bootstrap="""const fs=require('node:fs');const {buildContext}=require('./lib/context.cjs');const p=JSON.parse(fs.readFileSync(process.argv[1])),n=JSON.parse(fs.readFileSync(process.argv[2]));if(process.argv[4]==='true'){const d=require('./lib/diagnostics.cjs'),r=d.report({session:'switch2-nativeqa',sdPath:d.logPath('switch2-nativeqa'),plan:p});p.diagnostics={...r,buffer:undefined,text:r.buffer.toString(),size:r.buffer.length};}else delete p.diagnostics;process.stdout.write(buildContext(p,{filesystem:{object:0x5200000200n},...(p.diagnostics?{logFile:{object:0x5200000400n,write:BigInt(n.base)+0x105000n,flush:BigInt(n.base)+0x105300n}}:{})},BigInt(n.base),BigInt(n.address),n,1,fs.readFileSync(process.argv[3])).toString('hex'));"""
context=bytes.fromhex(subprocess.check_output(['node','-e',bootstrap,str(args.plan.resolve()),str((args.build/'combined-layout.json').resolve()),str((args.plan.parent/plan['payload']['filename']).resolve()),str(args.diagnostics).lower()],cwd=Path(__file__).resolve().parent.parent).decode())
code=(args.build/'runtime.bin').read_bytes();gateway=(args.build/'combined.bin').read_bytes()
assert hashlib.sha256(code).hexdigest()==layout['runtimeSha256'] and hashlib.sha256(gateway).hexdigest()==layout['sha256']
BASE=int(layout['base']);CTX=int(layout['address']);RUNTIME=int(layout['runtimeAddress']);STACK=0x5000000000;ARGS=0x5100000000;OUTPUT=ARGS+0x4000;OBJ=0x5200000000;HEAP=0x5300000000;RETURN=0x5400000000
md=Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN);insns={i.address:i for i in md.disasm(code,RUNTIME)};insns.update({i.address:i for i in md.disasm(gateway,BASE+0x24d100)})

def q(b,off=0):return struct.unpack_from('<Q',b,off)[0]
def pack(x):return struct.pack('<Q',x)
def reg(name):return getattr(R,'UC_ARM64_REG_'+name.upper())
class Model:
 def __init__(self,view=None,matches=True,ref_offset=32):
  self.uc=Uc(UC_ARCH_ARM64,UC_MODE_ARM);self.view=view;self.matches=matches;self.ref_offset=ref_offset;self.next_obj=OBJ+0x10000;self.next_heap=HEAP;self.objects={};self.regions=[];self.trace=[];self.source_error=0;self.original_error=0;self.short=False;self.alloc_fail=False;self.freed=[];self.steps=0
  self.report=None;self.log_write_error=0;self.log_flush_error=0;self.log_writes=0;self.log_flushes=0;self.logger_calls=0
  for at,size in [(BASE+0x240000,0x10000),(RUNTIME,len(code)),(CTX,(len(context)+4095)&~4095),(STACK,0x20000),(ARGS,0x210000),(OBJ,0x200000),(HEAP,0x200000),(RETURN,4096),(BASE+0x69000,4096),(BASE+0x4b000,4096),(BASE+0x103000,0x6000),(BASE+0x150000,4096)]:self.uc.mem_map(at,size)
  self.uc.mem_write(RUNTIME,code);self.uc.mem_write(BASE+0x24d100,gateway);self.uc.mem_write(CTX,context)
  for h in layout['hooks']:self.uc.mem_write(int(h['target']),bytes.fromhex(h['replacementHex']))
  self.file_table=OBJ+0x1000;self.fs_table=OBJ+0x2000;self.dir_table=OBJ+0x3000;self.storage_table=OBJ+0x4000
  targets=layout['sdk']['targets']
  for vt,kind in [(self.file_table,'file'),(self.fs_table,'fs'),(self.dir_table,'dir'),(self.storage_table,'storage')]:
   slots=[BASE+0x150000]*16;slots[0]=BASE+(0x4b8c0 if kind=='fs' else 0x1036f0);slots[1]=BASE+targets[{'fs':'filesystemRelease','dir':'directoryRelease','storage':'storageRelease','file':'fileRelease'}[kind]];slots[4]=BASE+(0x107570 if kind=='storage'else targets['directoryRead']if kind=='dir'else targets['fileRead']);slots[5]=BASE+targets['directoryCount'];slots[8]=BASE+(0x107600 if kind=='storage'else targets['fileSize']);self.uc.mem_write(vt,b''.join(pack(v)for v in slots))
  self.source=self.object('fs',address=OBJ+0x200,sd=True,ref=1,ref_offset=40)
  self.log_file=self.object('file',address=OBJ+0x400,size=q(context,192))
  if view:
   self.storage=self.object('storage',ref_offset=ref_offset)
   metadata=view.get('originalMetadata')
   if metadata:
    self.regions=[(x['offset'],(Path(metadata['directory'])/metadata['label']/x['filename']).read_bytes())for x in metadata['metadata']]
   self.regions +=[(0,bytes.fromhex(view['headerHex'])),(view['fingerprintFileEntryOffset'],bytes.fromhex(view['originalFileEntryHex'])),(view['fingerprintDataOffset'],bytes.fromhex(view['originalPrefixHex']))]
  self.uc.hook_add(UC_HOOK_CODE,self.hook)
 def u64(self,addr):return q(self.uc.mem_read(addr,8))
 def u32(self,addr):return struct.unpack('<I',self.uc.mem_read(addr,4))[0]
 def object(self,kind,address=None,ref=1,ref_offset=None,**kw):
  address=address or self.next_obj;self.next_obj=max(self.next_obj,address+0x100)
  off=ref_offset if ref_offset is not None else (40 if kind=='fs'else 32);vt=self.fs_table if kind=='fs'else self.dir_table if kind=='dir'else self.storage_table if kind=='storage'else self.file_table
  self.uc.mem_write(address,bytes(128));self.uc.mem_write(address,pack(vt));self.uc.mem_write(address+off,struct.pack('<I',ref));self.objects[address]=dict(kind=kind,ref_offset=off,dead=False,vtable=vt,**kw);return address
 def bytes_at(self,offset,n):
  out=bytearray([0x6b])*n
  for start,data in self.regions:
   lo=max(offset,start);hi=min(offset+n,start+len(data))
   if hi>lo:out[lo-offset:hi-offset]=data[lo-start:hi-start]
  if not self.matches and offset==0 and n:out[0]^=1
  return bytes(out)
 def file_bytes(self,obj,offset,n):
  n=min(n,max(0,obj['size']-offset));out=bytearray([sum(obj.get('remote','').encode())%251 if obj.get('remote')else 0x6b])*n
  for at,data in obj.get('regions',[]):
   lo=max(at,offset);hi=min(at+len(data),offset+n)
   if hi>lo:out[lo-offset:hi-offset]=data[lo-at:hi-at]
  return bytes(out)
 def string(self,addr):
  data=bytearray()
  for i in range(0x302):
   b=self.uc.mem_read(addr+i,1)[0]
   if not b:return data.decode()
   data.append(b)
  raise AssertionError('unterminated string')
 def ret(self,n=0):self.uc.reg_write(R.UC_ARM64_REG_X0,n);self.uc.reg_write(R.UC_ARM64_REG_PC,self.uc.reg_read(R.UC_ARM64_REG_X30))
 def hook(self,uc,pc,size,user):
  if pc==RETURN:uc.emu_stop();return
  self.steps+=1
  a=[uc.reg_read(reg('x'+str(i)))for i in range(6)]
  if pc in[RUNTIME+layout['offsets']['lfs_observe'],RUNTIME+layout['offsets']['lfs_flush']]:self.logger_calls+=1
  if pc==BASE+0x105000:
   obj,offset,pair,n,option=a[:5];assert obj==self.log_file and offset==0 and option==0;ptr,cap=struct.unpack('<QQ',uc.mem_read(pair,16));assert n==cap==q(context,192) and n<=1024*1024
   self.log_writes+=1
   if not self.log_write_error:self.report=bytes(uc.mem_read(ptr,n))
   self.ret(self.log_write_error);return
  if pc==BASE+0x105300:
   assert a[0]==self.log_file;self.log_flushes+=1;self.ret(self.log_flush_error);return
  if pc==BASE+0x694c0:
   if self.alloc_fail:self.ret(0);return
   ptr=self.next_heap;self.next_heap+=(a[0]+15)&~15;assert self.next_heap<HEAP+0x200000;self.ret(ptr);return
  if pc==BASE+0x69580:self.ret();return
  if pc in [BASE+0x1036f0,BASE+0x4b8c0]+[BASE+layout['sdk']['original'][name]for name in ['fileRelease','filesystemRelease','storageRelease','directoryRelease']]:
   obj=a[0];entry=self.objects[obj];off=entry['ref_offset'];refs=self.u32(obj+off);assert refs>0 and not entry['dead'],('dead reference',hex(obj),hex(pc))
   assert self.u64(obj)==entry['vtable'],'SDK CFI rejected a changed service vtable'
   refs+=1 if pc in[BASE+0x1036f0,BASE+0x4b8c0]else -1;uc.mem_write(obj+off,struct.pack('<I',refs))
   if not refs:entry['dead']=True;self.freed.append(obj)
   self.ret();return
  if pc==BASE+layout['originalSize']:
   assert self.view and a[0]==self.storage;self.trace.append(('size',));uc.mem_write(a[1],pack(self.view['storageSize']));self.ret(self.original_error);return
  if pc==BASE+0x1077b0:
   assert self.view and a[0]==self.storage+8
   offset,n=a[1],a[3];ptr,cap=struct.unpack('<QQ',uc.mem_read(a[2],16));assert n<=cap;self.trace.append(('original',offset,n))
   if self.original_error:self.ret(self.original_error);return
   if offset+n>self.view['storageSize']:self.ret(0xc102);return
   uc.mem_write(ptr,self.bytes_at(offset,n));self.ret();return
  if pc==BASE+layout['sdk']['original']['fileRead']:
   obj,out,offset,pair,n,opt=a;assert opt==0;entry=self.objects[obj];ptr,cap=struct.unpack('<QQ',uc.mem_read(pair,16));assert n<=cap and not entry['dead']
   self.trace.append(('file',entry.get('remote',entry.get('name','')),offset,n))
   if self.source_error:self.ret(self.source_error);return
   data=self.file_bytes(entry,offset,n);uc.mem_write(ptr,data);uc.mem_write(out,pack(max(0,len(data)-int(self.short))));self.ret();return
  if pc==BASE+layout['sdk']['original']['fileSize']:
   entry=self.objects[a[0]];uc.mem_write(a[1],pack(entry['size']));self.ret();return
  for kind,offset in layout['namespace']['original'].items():
   if pc!=BASE+offset:continue
   fs,out,path,mode=a[:4];assert fs-8 in self.objects;f=self.objects[fs-8];name=self.string(path);self.trace.append((kind,name,bool(f.get('sd'))))
   if kind=='open':
    target=None
    if f.get('sd'):
     source=next(row for row in plan['sources']if row['sdPath']==name);target=self.object('file',size=source['size'],remote=name)
    elif name in self.code_files:
     target=self.object('file',name=name,**self.code_files[name])
    if not target:self.ret(0x202);return
    slot=self.u64(out);uc.mem_write(slot,pack(target));self.ret();return
   if kind=='directory':
    if name!='/':self.ret(0x202);return
    slot=self.u64(out);target=self.object('dir');uc.mem_write(slot,pack(target));self.ret();return
   if kind=='type':
    if name not in self.code_files:self.ret(0x202);return
    uc.mem_write(out,struct.pack('<I',1));self.ret();return
  ins=insns.get(pc)
  if ins and ins.mnemonic in ['pacibsp','bti','autibsp']:uc.reg_write(R.UC_ARM64_REG_PC,pc+4);return
  if ins and ins.mnemonic=='retab':self.ret(a[0]);return
  if ins and ins.mnemonic=='ldapr':
   dst,base=ins.op_str.replace('[','').replace(']','').split(', ');width=4 if dst.startswith('w')else 8;uc.reg_write(reg(dst),int.from_bytes(uc.mem_read(uc.reg_read(reg(base)),width),'little'));uc.reg_write(R.UC_ARM64_REG_PC,pc+4);return
  if ins and (ins.mnemonic.startswith('ldadd')or ins.mnemonic.startswith('stadd')or ins.mnemonic.startswith('cas')or ins.mnemonic.startswith('swp')):
   op=ins.op_str.replace('[','').replace(']','').split(', ');width=4 if op[0].startswith('w')else 8;addr=uc.reg_read(reg(op[-1]));old=int.from_bytes(uc.mem_read(addr,width),'little');src=0 if op[0].endswith('zr')else uc.reg_read(reg(op[0]));new=old
   if ins.mnemonic.startswith('cas'):
    if old==src:new=uc.reg_read(reg(op[1]))
    uc.reg_write(reg(op[0]),old)
   else:
    new=src if ins.mnemonic.startswith('swp')else old+src
    if len(op)==3 and not op[1].endswith('zr'):uc.reg_write(reg(op[1]),old)
   uc.mem_write(addr,(new%2**(8*width)).to_bytes(width,'little'));uc.reg_write(R.UC_ARM64_REG_PC,pc+4);return
 def invoke(self,entry,args):
  uc=self.uc;sp=STACK+0x1e000;uc.reg_write(R.UC_ARM64_REG_SP,sp);uc.reg_write(R.UC_ARM64_REG_X30,RETURN)
  preserved={i:0x1234560000+i for i in range(18,30)}
  for i,v in preserved.items():uc.reg_write(reg('x'+str(i)),v)
  for i,v in enumerate(args):uc.reg_write(reg('x'+str(i)),v)
  try:uc.emu_start(entry,RETURN,count=4000000)
  except Exception:
   print('At',hex(uc.reg_read(R.UC_ARM64_REG_PC)),'entry',hex(entry),'args',args,'last',self.trace[-8:],file=sys.stderr);raise
  assert uc.reg_read(R.UC_ARM64_REG_PC)==RETURN,('did not return',hex(uc.reg_read(R.UC_ARM64_REG_PC)))
  assert uc.reg_read(R.UC_ARM64_REG_SP)==sp
  for i,v in preserved.items():assert uc.reg_read(reg('x'+str(i)))==v,('clobbered',i)
  assert self.u64(CTX+96)==0
  return uc.reg_read(R.UC_ARM64_REG_X0)&0xffffffff
 def read(self,offset,n):
  self.uc.mem_write(ARGS,pack(OUTPUT)+pack(n));self.uc.mem_write(OUTPUT-16,b'G'*16);self.uc.mem_write(OUTPUT+n,b'H'*16)
  result=self.invoke(RUNTIME+layout['offsets']['lfs_read_entry'],[self.storage,offset,ARGS,n]);data=bytes(self.uc.mem_read(OUTPUT,n));assert bytes(self.uc.mem_read(OUTPUT-16,16))==b'G'*16 and bytes(self.uc.mem_read(OUTPUT+n,16))==b'H'*16;return result,data
 def expected(self,offset,n):
  out=bytearray(self.bytes_at(offset,n))
  if offset+n>self.view['storageSize']:
   lo=max(offset,self.view['storageSize']);out[lo-offset:]=bytes(offset+n-lo)
  if not self.matches:return bytes(out)
  for s in self.view['segments']:
   lo=max(offset,s['offset']);hi=min(offset+n,s['offset']+s['length'])
   if hi<=lo:continue
   at=s['sourceOffset']+lo-s['offset']
   if s.get('original'):data=self.bytes_at(at,hi-lo)
   elif s.get('sourcePath'):data=bytes([sum(s['sourcePath'].encode())%251])*(hi-lo)
   else:data=payload[at:at+hi-lo]
   out[lo-offset:hi-offset]=data
  return bytes(out)
 def release(self,obj):return self.invoke(self.u64(self.u64(obj)+8),[obj])
 def codefs(self,group):
  self.code_group=group;self.code_files={}
  for e in plan['exefs']:
   if e['titleId']!=group['titleId']or not e.get('original'):continue
   original=e['original'];regions=[(0,bytes.fromhex(original.get('headerHex','')))];size=original['size']
   if e['name']=='main.npdm':regions=[(0,bytes.fromhex(group['owner']['npdmHeaderHex'])),(group['owner']['programOffset'],pack(int(group['owner']['programId'])))];size=max(size,group['owner']['programOffset']+8)
   if e['name']=='main':regions=[(0,bytes.fromhex(group['owner']['mainHeaderHex']))];size=group['owner']['mainSize']
   self.code_files['/'+e['name']]={'size':size,'regions':regions}
  self.gamefs=self.object('fs',ref_offset=40);return self.gamefs
 def ns(self,method,name,mode=1):
  self.uc.mem_write(ARGS,pack(ARGS+16));self.uc.mem_write(ARGS+16,pack(0));self.uc.mem_write(ARGS+128,name.encode()+b'\0');out=ARGS+16 if method=='type'else ARGS
  result=self.invoke(BASE+layout['namespace']['entries'][method],[self.gamefs+8,out,ARGS+128,mode]);return result,self.u64(ARGS+16)
 def file_read(self,file,offset,n):
  self.uc.mem_write(ARGS+256,pack(OUTPUT)+pack(n));self.uc.mem_write(ARGS+272,pack(0));self.uc.mem_write(OUTPUT-16,b'G'*16);self.uc.mem_write(OUTPUT+n,b'H'*16)
  result=self.invoke(self.u64(self.u64(file)+32),[file,ARGS+272,offset,ARGS+256,n,0]);count=self.u64(ARGS+272);assert bytes(self.uc.mem_read(OUTPUT-16,16))==b'G'*16 and bytes(self.uc.mem_read(OUTPUT+n,16))==b'H'*16;return result,bytes(self.uc.mem_read(OUTPUT,count))

passed=0
random.seed(72)
for view in plan['views']:
 for ref_offset in [24,32,40]:
  m=Model(view,ref_offset=ref_offset)
  assert m.invoke(RUNTIME+layout['offsets']['lfs_size_entry'],[m.storage,ARGS+64])==0 and m.u64(ARGS+64)==view['virtualSize'];passed+=1
  proof_reads=len(m.trace)
  ranges=[(0,80),(0,0),(view['storageSize']-8,16),(view['storageSize'],32)]
  for s in view['segments']:
   ranges +=[(s['offset'],min(s['length'],4096)),(max(0,s['offset']-1),min(2,view['virtualSize']-max(0,s['offset']-1))),(s['offset']+s['length']-1,min(2,view['virtualSize']-(s['offset']+s['length']-1)))]
   ranges +=[(s['offset']+random.randrange(s['length']),1)for _ in range(2)]
  for offset,n in ranges:
   result,data=m.read(offset,n);assert result==0 and data==m.expected(offset,n),(view['titleId'],offset,n,result,data[:16],m.expected(offset,n)[:16]);passed+=1
  identity=[x for x in m.trace if x[0]=='original' and x[1]==view['fingerprintDataOffset'] and x[2]==view['fingerprintLength']];assert len(identity)==1,('repeated identity',identity)
  m.release(m.storage);assert m.objects[m.storage]['dead'] and m.storage in m.freed;passed+=1
  m.object('storage',address=m.storage,ref_offset=ref_offset);m.matches=False;result,data=m.read(0,80);assert not result and data==m.bytes_at(0,80);m.release(m.storage);assert m.objects[m.storage]['dead'];passed+=1
 for condition in ['disabled','different','error','allocation']:
  m=Model(view,matches=condition!='different');m.original_error=0x1234 if condition=='error'else 0;m.alloc_fail=condition=='allocation'
  if condition=='disabled':m.uc.mem_write(CTX+8,bytes(4))
  result,data=m.read(0,80);assert result==(0x1234 if condition=='error'else 0)
  if not result:assert data==(m.bytes_at(0,80)if condition in['disabled','different']else m.expected(0,80))
  passed+=1
for group in plan['namespaces']:
 m=Model();fs=m.codefs(group)
 for entry in [e for e in plan['exefs']if e['titleId']==group['titleId']and e['modified']]:
  replacement=entry['replacement'];name='/'+entry['name'];result,_=m.ns('type',name);assert result==0;result,file=m.ns('open',name);assert result==0
  assert m.invoke(m.u64(m.u64(file)+64),[file,ARGS+64])==0 and m.u64(ARGS+64)==replacement['size'];passed+=1
  revision=m.u64(CTX+200);result,empty=m.file_read(file,0,0);assert result==0 and empty==b'' and m.u64(CTX+200)==revision;passed+=1
  ranges=[(0,min(256,replacement['size'])),(max(0,replacement['size']-7),32)]
  ranges +=[(part['offset'],min(part['length']+8,4096))for part in replacement.get('segments',[])]
  for offset,n in ranges:
   n2=min(n,replacement['size']-offset)
   if replacement.get('segments'):
    expected=bytearray(n2)
    for part in replacement['segments']:
     lo=max(offset,part['offset']);hi=min(offset+n2,part['offset']+part['length'])
     if hi<=lo:continue
     at=part['sourceOffset']+lo-part['offset']
     if part.get('inline'):data=payload[at:at+hi-lo]
     else:
      backing={'size':next(row for row in plan['sources']if row['sdPath']==replacement['sourcePath'])['size'],'remote':replacement['sourcePath']}if replacement.get('sourcePath')else m.code_files[name]
      data=m.file_bytes(backing,replacement.get('sourceOffset',0)+at,hi-lo)
     expected[lo-offset:hi-offset]=data
   else:expected=bytes([sum(replacement['sourcePath'].encode())%251])*n2
   result,data=m.file_read(file,offset,n);assert result==0 and data==expected,('CodeFS bytes',name,offset,n,result,len(data));passed+=1
  m.release(file);assert m.objects[file]['dead'];passed+=1
 owner_reads=len([x for x in m.trace if x[0]=='open'and x[1]=='/main.npdm'])
 unmodified=next((e for e in plan['exefs']if e['titleId']==group['titleId']and not e['modified']),None)
 if unmodified:
  result,other=m.ns('open','/'+unmodified['name']);assert result==0;m.release(other);assert len([x for x in m.trace if x[0]=='open'and x[1]=='/main.npdm'])==owner_reads+int(unmodified['name']=='main.npdm');passed+=1
 result,directory=m.ns('directory','/',3);assert result==0;vt=m.u64(directory);assert m.invoke(m.u64(vt+40),[directory,ARGS+64])==0 and m.u64(ARGS+64)==len([e for e in plan['exefs']if e['titleId']==group['titleId']]);passed+=1
 wanted={e['name']:e['replacement']['size']for e in plan['exefs']if e['titleId']==group['titleId']};actual={}
 for _ in range(len(wanted)+1):
  m.uc.mem_write(ARGS+256,pack(OUTPUT)+pack(2*0x310));assert m.invoke(m.u64(vt+32),[directory,ARGS+272,ARGS+256])==0;count=m.u64(ARGS+272)
  if not count:break
  for j in range(count):
   row=bytes(m.uc.mem_read(OUTPUT+j*0x310,0x310));name=row[:0x301].split(b'\0')[0].decode();actual[name]=q(row,0x308);assert row[0x304]==1
 assert actual==wanted,(actual,wanted);m.release(directory);m.release(fs);assert m.objects[directory]['dead']and m.objects[fs]['dead'];passed+=1
if plan['views']:
 view=next(v for v in plan['views']if any(s.get('sourcePath')for s in v['segments']));segment=next(s for s in view['segments']if s.get('sourcePath'));offset=segment['offset'];m=Model(view)
 for _ in range(2000):
  result,data=m.read(offset,1);assert not result and data==m.expected(offset,1);m.release(m.storage);m.object('storage',address=m.storage)
 assert m.next_heap-HEAP<256,('object tracking grew with repeated opens',m.next_heap-HEAP);passed+=1
 if args.diagnostics:
  m=Model(view);assert m.invoke(RUNTIME+layout['offsets']['lfs_game_observations'],[])==0;assert m.log_writes==m.log_flushes==1
  result,data=m.read(offset,1);assert not result;assert m.log_writes==1
  m.release(m.storage);assert m.log_writes==2;seen=m.logger_calls
  for _ in range(2000):
   m.object('storage',address=m.storage);result,data=m.read(offset,1);assert not result;m.release(m.storage)
  assert m.log_writes==2 and m.logger_calls==seen,('logger kept running after first observation',m.log_writes,m.logger_calls,seen);passed+=1
  for failure in ['write','flush']:
   m=Model(view);setattr(m,'log_'+failure+'_error',0x202);m.invoke(RUNTIME+layout['offsets']['lfs_game_observations'],[]);assert m.u64(CTX+256)==1
   for _ in range(100):
    result,data=m.read(offset,1);assert not result and data==m.expected(offset,1);m.release(m.storage);m.object('storage',address=m.storage)
   assert m.log_writes==1 and m.log_flushes==int(failure=='flush');passed+=1
  m=Model(view);m.invoke(RUNTIME+layout['offsets']['lfs_game_observations'],[]);m.source_error=0x1234;result,_=m.read(offset,1);assert result==0x1234 and m.log_writes==2;m.release(m.storage);first=m.report.split(b'First source error (native result and SD path):\n')[1].split(b'\n')[0];assert b'00001234' in first and segment['sourcePath'].encode()in first;passed+=1
print(json.dumps({'nativeCases':passed,'compiledCodeBytes':len(code),'directSdReads':True,'originalMetadataAliases':True,'ipsDeltaReads':True,'objectAddressReuse':True,'referenceOffsets':[24,32,40],'unmodifiedExeFsPassedThrough':True,'directoryUnion':True,'x18AndCalleeSavedPreserved':True,'sourceDataSdkAndPacModeled':True}))
