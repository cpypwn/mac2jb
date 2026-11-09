'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {check,sha,writeJson}=require('./common.cjs');
const {validateCapture}=require('./native.cjs');
function validateNativeMapping(info,base){
 const identity=!info.result&&info.programId==='0400000000000000'&&BigInt(info.memory.address)===base&&info.memory.type===3&&[4,5].includes(info.memory.permissions)&&info.memory.attributes===0;
 if(identity&&Number(info.memory.size)===0x24d000)throw Error('Native FS code cave is unavailable (0x24d000 mapping). A prior modloader is likely resident; fully restart the Switch before installing another mod.');
 check(identity&&Number(info.memory.size)===0x24e000,'Unsupported native FS mapping');
}
async function captureNative(run,directory){
 const session=path.basename(run),current=JSON.parse(await fs.readFile(path.join(run,'switch2/fs-execution-current.json'))),proof=JSON.parse(await fs.readFile(current.file));
 check(current.verified&&proof.verified&&proof.session===session,'Missing same-session FS 4/4 proof');
 const base=BigInt(proof.mapping.memory.address);validateNativeMapping(proof.mapping,base);
 const {Client}=require(path.join(run,'switch2/process/client.cjs')),c=await new Client().open();let pending=false;
 const output=path.join(directory,'native-fs/fs-4.bin');await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
 try{
  const handle=await c.fsProcess(),info=await c.info(handle,base,8n);
  validateNativeMapping(info,base);
  const parts=[];for(let off=0;off<0x24e000;off+=0x200000){const n=Math.min(0x200000,0x24e000-off),input=Buffer.alloc(32);[8n,base+BigInt(off),BigInt(n),0n].forEach((v,i)=>input.writeBigUInt64LE(v,8*i));
   pending=true;const r=await c.worker({kind:'ro-process',handle:c.handle,processHandle:handle,id:0x524f0016,hex:input.toString('hex')},30000);pending=false;
   check(!r.transport&&!r.result&&r.kernelPid===String(c.pid)&&r.length===n,'FS capture RPC failed');const meta=Buffer.from(r.data,'hex');check(meta.readBigUInt64LE(0)===8n&&meta.readBigUInt64LE(8)===0x0400000000000000n&&meta.readBigUInt64LE(32)===0n&&meta.readBigUInt64LE(40)===0n,'FS capture identity/alias cleanup differs');
   const bytes=await fs.readFile(r.outputFile);check(bytes.length===n&&sha(bytes)===r.sha256,'FS capture hash differs');parts.push(bytes);
  }
  const bytes=Buffer.concat(parts);validateCapture(bytes);await fs.writeFile(output,bytes,{mode:0o600});writeJson(path.join(directory,'native-fs/manifest.json'),{session,verified:true,size:bytes.length,sha256:sha(bytes)});return output;
 }finally{if(!pending&&!c.pending)await c.close();}
}
module.exports={captureNative,validateNativeMapping};
