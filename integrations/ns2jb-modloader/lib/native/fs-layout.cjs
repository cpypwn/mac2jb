'use strict';
// ARM64 relocation qualification, run once on the PC before any native writes.
const {check,sha}=require('../common.cjs');
function branchTarget(word,at){
 let bits,shift=5;
 if((word&0x7c000000)===0x14000000){bits=26;shift=0;}
 else if((word&0xff000010)===0x54000000||(word&0x7e000000)===0x34000000||(word&0x3b000000)===0x18000000)bits=19;
 else if((word&0x7e000000)===0x36000000)bits=14;
 else return null;
 let value=(word>>>shift)&(2**bits-1);if(value>=2**(bits-1))value-=2**bits;
 return at+value*4;
}
function normalize(bytes,start=0,size=bytes.length-start,internal=false){
 check(start>=0&&size%4===0&&start+size<=bytes.length,'Incomplete FS instruction range');
 const result=Buffer.alloc(size),pages=new Set();
 for(let i=0;i<size;i+=4){
  const original=bytes.readUInt32LE(start+i);let word=original;
  if((word&0x1f000000)===0x10000000){pages.delete(word&31);if(word>>>31)pages.add(word&31);word&=0x9f00001f;}
  else{
   // Follow page registers within a basic block, including delayed loads.
   // Consuming a page does not turn a loaded object pointer into a page:
   // fields, stack offsets, flags and operation IDs remain exact.
   if(pages.has((word>>>5)&31)&&
    ((word&0x7f000000)===0x11000000||(word&0x3b000000)===0x39000000))word&=~0x3ffc00;
   // Conservatively invalidate the destination of other instructions. Extra
   // invalidation at stores is harmless; guessing across control flow is not.
   pages.delete(original&31);
   if((original&0x3a000000)===0x28000000){
    if(original&0x400000)pages.delete((original>>>10)&31);
    if(((original>>>23)&3)!==2)pages.delete((original>>>5)&31);
   }
   if((original&0x3b200000)===0x38000000&&[1,3].includes((original>>>10)&3))pages.delete((original>>>5)&31);
   const target=branchTarget(word,start+i);
   if(target!==null||(original&0xfe000000)>>>0===0xd6000000)pages.clear();
   if(target!==null&&!(internal&&target>=start&&target<start+size)){
    if((word&0x7c000000)===0x14000000)word&=0xfc000000;
    else word&=(word&0x7e000000)===0x36000000?~0x7ffe0:~0xffffe0;
   }
  }
  result.writeUInt32LE(word>>>0,i);
 }
 return result;
}
const fingerprint=(bytes,start,size)=>sha(normalize(bytes,start,size,true));
function dataTarget(bytes,at,consumer){
 const word=bytes.readUInt32LE(at),next=bytes.readUInt32LE(consumer);
 check((word&0x9f000000)>>>0===0x90000000&&((next>>>5)&31)===(word&31),'FS data reference is not an ADRP pair');
 let immediate=((word>>>29)&3)|(((word>>>5)&0x7ffff)<<2);if(immediate&0x100000)immediate-=0x200000;
 const page=(at&~4095)+immediate*4096;
 if((next&0x7fc00000)===0x11000000)return page+((next>>>10)&4095);
 check((next&0xffc00000)>>>0===0xf9400000,'Unsupported FS global reference');
 return page+8*((next>>>10)&4095);
}
function offset(layout,reference){
 // Reference offsets identify operations in the seed ABI, not addresses in
 // the currently running FS. Each operation/data reference moves separately.
 if(!layout)return reference;
 if(Object.hasOwn(layout.offsets,reference))return layout.offsets[reference];
 for(const range of layout.ranges)if(reference>=range.offset&&reference<range.offset+range.size)return range.actual+reference-range.offset;
 check(false,'Unqualified FS reference +0x'+reference.toString(16));
}
function discover(bytes,contract=require('./fs-contract.json')){
 const normalized=normalize(bytes),ranges=[],offsets={},unresolved=[],unavailableLogging=[];
 for(const range of contract.ranges){
  const prefix=Buffer.from(range.prefix,'hex');let matches=[],at=-1;
  while((at=normalized.indexOf(prefix,at+1))>=0){
   if(at%4||at+range.size>bytes.length||fingerprint(bytes,at,range.size)!==range.sha256)continue;
   matches.push(at);
  }
  // Resolve identical wrappers through their callees. Unique, fully qualified
  // bodies need no extra signatures of functions outside the used ABI.
  if(matches.length>1)matches=matches.filter(at=>!(range.edges||[]).some(edge=>{
   const target=branchTarget(bytes.readUInt32LE(at+edge.at),at+edge.at);
   return target===null||target<0||target+edge.size>bytes.length||fingerprint(bytes,target,edge.size)!==edge.sha256;
  }));
  if(matches.length!==1){const failure={purpose:range.purpose,offset:range.offset,matches};(range.optional?unavailableLogging:unresolved).push(failure);if(range.optional)offsets[range.offset]=null;continue;}
  offsets[range.offset]=matches[0];ranges.push({offset:range.offset,size:range.size,actual:matches[0]});
 }
 if(unresolved.length){const error=Error('Cannot qualify native FS operations: '+unresolved.map(r=>r.purpose+' ('+r.matches.length+' matches)').join(', '));error.fsCompatibility={stage:'native-discovery',unresolved};throw error;}
 // Keep direct calls between qualified functions attached to the same contract.
 for(const edge of contract.links){
  if(contract.ranges.some(r=>r.optional&&offsets[r.offset]===null&&
   ((edge.from>=r.offset&&edge.from<r.offset+r.size)||(edge.to>=r.offset&&edge.to<r.offset+r.size))))continue;
  const from=offset({ranges,offsets},edge.from),target=branchTarget(bytes.readUInt32LE(from),from);
  check(target===offset({ranges,offsets},edge.to),'FS call graph differs at +0x'+from.toString(16));
 }
 for(const data of contract.data){
  const target=dataTarget(bytes,offset({ranges,offsets},data.page),offset({ranges,offsets},data.consumer));
  check(Number.isSafeInteger(target)&&target>=bytes.length&&target<0x100000000&&target%8===0,'Invalid FS global address');offsets[data.offset]=target;
 }
 // Own only trailing padding of the executable segment, never an arbitrary
 // zero run that may be an internal literal/table used by another function.
 let end=bytes.length;while(end&&bytes[end-1]===0)end--;
 const cave=Math.ceil(end/256)*256,control=cave+0x700;
 check(cave>=((bytes.length-1)&~4095)&&control+256<=bytes.length,'FS has no qualified trailing gateway space');
 offsets[0x24d100]=cave;offsets[0x24d800]=control;offsets[0x24d000]=cave&~4095;
 return{schema:1,kind:'relocated',offsets,ranges,unavailableLogging,captureSize:bytes.length,cave,control,page:cave&~4095};
}
module.exports={branchTarget,normalize,fingerprint,dataTarget,offset,discover};
