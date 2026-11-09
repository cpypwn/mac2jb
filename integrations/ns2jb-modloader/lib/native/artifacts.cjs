'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,sha}=require('../common.cjs');
const {textSection}=require('./elf-text.cjs');
const root=path.resolve(__dirname,'../..'),directory=path.join(root,'native/prebuilt');
let cached;
function artifacts(){
 if(cached)return cached;
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
 check(manifest.schema===1,'Unsupported prebuilt components');
 for(const [name,expected]of Object.entries(manifest.sources))check(sha(fs.readFileSync(path.join(root,name)))===expected,'Native source differs from the release. Rebuild with tools/build.cjs: '+name);
 const files={};
 for(const [name,expected]of Object.entries(manifest.files)){
  check(!name.includes('/')&&!name.includes('\\'),'Invalid prebuilt filename');
  const bytes=fs.readFileSync(path.join(directory,name));check(sha(bytes)===expected,'Prebuilt component checksum differs: '+name);files[name]=bytes;
 }
 cached={manifest,templates:JSON.parse(files['templates.json']),wasm:files['zbic.wasm']};return cached;
}
function object(name,base,externals={}){
 const row=artifacts().templates[name];check(row?.object&&row.symbols,'Missing prebuilt ARM64 template: '+name);
 return {code:textSection(Buffer.from(row.object,'base64'),BigInt(base),externals),symbols:row.symbols};
}
function romfs(base,context){
 const r=object('romfs',BigInt(base)+0x24d100n,{original_read:BigInt(base)+0x1077b0n,original_size_tail:BigInt(base)+0x107604n,source_read:BigInt(base)+0x104ef0n});
 check(r.symbols.resident_context&&r.symbols.lfs_size,'Incomplete RomFS template');r.code.writeBigUInt64LE(BigInt(context),r.symbols.resident_context.value);return r;
}
function bridge(base,owner,args,externals){
 const r=object('call'+args.length,base,externals);r.code.writeBigUInt64LE(BigInt(owner),r.symbols.owner.value);
 for(let i=0;i<args.length;i++)r.code.writeBigUInt64LE(BigInt(args[i]),r.symbols['arg'+i].value);
 check(r.code.length<=256,'Native call template exceeds the bridge');return r.code;
}
function namespace(context){
 const r=artifacts().templates.namespace,code=Buffer.from(r.code,'base64');
 check(r.contextOffset>=0&&r.contextOffset+8<=code.length,'Invalid namespace context literal');code.writeBigUInt64LE(BigInt(context),r.contextOffset);return{code,offsets:r.offsets};
}
module.exports={artifacts,romfs,bridge,namespace};
