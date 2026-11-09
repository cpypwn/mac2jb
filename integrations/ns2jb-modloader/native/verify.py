"""Exercise the actual compiled ARM64 overlay, including virtual-size reads.

Original SDK calls are modeled. PAC and atomic instructions are modeled where
Unicorn lacks support. This qualifies the compiled RomFS/ExeFS readers and their ARM64 ABI.
"""
import argparse,hashlib,json,struct,random,subprocess
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
from unicorn.arm64_const import *
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN

HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('plan',type=Path)
parser.add_argument('build',type=Path)
args=parser.parse_args()
layout=json.loads((args.build/'combined-layout.json').read_text())
bootstrap="""const fs=require('node:fs');const {buildContext}=require('./lib/context.cjs');
const plan=JSON.parse(fs.readFileSync(process.argv[1]));const native=JSON.parse(fs.readFileSync(process.argv[2]));
const context=buildContext(plan,{fileObject:{object:0x5200000180n},filesystem:{object:0x5200000200n}},BigInt(native.base),BigInt(native.address),native,1);
console.log(JSON.stringify({plan,contextHex:context.toString('hex')}));"""
serialized=json.loads(subprocess.check_output(['node','-e',bootstrap,str(args.plan.resolve()),str((args.build/'combined-layout.json').resolve())],cwd=HERE.parent))
plan=serialized['plan'];context=bytes.fromhex(serialized['contextHex'])
class Payload:
    def __init__(self,p):self.file=p.open('rb');self.size=p.stat().st_size
    def __len__(self):return self.size
    def __getitem__(self,key):
        self.file.seek(key.start);return self.file.read(key.stop-key.start)
payload=Payload(args.plan.parent/plan['payload']['filename'])
code=(args.build/'combined.bin').read_bytes()
assert len(code)==layout['codeBytes'] and hashlib.sha256(code).hexdigest()==layout['sha256']
BASE=int(layout['base']);ENTRY=int(layout['entry']);CONTEXT=int(layout['address'])
STACK=0x5000000000;OUTPUT=0x5100000100;OBJECT=0x5200000100;RETURN=0x5300000000
md=Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN);md.skipdata=True;insns={i.address:i for i in md.disasm(code,ENTRY)}
regs={f'x{i}':UC_ARM64_REG_X0+i for i in range(29)};count=0
captured_regions=[]


