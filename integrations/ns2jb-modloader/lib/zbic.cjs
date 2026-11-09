'use strict';
const {check}=require('./common.cjs');
let decoder;
function decodeZbic(data,size){
 check(Buffer.isBuffer(data)&&Number.isSafeInteger(size)&&size>=0&&size<=512*1024*1024&&data.length<=512*1024*1024,'Invalid ZBIC input size');
 if(!size&&!data.length)return Buffer.alloc(0);
 if(!decoder){
  const module=new WebAssembly.Module(require('./native/artifacts.cjs').artifacts().wasm);
  check(WebAssembly.Module.imports(module).length===0,'ZBIC decoder has unexpected imports');decoder=new WebAssembly.Instance(module).exports;decoder._initialize();
 }
 const input=decoder.malloc(data.length||1)>>>0;let output=0;
 try{
  check(input,'Cannot allocate ZBIC input');output=decoder.malloc(size||1)>>>0;check(output,'Cannot allocate ZBIC output');
  new Uint8Array(decoder.memory.buffer,input,data.length).set(data);
  const result=decoder.ZSTD_decompress(output,size,input,data.length)>>>0;
  check(!decoder.ZSTD_isError(result)&&result===size,'Cannot decode NSO ZBIC segment');return Buffer.from(new Uint8Array(decoder.memory.buffer,output,size));
 }finally{if(output)decoder.free(output);if(input)decoder.free(input);}
}
module.exports={decodeZbic};
