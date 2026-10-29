const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const C=require('../server/streaming/lib/pc-codec.js'),S=require('../server/streaming/lib/pc-screen.cjs'),{programs}=require('../server/streaming/lib/pc-stream-tcp.cjs');
const args={base:0x10000000,sdk:0x20000000,mapped:0x30000000,fd:7,functions:{recv:0x20140b90,send:0x20140bd0,errno:0x201410b0}};
test('Indexed frames preserve all 256 RGB colors exactly, including black',()=>{
 const w=320,h=200,rgba=new Uint8Array(w*h*4);
 for(let i=0;i<w*h;i++){rgba[i*4]=i%256;rgba[i*4+1]=(i*17)%256;rgba[i*4+2]=(i*31)%256;rgba[i*4+3]=255;}
 const b=C.indexed(rgba,w,h);assert.equal(b.length,65024);
 for(let i=0;i<w*h;i++){const index=b[1024+i];assert.deepEqual(b.subarray(index*4,index*4+3),rgba.subarray(i*4,i*4+3));}
});
test('A 257th color requires the ordinary-color fallback; indexed capacity is checked before receive',()=>{
 const rgba=new Uint8Array(320*200*4);for(let i=0;i<257;i++){rgba[i*4]=i%256;rgba[i*4+1]=i>>8;}
 assert.equal(C.indexed(rgba,320,200),null);assert.equal(S.frameBytes(320,200,0),128000);assert.equal(S.frameBytes(320,200,2),65024);
 assert.throws(()=>S.frameBytes(1280,720,2),/dimensions/);assert.throws(()=>S.frameBytes(320,200,4),/dimensions/);
 for(const format of [0,1,2]){const p=programs({...args,width:320,height:200,format});assert.equal(p.header.readUInt32LE(24),format);assert.equal(p.bytes,S.frameBytes(320,200,format));assert.equal(p.packetBytes,p.bytes+32);assert.equal(p.frames[0].calls[p.frames[0].receive].args[2],p.packetBytes);}
});
test('Portable encoder supports true Full HD and remains bounded and rejects invalid input before entering WASM',()=>{
 C.installWasm(fs.readFileSync(require('node:path').join(__dirname,'../server/streaming/lib/frame-codec.wasm')));
 const rgba=new Uint8Array(1280*720*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=255;rgba[i+3]=255;}
 const b=Buffer.from(C.encode(rgba,1280,720));assert.equal(b.length,460800);assert.equal(b.readUInt16LE(),0xf800);
 const hd=Buffer.from(C.encode(new Uint8Array(1920*1080*4),1920,1080));assert.equal(hd.length,1036800);assert.throws(()=>C.encode(new Uint8Array(1924*1080*4),1924,1080),/size/);
});

// Digests were recorded from the previous scalar encoder, independently of
// the SIMD implementation. Cover endpoint ties and every 2-bit index position.
test('SIMD preserves scalar BC1 output for deterministic multicolor frames',()=>{
 const {createHash}=require('node:crypto');
 C.installWasm(fs.readFileSync(require('node:path').join(__dirname,'../server/streaming/lib/frame-codec.wasm')));
 for(const [w,h,hash] of [[4,4,'bc26053cdc124248ad7de087c5c3015165a245145f7bf7516f68171833c3261a'],[68,36,'1975581213070f188ecf36c4e156623308b2c1c1e9b1e7c96231fb7b7fa14b56'],[1280,720,'fbcd69a065039971ba048fded56a72bc0685e0d5d9cad815e2fcf4a96046fd99']]){
  const rgba=new Uint8Array(w*h*4);let seed=0x591ad37;
  for(let i=0;i<rgba.length;i+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;rgba[i]=seed&255;rgba[i+1]=seed>>>8&255;rgba[i+2]=seed>>>16&255;rgba[i+3]=255;}
  assert.equal(createHash('sha256').update(C.encode(rgba,w,h)).digest('hex'),hash);
 }
});

test('native BGRA capture produces identical BC1 colors without mutating input',()=>{
 C.installWasm(fs.readFileSync(require('node:path').join(__dirname,'../server/streaming/lib/frame-codec.wasm')));
 for(const [w,h] of [[4,4],[68,36],[1920,1080]]){
  const rgba=new Uint8Array(w*h*4),bgra=new Uint8Array(rgba.length);
  for(let i=0;i<rgba.length;i+=4){rgba[i]=(i*13+31)&255;rgba[i+1]=(i*7+71)&255;rgba[i+2]=(i*19+193)&255;rgba[i+3]=255;bgra[i]=rgba[i+2];bgra[i+1]=rgba[i+1];bgra[i+2]=rgba[i];bgra[i+3]=255;}
  const original=bgra.slice(),expected=C.encode(rgba,w,h);
  assert.deepEqual(C.encode(bgra,w,h,1,{bgra:true}),expected);assert.deepEqual(bgra,original);
 }
 assert.throws(()=>C.encode(new Uint8Array(4*4*4),4,4,0,{bgra:true}),/BGRA/);
});