def run(view,offset,length,*,method='read',matches=True,active=True,original_error=0,source_error=0,short=False,identity_mismatch=None):
    global count
    uc=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
    regions=[(ENTRY&~4095,4096),(CONTEXT&~4095,((len(context)+(CONTEXT&4095)+4095)//4096)*4096),(STACK,0x10000),
             (OUTPUT&~4095,0x202000),(OBJECT&~4095,8192),(RETURN,4096),
             (BASE+0x107000,4096),(BASE+0x104000,4096)]
    for at,size in regions:uc.mem_map(at,size)
    uc.mem_write(ENTRY,code);ctx=bytearray(context)
    struct.pack_into('<I',ctx,8,int(active))
    uc.mem_write(CONTEXT,bytes(ctx));uc.mem_write(OBJECT,struct.pack('<QQ',OUTPUT,length))
    uc.mem_write(OUTPUT-32,b'G'*32);uc.mem_write(OUTPUT+length,b'H'*32)
    sp=STACK+0xf000;uc.reg_write(UC_ARM64_REG_SP,sp)
    args=[OBJECT,OBJECT+64]if method=='size'else[OBJECT,offset,OBJECT,length]
    for i,v in enumerate(args):uc.reg_write(UC_ARM64_REG_X0+i,v)
    uc.reg_write(UC_ARM64_REG_X30,RETURN)
    preserved={i:0x1234560000+i for i in range(18,29)}
    for i,v in preserved.items():uc.reg_write(UC_ARM64_REG_X0+i,v)
    calls=[];native_reads=[];comparisons=[];trail=[]
    def original_bytes(at,n):
        out=bytearray([0x6b])*n
        regions=captured_regions or [(0,bytes.fromhex(view['headerHex'])),
                        (view['fingerprintFileEntryOffset'],bytes.fromhex(view['originalFileEntryHex'])),
                        (view['fingerprintDataOffset'],bytes.fromhex(view['originalPrefixHex']))]
        for start,b in regions:
            lo=max(at,start);hi=min(at+n,start+len(b))
            if hi>lo:out[lo-at:hi-at]=b[lo-start:hi-start]
        if not matches and at==0 and n:out[0]^=1
        if identity_mismatch:
            target=view['fingerprintFileEntryOffset']if identity_mismatch=='entry'else view['fingerprintDataOffset']
            if at<=target<at+n:out[target-at]^=1
        return bytes(out)
    def ret(value):uc.reg_write(UC_ARM64_REG_X0,value);uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_X30))
    def hook(_,pc,size,user):
        if pc==RETURN:uc.emu_stop();return
        if pc==BASE+0x107604:
            assert uc.reg_read(UC_ARM64_REG_X0)==OBJECT
            if original_error and method=='size':ret(original_error);return
            uc.mem_write(uc.reg_read(UC_ARM64_REG_X1),struct.pack('<Q',view['storageSize']));ret(0);return
        if pc==BASE+0x1077b0:
            obj,at,pair,n=[uc.reg_read(UC_ARM64_REG_X0+i)for i in range(4)]
            native_reads.append((at,n))
            assert obj==OBJECT+8
            ptr,cap=struct.unpack('<QQ',uc.mem_read(pair,16));assert n<=cap
            if original_error:ret(original_error);return
            if at+n>view['storageSize']:ret(0xc102);return
            uc.mem_write(ptr,original_bytes(at,n));ret(0);return
        if pc==BASE+(layout['codefsOriginalRead'] or 0x104ef0):
            obj,result,at,pair,n,option=[uc.reg_read(UC_ARM64_REG_X0+i)for i in range(6)]
            assert obj==OBJECT+128 and option==0 and at+n<=len(payload)
            ptr,cap=struct.unpack('<QQ',uc.mem_read(pair,16));assert n<=cap
            calls.append((at,n))
            if source_error:ret(source_error);return
            uc.mem_write(ptr,payload[at:at+n]);uc.mem_write(result,struct.pack('<Q',n-int(short)));ret(0);return
        ins=insns.get(pc)
        if ins and not ins.mnemonic in ['ldrb','cmp','b.ne','subs']:
            trail.append((hex(pc-ENTRY),ins.mnemonic,ins.op_str,uc.reg_read(UC_ARM64_REG_X11),uc.reg_read(UC_ARM64_REG_X25)))
            if len(trail)>28:trail.pop(0)
        if ins and ins.mnemonic=='cmp'and ins.op_str=='w12, w13':
            left=uc.reg_read(UC_ARM64_REG_X12);right=uc.reg_read(UC_ARM64_REG_X13)
            if left!=right:comparisons.append((uc.reg_read(UC_ARM64_REG_X8),uc.reg_read(UC_ARM64_REG_X9),left,right))
        if ins and ins.mnemonic=='pacibsp':uc.reg_write(UC_ARM64_REG_PC,pc+4)
        elif ins and ins.mnemonic=='retab':uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_X30))
        elif ins and ins.mnemonic in ['stadd','ldadd']:
            parts=ins.op_str.replace('[','').replace(']','').split(', ')
            src=uc.reg_read(regs[parts[0]]);addr=uc.reg_read(regs[parts[-1]])
            old=struct.unpack('<Q',uc.mem_read(addr,8))[0]
            uc.mem_write(addr,struct.pack('<Q',(old+src)&0xffffffffffffffff))
            if ins.mnemonic=='ldadd'and parts[1]!='xzr':uc.reg_write(regs[parts[1]],old)
            uc.reg_write(UC_ARM64_REG_PC,pc+4)
    uc.hook_add(UC_HOOK_CODE,hook)
    entry=ENTRY+layout['offsets']['romfs_size']if method=='size'else ENTRY
    uc.emu_start(entry,RETURN,count=2000000)
    result=uc.reg_read(UC_ARM64_REG_X0)&0xffffffff
    expected_error=original_error or(source_error if calls else 0)or(0xd401 if calls and short else 0)
    effective_matches=matches and not identity_mismatch
    if method=='read'and(offset+length>view['virtualSize']or((not active or not effective_matches)and offset+length>view['storageSize'])):
        expected_error=original_error or 0xc102
    assert result==expected_error,(method,offset,length,result,expected_error)
    assert uc.reg_read(UC_ARM64_REG_SP)==sp
    assert struct.unpack('<Q',uc.mem_read(CONTEXT+96,8))[0]==0
    for i,v in preserved.items():assert uc.reg_read(UC_ARM64_REG_X0+i)==v,('clobbered',i)
    assert bytes(uc.mem_read(OUTPUT-32,32))==b'G'*32
    assert bytes(uc.mem_read(OUTPUT+length,32))==b'H'*32
    if method=='size'and not expected_error:
        got=struct.unpack('<Q',uc.mem_read(OBJECT+64,8))[0]
        assert got==(view['virtualSize']if active and matches and not original_error else view['storageSize'])
    if method=='read'and not expected_error:
        expected=bytearray(original_bytes(offset,length))
        if active and effective_matches:
            for j in range(length):
                if offset+j>=view['storageSize']:expected[j]=0
            for s in view['segments']:
                lo=max(offset,s['offset']);hi=min(offset+length,s['offset']+s['length'])
                if hi>lo:expected[lo-offset:hi-offset]=payload[s['sourceOffset']+lo-s['offset']:s['sourceOffset']+hi-s['offset']]
        actual=bytes(uc.mem_read(OUTPUT,length))
        if actual!=expected:
            at=next(i for i,(x,y)in enumerate(zip(actual,expected))if x!=y)
            raise AssertionError((offset,length,'mismatchAt',at,'actual',actual[at:at+16].hex(),
                                  'expected',expected[at:at+16].hex(),'sourceCalls',calls,
                                  'matches',struct.unpack('<Q',uc.mem_read(CONTEXT+24,8))[0],
                                  'nativeReads',native_reads,'comparisons',comparisons,'trail',trail))
    count+=1
    return bytes(uc.mem_read(OUTPUT,length))if method=='read'and not expected_error else None


