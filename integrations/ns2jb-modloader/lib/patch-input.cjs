'use strict';
const fs=require('node:fs'),path=require('node:path');
const {compilePchtxt}=require('./pchtxt.cjs');
function compileTextPatch(input,bytes){
 const compiled=compilePchtxt(bytes,input.sdPath||input.file);
 return{...input,format:'ips32',inputFormat:'pchtxt',inputPath:input.path,inputSize:input.size,
  path:path.posix.join(path.posix.dirname(input.path),compiled.buildId+'.ips'),size:compiled.buffer.length,
  compiledHex:compiled.buffer.toString('hex'),buildId:compiled.buildId,patchRecords:compiled.records,patchedBytes:compiled.patchedBytes};
}
function patchBytes(patch){return patch.compiledHex!==undefined?Buffer.from(patch.compiledHex,'hex'):fs.readFileSync(patch.file);}
module.exports={compileTextPatch,patchBytes};
