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
function bridge(base,owner,args,externals,publish=false){
 const r=object(publish?'publish':externals.clearAllocation?'allocate':'call'+args.length,base,{original_tail:externals.original_tail});r.code.writeBigUInt64LE(BigInt(owner),r.symbols.owner.value);r.code.writeBigUInt64LE(BigInt(externals.operation??0),r.symbols.operation.value);
 r.code.writeBigUInt64LE(BigInt(externals.result??BigInt(owner)+8n),r.symbols.result.value);
 for(let i=0;i<args.length;i++)r.code.writeBigUInt64LE(BigInt(args[i]),r.symbols['arg'+i].value);
 check(r.code.length<=256,'Native call template exceeds the bridge');return r.code;
}
function runtime(context,namespaceContext,lazyContext=0n){
 const r=artifacts().templates.runtime,code=Buffer.from(r.code,'base64');
 check(r.offsets.resident_context>=0&&r.offsets.namespace_context>=0,'Missing runtime context literals');
 code.writeBigUInt64LE(BigInt(context),r.offsets.resident_context);code.writeBigUInt64LE(BigInt(namespaceContext),r.offsets.namespace_context);
 if(r.offsets.lazy_context!==undefined)code.writeBigUInt64LE(BigInt(lazyContext),r.offsets.lazy_context);
 return{code,offsets:r.offsets};
}
module.exports={artifacts,bridge,runtime};
