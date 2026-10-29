const {test}=require('node:test'),assert=require('node:assert/strict'),D=require('../server/streaming/lib/block-delta.cjs');
const base=0x101000000;
test('Full HD uses 32 bounded decoder blocks and all compression levels preserve pixels',()=>{
 const before=Buffer.alloc(D.MAX_FRAME),raw=Buffer.from(before);for(let i=0;i<raw.length;i++)raw[i]=(i*13+(i>>10))&255;
 assert.equal(D.layout(raw.length).count,32);
 for(const level of [0,1,3,6]){const r=D.encode(raw,before,{base,level,keyframe:true});assert.deepEqual(D.decode(r.packet,before,{base}),raw);assert.ok(base+D.STAGING+r.packet.length<base+D.ALLOCATION);}
});
test('Dictionary delta preserves both alternating slots and keyframes exactly',()=>{
 const slots=[Buffer.alloc(460800),Buffer.alloc(460800)];let source=Buffer.alloc(460800);let seed=17;for(let i=0;i<source.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;source[i]=seed&255;}
 let first=0,last=0;for(let n=0;n<10;n++){const slot=n&1;source=Buffer.from(source);source.fill(n+1,400+n*16,500+n*16);const r=D.encode(source,slots[slot],{base,keyframe:n===6});const actual=D.decode(r.packet,slots[slot],{base});assert.deepEqual(actual,source);slots[slot]=actual;if(!n)first=r.packet.length;last=r.packet.length;}
 assert.ok(last<first/10,'Sparse updates should reduce traffic substantially');
});
test('Bounds and checksum reject malformed packets, dictionary mismatch and oversized output',()=>{
 const before=Buffer.alloc(65024),raw=Buffer.alloc(65024,75),r=D.encode(raw,before,{base});assert.deepEqual(D.decode(r.packet,before,{base}),raw);
 for(const mutate of [b=>b.writeUInt32LE(0),b=>b.writeBigUInt64LE(1n,64),b=>b.writeUInt32LE(0xffffffff,72),b=>b.writeUInt32LE(1,8),b=>b.writeUInt32LE(0xffffffff,20)]){const b=Buffer.from(r.packet);mutate(b);assert.throws(()=>D.decode(b,before,{base}));}
 assert.throws(()=>D.decode(r.packet.subarray(0,-1),before,{base}));assert.throws(()=>D.encode(raw,before,{base:0xfffff000}));
 const seed=D.seed(base,460800);assert.ok(seed.length<0xe0000);for(let i=0;i<D.layout(460800).count;i++){assert.equal(seed.readUInt32LE(72+i*16),0);assert.ok(Number(seed.readBigUInt64LE(64+i*16))>=base+D.STAGING);}
});
test('CRC32 matches the standard reference vector',()=>assert.equal(D.crc32(Buffer.from('123456789')),0xcbf43926));

test('Stored changed blocks avoid DEFLATE CPU work while retaining sparse updates and dictionary compatibility',()=>{
 const zlib=require('node:zlib'),original=zlib.deflateRawSync;let calls=0;zlib.deflateRawSync=(...args)=>{calls++;return original(...args);};
 try{
  const slots=[Buffer.alloc(D.MAX_FRAME),Buffer.alloc(D.MAX_FRAME)];let frame=Buffer.alloc(D.MAX_FRAME,4);
  for(let n=0;n<8;n++){
   const slot=n&1,level=n%3===2?1:0;frame=Buffer.from(frame);frame.fill(20+n,400+n*200,800+n*200);
   const oldCalls=calls,r=D.encode(frame,slots[slot],{base,level,keyframe:n<2});
   assert.deepEqual(D.decode(r.packet,slots[slot],{base}),frame);slots[slot]=frame;
   if(level===0){assert.equal(calls,oldCalls);assert.equal(r.literalBlocks,r.changedBlocks);assert.equal(r.compressionMode,'stored changed blocks');if(n>=2)assert.ok(r.packet.length<D.BLOCK*3);}
  }
  assert.ok(calls>0,'The same low-entropy source exercises DEFLATE when requested');
 }finally{zlib.deflateRawSync=original;}
});

test('Unchanged blocks carry no replacement pixels and partial headers keep native reads/writes bounded',()=>{
 const a=Buffer.alloc(460800,0x55),b=Buffer.from(a);b.fill(3,16000,16450);
 const old=D.encode(a,a,{base}),next=D.encode(b,a,{base}),seed=D.seed(base,a.length),layout=D.layout(a.length);
 assert.equal(old.changedBlocks,0);assert.ok(old.packet.length<1024);
 for(const previous of [seed,old.packet])for(let cut=0;cut<=layout.header;cut++){
  const prefix=Buffer.from(seed);previous.copy(prefix);next.packet.copy(prefix,0,0,cut);
  const body=prefix.readUInt32LE(20);assert.ok(body<0x80000&&D.STAGING+layout.header+body<D.ALLOCATION,'Partial body length escaped staging');
  for(let i=0;i<layout.count;i++){
   const p=Number(prefix.readBigUInt64LE(64+i*16)),n=prefix.readUInt32LE(72+i*16),write=prefix.readUInt32LE(76+i*16);
   assert.ok(p>=base+D.STAGING&&p+n<=base+D.ALLOCATION,'Truncated input pointer/count escaped owned memory');assert.ok(write<=layout.blocks[i].length,'Truncated output count escaped owned slot');
  }
 }
});


test('Length framing bounds every partial header across tiny and incompressible frames',()=>{
 const crypto=require('node:crypto'),bytes=460800,p=D.layout(bytes),zero=Buffer.alloc(bytes),noise=crypto.randomBytes(bytes);
 const packets=[D.seed(base,bytes),D.encode(zero,zero,{base}).packet,D.encode(noise,zero,{base,keyframe:true}).packet];
 assert.ok(packets[2].length>bytes);
 for(const a of packets)for(const b of packets)for(let cut=0;cut<=p.header;cut++){
  const mixed=Buffer.from(D.seed(base,bytes));a.copy(mixed);b.copy(mixed,0,0,cut);
  const count=mixed.readUInt32LE(20);assert.ok(count<0x80000);assert.ok(D.STAGING+p.header+count<D.ALLOCATION);
  for(let i=0;i<p.count;i++){const ptr=Number(mixed.readBigUInt64LE(64+i*16)),input=mixed.readUInt32LE(72+i*16),output=mixed.readUInt32LE(76+i*16);assert.ok(ptr>=base+D.STAGING&&ptr+input<base+D.ALLOCATION);assert.ok(output<=p.blocks[i].length);}
 }
});
