const {test}=require('node:test'),assert=require('node:assert/strict'),D=require('../server/streaming/lib/block-delta.cjs'),{compressor}=require('../server/streaming/lib/pc-stream-delta.cjs');
test('Worker dictionaries advance only after ACK; transferred frames preserve caller data',async()=>{
 const zip=compressor(),base=0x101000000,frame=Buffer.alloc(65024,7),before=Buffer.alloc(frame.length);
 try{
  zip.reset(frame.length);const first=await zip.encode({frame,slot:0,base,metrics:Buffer.alloc(32),sequence:1,keyframe:true,level:0});assert.deepEqual(D.decode(first.packet,before,{base}),frame);assert.equal(frame.length,65024);assert.ok(frame.every(v=>v===7));assert.equal(first.compressionLevel,0);assert.ok(Number.isFinite(first.workerEncodingMs));assert.equal(first.literalBlocks,first.blocks);
  await assert.rejects(zip.encode({frame,slot:1,base,metrics:Buffer.alloc(32)}),/not been acknowledged/);
  zip.commit(0);const changed=Buffer.from(frame);changed.fill(9,100,200);
  const next=await zip.encode({frame:changed,slot:0,base,metrics:Buffer.alloc(32),sequence:2});assert.deepEqual(D.decode(next.packet,frame,{base}),changed);assert.ok(next.packet.length<first.packet.length);zip.commit(0);
 }finally{await zip.close();}
});
