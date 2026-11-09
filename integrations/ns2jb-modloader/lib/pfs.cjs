'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check}=require('./common.cjs');
// exefs.nsp is an unencrypted PFS0, not an installable game NSP/NCA.
function extractExeFs(image,directory){
 const fd=fs.openSync(image.file,'r');
 function read(at,n){const b=Buffer.alloc(n);check(fs.readSync(fd,b,0,n,at)===n,'Short exefs.nsp read');return b;}
 try{
  const size=fs.fstatSync(fd).size,h=read(0,16);check(h.toString('ascii',0,4)==='PFS0','exefs.nsp must be an unencrypted PFS0 image');
  const count=h.readUInt32LE(4),strings=h.readUInt32LE(8),metadata=count*24+strings,dataStart=16+metadata;
  check(count>0&&count<=4096&&metadata<=16*1024*1024&&dataStart<=size,'Invalid PFS0 metadata extent');
  const entries=read(16,count*24),names=read(16+count*24,strings),out=[],seen=new Set(),ranges=[];
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(let i=0;i<count;i++){
   const at=i*24,offset=Number(entries.readBigUInt64LE(at)),length=Number(entries.readBigUInt64LE(at+8)),nameAt=entries.readUInt32LE(at+16),end=names.indexOf(0,nameAt);
   check(nameAt<names.length&&end>nameAt,'Invalid PFS0 filename');const name=names.toString('utf8',nameAt,end);
   check(!/[\\/\x00]/.test(name)&&!['.','..'].includes(name)&&Buffer.byteLength(name)<=0x300&&!seen.has(name.toLowerCase()),'Invalid or conflicting PFS0 entry '+name);seen.add(name.toLowerCase());
   check(Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&dataStart+offset+length<=size,'PFS0 file exceeds image');
   check(!ranges.some(r=>length&&r.length&&offset<r.offset+r.length&&r.offset<offset+length),'Overlapping PFS0 files');ranges.push({offset,length});
   const file=path.join(directory,name),dest=fs.openSync(file,'w',0o600),b=Buffer.alloc(0x40000);
   try{for(let p=0;p<length;){const n=Math.min(b.length,length-p);check(fs.readSync(fd,b,0,n,dataStart+offset+p)===n,'Short PFS0 payload');let written=0;while(written<n)written+=fs.writeSync(dest,b,written,n-written);p+=n;}}
   finally{fs.closeSync(dest);}
   out.push({name,size:length,file});
  }
  return out;
 }finally{fs.closeSync(fd);}
}
module.exports={extractExeFs};
