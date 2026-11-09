'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const align=(n,a=16)=>Math.ceil(n/a)*a;
const titleId=value=>{check(typeof value==='string'&&/^[0-9a-f]{16}$/i.test(value),'Expected a 16-digit hexadecimal Title ID: '+value);return value.toLowerCase();};
function romPath(value){
 check(typeof value==='string'&&value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0'),'Invalid resource path: '+value);
 check(value==='/'||value.split('/').slice(1).every(p=>p&&p!=='.'&&p!=='..'&&Buffer.byteLength(p)<=0x300),'Invalid resource path: '+value);
 return value;
}
async function hashFile(file){const h=crypto.createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
module.exports={check,sha,align,titleId,romPath,hashFile,writeJson};
