const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {captureNative,validateNativeMapping}=require('../lib/native-capture.cjs');

const base=491079598080n;
function mapping(size,overrides={}){
 return {result:0,programId:'0400000000000000',memory:{address:String(base),size:String(size),type:3,permissions:4,attributes:0},...overrides};
}

test('native FS mapping accepts only the release-qualified full text region',()=>{
 assert.doesNotThrow(()=>validateNativeMapping(mapping(0x24e000),base));
 assert.throws(()=>validateNativeMapping(mapping(0x24d000),base),/prior modloader is likely resident; fully restart the Switch/);
 assert.throws(()=>validateNativeMapping(mapping(0x24f000),base),/Unsupported native FS mapping/);
 assert.throws(()=>validateNativeMapping(mapping(0x24e000,{programId:'0400000000000001'}),base),/Unsupported native FS mapping/);
});

test('resident-page proof stops capture before opening any RPC client',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'modloader-capture-'));
 try{
  const run=path.join(root,'switch2-test'),proofFile=path.join(root,'proof.json');
  await fs.mkdir(path.join(run,'switch2'),{recursive:true});
  await fs.writeFile(proofFile,JSON.stringify({session:'switch2-test',verified:true,mapping:mapping(0x24d000)}));
  await fs.writeFile(path.join(run,'switch2/fs-execution-current.json'),JSON.stringify({verified:true,file:proofFile}));
  await assert.rejects(captureNative(run,path.join(root,'capture')),/prior modloader is likely resident; fully restart the Switch/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
