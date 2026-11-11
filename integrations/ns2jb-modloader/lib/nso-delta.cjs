'use strict';
const {check,sha,align}=require('./common.cjs');
function lengthBytes(n){const out=[];while(n>=255){out.push(255);n-=255;}out.push(n);return Buffer.from(out);}
function sequence(literals,distance=0,match=0){
 const token=Buffer.from([(Math.min(15,literals.length)<<4)|(distance?Math.min(15,match-4):0)]),parts=[token];
 if(literals.length>=15)parts.push(lengthBytes(literals.length-15));parts.push(literals);
 if(distance){const d=Buffer.alloc(2);d.writeUInt16LE(distance);parts.push(d);if(match>=19)parts.push(lengthBytes(match-19));}
 return Buffer.concat(parts);
}
// Keep original LZ4 sequences wherever they still describe the patched image.
// Changed literals/backreferences become small literal runs; unchanged compressed
// bytes remain ranges of the original NSO, rather than another executable file.
function patchLz4(packed,data,base){
 const pieces=[];let i=0,out=0,pending=0;
 const size=n=>{if(n===15){let b;do{check(i<packed.length,'Truncated LZ4 length');b=packed[i++];n+=b;}while(b===255);}return n;};
 while(i<packed.length){
  const start=i,token=packed[i++],literal=size(token>>>4),literalAt=i;check(i+literal<=packed.length&&out+literal<=data.length,'Invalid original LZ4 literals');i+=literal;
  const matchAt=out+literal;
  if(i===packed.length){
   if(pending===out&&data.length-matchAt===0&&data.subarray(out,matchAt).equals(packed.subarray(literalAt,i)))pieces.push({originalOffset:base+start,length:i-start});
   else pieces.push({bytes:sequence(data.subarray(pending))});
   pending=data.length;break;
  }
  check(i+2<=packed.length,'Truncated original LZ4 distance');const distance=packed.readUInt16LE(i);i+=2;const match=size(token&15)+4,end=matchAt+match;
  check(distance>0&&distance<=matchAt&&end<=data.length,'Invalid original LZ4 match');let valid=true;
  for(let p=matchAt;p<end;p++)if(data[p]!==data[p-distance]){valid=false;break;}
  if(valid){
   if(pending===out&&data.subarray(out,matchAt).equals(packed.subarray(literalAt,literalAt+literal)))pieces.push({originalOffset:base+start,length:i-start});
   else pieces.push({bytes:sequence(data.subarray(pending,matchAt),distance,match)});
   pending=end;
  }
  out=end;
 }
 if(pending<data.length)pieces.push({bytes:sequence(data.subarray(pending))});
 return pieces;
}
function createDelta(nso){
 const header=Buffer.from(nso.header),raw=nso.original,parts=[],literalParts=[];let position=256,literalSize=0;
 const add=piece=>{const length=piece.bytes?.length??piece.length;if(!length)return;const row={offset:position,length,...(piece.bytes?{literalOffset:literalSize}:{originalOffset:piece.originalOffset})};
  if(piece.bytes){literalParts.push(piece.bytes);literalSize+=length;}
  const last=parts.at(-1),field=piece.bytes?'literalOffset':'originalOffset';
  if(last&&last[field]!==undefined&&last.offset+last.length===row.offset&&last[field]+last.length===row[field])last.length+=length;else parts.push(row);position+=length;
 };
 const changed=nso.segments.map(s=>sha(s.data)!==s.originalHash),transcodeZbic=!!(header.readUInt32LE(12)&0x80)&&nso.segments.some((s,i)=>changed[i]&&s.originalCompressed);
 let flags=header.readUInt32LE(12)|0x38;if(transcodeZbic)flags&=~0x87;
 for(let i=0;i<3;i++){
  const s=nso.segments[i],start=align(position),base=nso.header.readUInt32LE(16+i*16);if(start>position)add({bytes:Buffer.alloc(start-position)});
  const segmentStart=position;let segment;
  if(!changed[i]&&(!transcodeZbic||!s.originalCompressed))segment=[{originalOffset:base,length:s.originalPacked.length}];
  else if(s.originalCompressed&&!s.originalZbic)segment=patchLz4(s.originalPacked,s.data,base);
  else if(!s.originalCompressed){
   segment=[];let p=0;
   while(p<s.data.length){const same=p<s.originalPacked.length&&s.data[p]===s.originalPacked[p];let end=p+1;
    while(end<s.data.length&&(end<s.originalPacked.length&&s.data[end]===s.originalPacked[end])===same)end++;
    segment.push(same?{originalOffset:base+p,length:end-p}:{bytes:s.data.subarray(p,end)});p=end;
   }
  }else{const packed=require('./lz4.cjs').encodeLz4(s.data);if(packed.length<s.data.length){flags|=1<<i;segment=[{bytes:packed}];}else{flags&=~(1<<i);segment=[{bytes:s.data}];}}
  for(const piece of segment)add(piece);
  header.writeUInt32LE(segmentStart,16+i*16);header.writeUInt32LE(s.address,20+i*16);header.writeUInt32LE(s.data.length,24+i*16);header.writeUInt32LE(position-segmentStart,0x60+i*4);Buffer.from(sha(s.data),'hex').copy(header,0xa0+i*32);
 }
 const nameAt=nso.header.readUInt32LE(0x1c),nameSize=nso.header.readUInt32LE(0x2c);check(!nameSize||nameAt>=256&&nameAt+nameSize<=raw.length,'Invalid NSO module name');header.writeUInt32LE(nameSize?position:0,0x1c);if(nameSize)add({originalOffset:nameAt,length:nameSize});header.writeUInt32LE(flags,12);
 const headerOffset=literalSize;literalParts.push(header);literalSize+=header.length;
 parts.unshift({offset:0,length:256,literalOffset:headerOffset});
 check(parts.every(p=>p.originalOffset===undefined||p.originalOffset>=0&&p.originalOffset+p.length<=raw.length),'NSO delta exceeds its source');
 return{size:position,parts,literals:Buffer.concat(literalParts,literalSize)};
}
module.exports={createDelta,patchLz4};
