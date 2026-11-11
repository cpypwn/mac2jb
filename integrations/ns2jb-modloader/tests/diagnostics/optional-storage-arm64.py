"""Execute optional storage hooks and their gateways with the real ARM64 ABI.

Pass a directory produced by buildAll: combined-layout.json, combined.bin and
runtime.bin. SDK callees are instrumented; no console or game files are needed.
"""
import argparse,json,struct
from pathlib import Path
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
from unicorn import arm64_const as R

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('directory',type=Path)
args=parser.parse_args()
layout=json.loads((args.directory/'combined-layout.json').read_text())
FS=int(layout['base']);CTX=int(layout['address']);NATIVE=int(layout['runtimeAddress'])
LAZY=CTX+layout['context']['lazyOffset']
NODE=0x60100000;OBJECT=0x60101000;INFO=0x60102000;BUFFERS=0x60103000
STACK=0x60200000;RET=0x60300000
runtime=(args.directory/'runtime.bin').read_bytes()
u=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
for at,size in [(FS,0x300000),(NATIVE,len(runtime)),(CTX,0x100000),(NODE,0x10000),(STACK,0x10000),(RET,4096)]:
    u.mem_map(at,(size+4095)&~4095)
u.mem_write(NATIVE,runtime)
u.mem_write(FS+0x24d100,(args.directory/'combined.bin').read_bytes())
for h in layout['hooks']:
    u.mem_write(int(h['target']),bytes.fromhex(h['replacementHex']))
insns={i.address:i for i in Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN).disasm(runtime,NATIVE)}
def reg(name):return getattr(R,'UC_ARM64_REG_'+name.upper())
def q(at,value):u.mem_write(at,struct.pack('<Q',value))
def w(at,value):u.mem_write(at,struct.pack('<I',value))
def word(at):return int.from_bytes(u.mem_read(at,8),'little')
q(CTX+64,NODE);q(NODE+8,OBJECT);w(NODE+36,1);w(NODE+44,1)
q(LAZY+184,FS+0x107bc0);q(LAZY+192,FS+0x107cd0)
calls=[];expected=None
def hook(uc,pc,size,_):
    if pc==RET:u.emu_stop();return
    if pc in [FS+0x107bc0,FS+0x107cd0]:
        argv=[u.reg_read(reg('x'+str(i))) for i in range(8)]
        if pc==FS+0x107cd0:argv.append(word(u.reg_read(R.UC_ARM64_REG_SP)))
        assert expected is not None and argv[:len(expected)]==expected,(hex(pc),argv,expected)
        calls.append(pc)
        u.reg_write(R.UC_ARM64_REG_X0,0x12345678)
        u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30));return
    i=insns.get(pc)
    if not i:return
    if i.mnemonic in ['pacibsp','autibsp']:
        u.reg_write(R.UC_ARM64_REG_PC,pc+4);return
    if i.mnemonic=='retab':
        u.reg_write(R.UC_ARM64_REG_PC,u.reg_read(R.UC_ARM64_REG_X30));return
    if i.mnemonic=='ldapr':
        dst,src=i.op_str.replace('[','').replace(']','').split(', ')
        n=4 if dst.startswith('w') else 8
        u.reg_write(reg(dst),int.from_bytes(u.mem_read(u.reg_read(reg(src)),n),'little'))
        u.reg_write(R.UC_ARM64_REG_PC,pc+4)
u.hook_add(UC_HOOK_CODE,hook)
def invoke(name,argv,forward):
    global expected
    expected=forward
    sp=STACK+0xf000
    u.reg_write(R.UC_ARM64_REG_SP,sp);u.reg_write(R.UC_ARM64_REG_X30,RET)
    saved={i:0x1010101000+i for i in [18,*range(19,30)]}
    for i,value in saved.items():u.reg_write(reg('x'+str(i)),value)
    for i,value in enumerate(argv):
        if i<8:u.reg_write(reg('x'+str(i)),value)
        else:q(sp+8*(i-8),value)
    before=len(calls)
    h=next(h for h in layout['hooks'] if h['name']==name)
    u.emu_start(int(h['target']),RET,count=100000)
    assert u.reg_read(R.UC_ARM64_REG_PC)==RET,'Callback did not return'
    assert u.reg_read(R.UC_ARM64_REG_SP)==sp
    for i,value in saved.items():assert u.reg_read(reg('x'+str(i)))==value,('callee-saved',i)
    assert len(calls)==before+(forward is not None)
    return u.reg_read(R.UC_ARM64_REG_X0)&0xffffffff

for enabled,owner in [(1,0),(0,INFO),(1,INFO)]:
    w(CTX+8,enabled);q(NODE+24,owner)
    virtual=bool(enabled and owner)
    for opcode in [2,3,99]:
        for length in [0,147456]:
            u.mem_write(INFO,bytes([0x5a])*80)
            argv=[OBJECT,INFO+8,opcode,0x4652b0000,length]
            forward=None if virtual else [OBJECT+8,*argv[1:]]
            result=invoke('RomFS.OperateRange',argv,forward)
            assert result==(((6300<<9)|2) if virtual and opcode in [2,3] and length else 0 if virtual else 0x12345678)
            if virtual:assert bytes(u.mem_read(INFO,80))==bytes([0x5a])*8+bytes(64)+bytes([0x5a])*8
    # Eight distinct descriptor pointers: the last pointer is passed on stack.
    argv=[OBJECT,*[BUFFERS+i*32 for i in range(8)]]
    for i in range(8):q(BUFFERS+i*32,INFO);q(BUFFERS+i*32+8,(i+1)*8)
    result=invoke('RomFS.BatchRead',argv,None if virtual else [OBJECT+8,*argv[1:]])
    assert result==((6300<<9)|2) if virtual else result==0x12345678
print('Compiled ARM64 storage gateways: virtual range policy, untouched storage forwarding, 64-bit offsets, ninth BatchRead argument and preserved registers: passed')
