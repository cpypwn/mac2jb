#!/usr/bin/env node
'use strict';
// Generate non-reconstructive ABI fingerprints from a locally supplied capture.
// No firmware capture or full function bytes are written to the repository.
const fs=require('node:fs'),path=require('node:path');
const {check,sha}=require('../lib/common.cjs'),profile=require('../lib/native/fs-abi.json');
const {normalize,fingerprint,branchTarget,dataTarget}=require('../lib/native/fs-layout.cjs');
const bytes=fs.readFileSync(process.argv[2]),root=path.resolve(__dirname,'..');
for(const range of profile.ranges)check(sha(bytes.subarray(range.offset,range.offset+range.size))===range.sha256,'Source capture differs: '+range.purpose);
const source=profile.ranges,links=[];
const ranges=source.map(range=>{
 const {offset,size,purpose}=range,edges=[];
 for(let i=0;i<size;i+=4){
  const word=bytes.readUInt32LE(offset+i),to=branchTarget(word,offset+i);
  if(to===null||(word&0x7c000000)!==0x14000000)continue;
  if(source.some(r=>r.offset<=to&&to<r.offset+r.size))links.push({from:offset+i,to});
  if(!(to>=offset&&to<offset+size))edges.push({at:i,size:128,sha256:fingerprint(bytes,to,128)});
 }
 return{offset,size,purpose,prefix:normalize(bytes,offset,16).toString('hex'),sha256:fingerprint(bytes,offset,size),...([0x1050a0,0x1053d0,0x105410].includes(offset)?{optional:true}:{}),...(edges.length?{edges}:{})};
});
const data=[{offset:0x11e12d0,page:0x12ccf8,consumer:0x12cd10},{offset:0x11ee960,page:0x20ec44,consumer:0x20ec48}];
for(const row of data)check(dataTarget(bytes,row.page,row.consumer)===row.offset,'Source global reference differs');
const contract={schema:1,architecture:'aarch64',ranges,links,data};
fs.writeFileSync(path.join(root,'lib/native/fs-contract.json'),JSON.stringify(contract,null,2)+'\n');
console.log('Generated '+ranges.length+' relocation-aware FS fingerprints, '+links.length+' call constraints and '+data.length+' global references.');