random.seed(72)
for view in plan['views']:
    for options in [{},{'matches':False},{'active':False},{'original_error':0x1234}]:run(view,0,0,method='size',**options)
    for options in [{},{'matches':False},{'active':False},{'original_error':0x1234}]:run(view,0,80,**options)
    for s in view['segments']:
        ranges=[(s['offset'],min(s['length'],0x10000)),(max(0,s['offset']-1),2),
                (s['offset']+s['length']-1,2),(max(0,s['offset']-16),min(s['length']+32,0x10000))]
        ranges +=[(s['offset']+random.randrange(s['length']),1)for _ in range(8)]
        for offset,n in ranges:run(view,offset,n)
        for options in [{'source_error':0xbeef},{'short':True},{'active':False},{'matches':False}]:
            run(view,s['offset'],min(s['length'],4096),**options)
    for offset,n in[(view['storageSize']-8,16),(view['storageSize'],32),(view['virtualSize'],1),
                    (0,0),(view['storageSize']-1,1)]:run(view,offset,n)
    for identity in ['entry','prefix']:
        run(view,0,80,identity_mismatch=identity)
        run(view,view['storageSize'],32,identity_mismatch=identity)
    # Check the relocated index and representative bytes of each mod resource.
    new_header=run(view,0,80)
    header=struct.unpack('<10Q',new_header)
    for i in [1,3,5,7]:
        at,n=header[i:i+2]
        if n:run(view,at,min(n,4096))
    for r in view['resources']:
        if r['modifiedSize']:run(view,r['overlayOffset'],min(r['modifiedSize'],4096))
    extension=view['segments'][-1]
    run(view,view['storageSize']-16,min(extension['offset']-view['storageSize']+32,0x10000))
