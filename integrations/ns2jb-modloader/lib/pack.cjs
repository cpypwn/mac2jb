'use strict';
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const {align,check,hashFile}=require('./common.cjs');
class Pack {
 constructor(file){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});this.file=file;this.fd=fs.openSync(file,'w',0o600);this.size=0;this.closed=false;}
 pad(){const end=align(this.size);if(end>this.size)this.bytes(Buffer.alloc(end-this.size),false);}
 bytes(data,padded=true){if(padded)this.pad();const start=this.size;let done=0;while(done<data.length)done+=fs.writeSync(this.fd,data,done,data.length-done,this.size+done);this.size+=data.length;return start;}
 append(file){this.pad();const start=this.size,fd=fs.openSync(file,'r'),b=Buffer.alloc(1024*1024),hash=crypto.createHash('sha256');try{for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;const bytes=b.subarray(0,n);this.bytes(bytes,false);hash.update(bytes);}}finally{fs.closeSync(fd);}return{offset:start,size:this.size-start,sha256:hash.digest('hex')};}
 async finish(){check(!this.closed,'Pack already closed');fs.fsyncSync(this.fd);fs.closeSync(this.fd);this.closed=true;return{filename:path.basename(this.file),size:this.size,sha256:await hashFile(this.file)};}
 close(){if(!this.closed){fs.closeSync(this.fd);this.closed=true;}}
}
module.exports={Pack};
