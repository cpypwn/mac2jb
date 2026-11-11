'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,hashFile}=require('./common.cjs');
function sdPath(value){
 check(typeof value==='string'&&value.startsWith('/ns2jb-modloader/')&&!/[\\\x00]/.test(value)&&value.split('/').slice(1).every(p=>p&&p!=='.'&&p!=='..')&&Buffer.byteLength(value)<0x301,'Invalid mod source path');return value;
}
async function readSource(source,offset,length,reader){
 check(Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0&&offset+length<=source.size,'Read exceeds mod source');
 if(source.sdPath){check(reader,'SD input reader is unavailable');return reader.read(source.sdPath,offset,length);}
 const file=fs.openSync(source.file,'r'),bytes=Buffer.alloc(length);
 try{check(fs.readSync(file,bytes,0,length,offset)===length,'Short mod source read');return bytes;}finally{fs.closeSync(file);}
}
class Sources{
 constructor(reader){this.reader=reader;this.entries=new Map();}
 async add(source){
  check(Number.isSafeInteger(source.size)&&source.size>=0,'Invalid mod source size');let row;
  if(source.sdPath)row={sdPath:sdPath(source.sdPath),size:source.size};
  else{const digest=await hashFile(source.file);row={sdPath:'/ns2jb-modloader/.cache/files/'+digest,size:source.size,localFile:path.resolve(source.file),sha256:digest};}
  const old=this.entries.get(row.sdPath);check(!old||old.size===row.size,'Conflicting SD source extents');if(!old)this.entries.set(row.sdPath,row);return old||row;
 }
}
module.exports={Sources,readSource,sdPath};
