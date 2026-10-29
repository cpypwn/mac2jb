const {test}=require('node:test'),assert=require('node:assert/strict'),{programs}=require('../server/streaming/lib/delta-programs.cjs'),D=require('../server/streaming/lib/block-delta.cjs'),S=require('../server/streaming/lib/pc-screen.cjs');
const base=0x101000000,sdk=0x20000000,mapped=0x30000000,strm=0x40000100,functions={socket:sdk+1314112,connect:sdk+1313872,recv:sdk+1313680,send:sdk+1313744,socketClose:sdk+1314192,reset:sdk+488912,dictionary:sdk+498688,inflate:sdk+490016,crc32:sdk+464400};
test('Post-menu graph has bounded reads, owned outputs, per-slot dictionaries and CRC before publication',()=>{
 const p=programs({base,sdk,mapped,strm,functions,width:1280,height:720});assert.equal(p.layout.count,15);assert.equal(p.header.readUInt32LE(76),1);
 for(const f of p.frames.slice(0,3)){
  assert.ok(f.frame.length<=0x40000);assert.ok(f.snapshot+f.frame.length<base+0x500000);
  assert.deepEqual(f.calls[f.receive].args,[{u32:p.fd},base+D.STAGING,p.layout.header,0x40]);
  assert.deepEqual(f.calls[f.bodyReceive].args,[{u32:p.fd},base+D.STAGING+p.layout.header,{u32:base+D.STAGING+20},0x40]);
  assert.equal(f.calls.filter(c=>c.function===functions.connect).length,f.ack===null?1:0);
  assert.equal(f.calls.filter(c=>c.function===functions.socket).length,f.ack===null?1:0);
  assert.equal(f.calls.some(c=>c.function===functions.socketClose),false);
  const dictionaries=f.calls.filter(c=>c.function===functions.dictionary);assert.equal(dictionaries.length,p.layout.count);
  dictionaries.forEach((c,i)=>assert.deepEqual(c.args,[strm,mapped+S.SLOT+f.slot*S.STRIDE+i*D.BLOCK,p.layout.blocks[i].length,0]));
  const crc=f.calls.findIndex(c=>c.function===functions.crc32),pub=f.calls.findIndex(c=>c.function===sdk+0x586fb0&&c.args[0]===mapped+S.HEADER);assert.ok(crc>f.receive&&pub>crc);
  const i=f.proof.logicalResultIndices[crc];assert.equal(f.frame.readBigUInt64LE(f.proof.stackOffset+i*0x140+0x118),BigInt(mapped+S.HEADER+64));
 }
 assert.equal(p.frames[0].calls.some(c=>c.function===functions.send),false);assert.equal(p.frames[1].ack,3);assert.equal(p.frames[2].ack,2);
});

test('Experimental direct inflate owns per-slot IO templates, preserves dictionary setup and removes output copies',()=>{
 const options={base,sdk,mapped,strm,functions,width:1920,height:1080,video:{base:0x50000000,stride:0x100000,capacity:0x100000}};
 const normal=programs({...options,directInflate:false}),direct=programs({...options,directInflate:true});assert.equal(direct.directInflate,true);
 for(let j=0;j<3;j++){
  const f=direct.frames[j],old=normal.frames[j],copies=f.calls.filter(c=>c.function===sdk+0x586fb0&&c.args[0]===strm+24);
  assert.equal(copies.length,direct.layout.count);assert.equal(f.proof.nativeCalls,old.proof.nativeCalls-2*direct.layout.count);assert.ok(f.frame.length<old.frame.length);
  assert.ok(f.outputOffset>=f.proof.tablesOffset+f.proof.nativeCalls*0x100);assert.ok(f.outputOffset+copies.length*16<=f.proof.stackOffset);
  copies.forEach((c,i)=>{assert.equal(c.args[1],f.at+f.outputOffset+i*16);assert.equal(c.args[2],16);const offset=c.args[1]-f.at;assert.equal(f.frame.readBigUInt64LE(offset),BigInt(options.video.base+f.slot*options.video.stride+i*D.BLOCK));assert.equal(f.frame.readUInt32LE(offset+8),direct.layout.blocks[i].length);});
  assert.equal(f.calls.some(c=>c.function===sdk+0x586fb0&&c.args[1]===base+0x500000),false,'No temp-to-video copy');
  assert.equal(f.calls.filter(c=>c.function===functions.dictionary).length,direct.layout.count);
  const crc=f.calls.findIndex(c=>c.function===functions.crc32),pub=f.calls.findIndex(c=>c.function===sdk+0x586fb0&&c.args[0]===mapped+S.HEADER);assert.ok(pub>crc);
 }
});