print(json.dumps({'passed':count,'codeBytes':len(code),'virtualSizeReads':True,'guardBytes':True,
                  'schema':plan['schema'],'capturedOriginalMetadata':bool(captured_regions),
                  'resourceReads':sum(len(v['resources'])for v in plan['views']),
                  'x18AndCalleeSavedPreserved':True,'nativeSdkAndPacModeled':True,
                  'getSizeIdentity':'original size + header + entry + prefix'}))

# Execute the compiled CodeFS namespace entries. The SDK model implements
# sf::Out indirection, title/version checks and owned reference lifetimes.
def namespace_case(index,method='open',*,path='/subsdk9',mode=1,condition='',error=0):
    global count
    group=plan['namespaces'][index];owner=group['owner'];ns=layout['namespace']
    uc=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
    for at,size in [(ENTRY&~4095,4096),(CONTEXT&~4095,((len(context)+(CONTEXT&4095)+4095)//4096)*4096),
                    (STACK,0x10000),(OUTPUT&~4095,0x4000),(OBJECT&~4095,0x4000),(RETURN,4096),
                    (BASE+0x104000,0x2000)]:uc.mem_map(at,size)
    uc.mem_write(ENTRY,code);ctx=bytearray(context);c=layout['context']['romfs']
    if condition=='disabled':struct.pack_into('<I',ctx,c,0)
    uc.mem_write(CONTEXT,bytes(ctx))
    service=OBJECT+264 if condition=='source' else OBJECT
    # The actual sf::Out argument contains a pointer to a SharedPointer slot.
    wrapper=OUTPUT;slot=OUTPUT+16;argument=OUTPUT+128
    uc.mem_write(wrapper,struct.pack('<Q',slot));uc.mem_write(slot,bytes(8));uc.mem_write(argument,path.encode()+b'\0')
    sp=STACK+0xf000;uc.reg_write(UC_ARM64_REG_SP,sp);uc.reg_write(UC_ARM64_REG_X30,RETURN)
    args=[service,slot if method=='type' else wrapper,argument,mode]
    for i,v in enumerate(args):uc.reg_write(UC_ARM64_REG_X0+i,v)
    preserved={i:0x1234560000+i for i in range(18,29)}
    for i,v in preserved.items():uc.reg_write(UC_ARM64_REG_X0+i,v)
    held={};calls=[];serial=0
    def ret(value):uc.reg_write(UC_ARM64_REG_X0,value);uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_X30))
    def string(at):
        out=bytearray()
        for i in range(0x302):
            b=uc.mem_read(at+i,1)
            if not b[0]:return out.decode()
            out.extend(b)
        raise AssertionError('unterminated native path')
    def hook(_,pc,size,user):
        nonlocal serial
        if pc==RETURN:uc.emu_stop();return
        names=[k for k,v in ns['original'].items() if pc==BASE+v]
        if names:
            kind=names[0];f,out,p,m=[uc.reg_read(UC_ARM64_REG_X0+i) for i in range(4)];name=string(p)
            calls.append((kind,f,name,m))
            if kind=='open' and f==OBJECT and name in ['/main.npdm','/main']:
                if condition=='missing':ret(0x202);return
                serial+=1;obj=OBJECT+0x800+serial*32;held[obj]=name
                ptr=struct.unpack('<Q',uc.mem_read(out,8))[0];assert not struct.unpack('<Q',uc.mem_read(ptr,8))[0]
                uc.mem_write(ptr,struct.pack('<Q',obj));ret(0);return
            if not error:
                if kind=='type':uc.mem_write(out,struct.pack('<I',1))
                else:
                    ptr=struct.unpack('<Q',uc.mem_read(out,8))[0];uc.mem_write(ptr,struct.pack('<Q',OBJECT+0x3000))
            ret(error);return
        if pc==BASE+0x104ef0:
            f,out,at,buf,n,opt=[uc.reg_read(UC_ARM64_REG_X0+i) for i in range(6)]
            assert f in held and opt==0
            ptr,cap=struct.unpack('<QQ',uc.mem_read(buf,16));assert n<=cap
            if condition=='read-error':ret(0x1234);return
            if held[f]=='/main.npdm':
                data=bytearray(bytes.fromhex(owner['npdmHeaderHex']))
                if at==owner['programOffset']:data=bytearray(struct.pack('<Q',int(owner['programId'])+int(condition=='title')))
                else:
                    assert at==0 and n==128
                    if condition=='npdm':data[0]^=1
            else:
                assert at==0 and n==256;data=bytearray(bytes.fromhex(owner['mainHeaderHex']))
                if condition=='version':data[0]^=1
            uc.mem_write(ptr,bytes(data[:n]));uc.mem_write(out,struct.pack('<Q',n-int(condition=='short')));ret(0);return
        if pc==BASE+0x105480:
            f,out=[uc.reg_read(UC_ARM64_REG_X0+i) for i in range(2)];assert held[f]=='/main'
            uc.mem_write(out,struct.pack('<Q',owner['mainSize']+int(condition=='size')));ret(0);return
        if pc==BASE+0x104e10:
            f=uc.reg_read(UC_ARM64_REG_X0);assert f in held;del held[f];ret(0);return
        ins=insns.get(pc)
        if ins and ins.mnemonic in ['pacibsp','bti']:uc.reg_write(UC_ARM64_REG_PC,pc+4)
        elif ins and ins.mnemonic=='retab':uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_X30))
        elif ins and ins.mnemonic in ['stadd','ldadd']:
            parts=ins.op_str.replace('[','').replace(']','').split(', ')
            value=uc.reg_read(regs[parts[0]]);at=uc.reg_read(regs[parts[-1]])
            old=struct.unpack('<Q',uc.mem_read(at,8))[0];uc.mem_write(at,struct.pack('<Q',(old+value)&((1<<64)-1)))
            if ins.mnemonic=='ldadd' and parts[1]!='xzr':uc.reg_write(regs[parts[1]],old)
            uc.reg_write(UC_ARM64_REG_PC,pc+4)
    uc.hook_add(UC_HOOK_CODE,hook);uc.emu_start(BASE+ns['entries'][method],RETURN,count=2000000)
    assert uc.reg_read(UC_ARM64_REG_PC)==RETURN,('namespace did not return',method)
    assert uc.reg_read(UC_ARM64_REG_X0)&0xffffffff==error,('namespace result',method,condition)
    assert not held,('leaked qualification handles',held)
    assert uc.reg_read(UC_ARM64_REG_SP)==sp
    for i,v in preserved.items():assert uc.reg_read(UC_ARM64_REG_X0+i)==v,('namespace clobbered',i)
    assert struct.unpack('<Q',uc.mem_read(CONTEXT+c+104,8))[0]==0
    good_path=path.startswith('/') and not any(v in ['.','..'] for v in path.split('/')) and '\\' not in path and len(group['prefix']+path)<0x300
    redirected=not condition and good_path and (method!='open' or mode==1)
    final=calls[-1]
    assert final[0]==method and final[1]==(OBJECT+264 if redirected else service)
    assert final[2]==(group['prefix']+path if redirected else path),('namespace path',final,condition)
    matched=struct.unpack('<Q',uc.mem_read(CONTEXT+c+88,8))[0];assert matched==int(redirected)
    count+=1

for i,g in enumerate(plan.get('namespaces',[])):
    for method in ['open','directory','type']:
        for condition in ['', 'disabled','source','missing','title','npdm','version','size','read-error','short']:
            namespace_case(i,method,condition=condition)
        for path in ['/', '/main', '/new-module', '/a/../main', '/./main', '/bad\\name', 'relative', '/'+'x'*0x300]:
            namespace_case(i,method,path=path)
        namespace_case(i,method,error=0xbeef)
    for mode in [0,2,3]:namespace_case(i,mode=mode)
print(json.dumps({'totalPassed':count,'exeFsNamespaces':len(plan.get('namespaces',[])),
                  'titleAndVersionScoped':True,'fileAndDirectoryRouting':True,
                  'ownedReferencesBalanced':True,'arm64AbiPreserved':True}))
