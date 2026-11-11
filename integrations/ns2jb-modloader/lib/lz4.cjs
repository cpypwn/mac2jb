'use strict';
// Raw LZ4 blocks, as used by NSO segments. No frame header or dependencies.
function encodeLz4(input){
 const out=Buffer.allocUnsafe(input.length+Math.floor(input.length/255)+32),table=new Uint32Array(65536);table.fill(0xffffffff);
 let at=0,anchor=0,written=0;
 const hash=n=>(Math.imul(n,0x9e3779b1)>>>16);
 function length(n){while(n>=255){out[written++]=255;n-=255;}out[written++]=n;}
 while(at<=input.length-12){
  const word=input.readUInt32LE(at),slot=hash(word),prior=table[slot];table[slot]=at;
  if(prior===0xffffffff||at-prior>65535||input.readUInt32LE(prior)!==word){at++;continue;}
  let end=at+4;while(end<input.length-5&&input[end]===input[prior+end-at])end++;
  const literals=at-anchor,match=end-at-4,token=written++;
  out[token]=(Math.min(literals,15)<<4)|Math.min(match,15);
  if(literals>=15)length(literals-15);
  input.copy(out,written,anchor,at);written+=literals;
  out.writeUInt16LE(at-prior,written);written+=2;
  if(match>=15)length(match-15);
  at=end;anchor=at;
  if(at>=2)table[hash(input.readUInt32LE(at-2))]=at-2;
 }
 const literals=input.length-anchor;out[written++]=Math.min(literals,15)<<4;
 if(literals>=15)length(literals-15);
 input.copy(out,written,anchor);written+=literals;
 return out.subarray(0,written);
}
module.exports={encodeLz4};
