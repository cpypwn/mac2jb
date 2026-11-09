const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareInstalledLicense}=require('../lib/game-files/program.cjs');

const title='0400f5802371e000';

function installedLicense({matching=true}={}){
 const memory=new Map();
 const calls=[];
 const base=0x100000;
 const count=()=>{const data=Buffer.alloc(4);data.writeUInt32LE(1);return data;};
 const identity=Buffer.alloc(8);
 identity.writeBigUInt64LE(BigInt('0x'+title));
 const rights=Buffer.concat([Buffer.from(title,'hex'),Buffer.from('0102030405060708','hex')]);
 const owner=Buffer.from('0102030405060708','hex');
 const uuid=Buffer.from('0123456789abcdef0123456789abcdef','hex');
 const license=Buffer.alloc(0x50);
 uuid.copy(license);
 owner.copy(license,0x20);
 license.writeBigUInt64LE(BigInt('0x'+(matching?title:'0400000000000001')),0x38);
 const accepted=Buffer.alloc(8);
 accepted.writeBigUInt64LE(BigInt('0x'+title));
 const s={base,bytes:0x80000,threads:new Set(),handles:new Set(),
  async write(address,bytes){memory.set(address,Buffer.from(bytes));},
  async readOwned(address,size){return Buffer.from(memory.get(address)?.subarray(0,size)||[]);},
  async ipc(label,handle,id,_input,options={}){
   calls.push({label,handle,id});
   if(id===1004||id===1005||id===1006){
    if(id===1005){const output=Buffer.alloc(options.receive[0].size);uuid.copy(output);memory.set(base+0x5000,output);}
    if(id===1006)memory.set(base+0x5000,license);
    return {result:0,data:count()};
   }
   if(id===606)return {result:0,data:rights};
   if(id===2001)return {result:0};
   if(id===6){memory.set(base+0x5000,accepted);return {result:0,data:count()};}
   return {result:0,data:Buffer.alloc(0)};
  }};
 const domain={async send(_s,_label,_root){return {result:0,data:identity};},
  oneHandle(){s.handles.add(77);return 77;}};
 const service=async name=>{calls.push({service:name});assert.equal(name,'es');return 8;};
 return {s,root:9,domain,service,title,source:{storage:4,contentPath:'@test',attributes:0,selection:'base'},calls};
}

test('installed base content selects and prepares its matching ELicense',async()=>{
 const fixture=installedLicense();
 assert.equal(await prepareInstalledLicense(fixture),true);
 assert.ok(fixture.calls.some(call=>call.id===606));
 assert.ok(fixture.calls.some(call=>call.id===503));
 assert.equal(fixture.s.nativeInstalledLicenseContext.prepared.size,1);
});

test('installed base content rejects unrelated ELicense owners',async()=>{
 const fixture=installedLicense({matching:false});
 await assert.rejects(prepareInstalledLicense(fixture),/No installed account ELicense/);
 assert.equal(fixture.calls.some(call=>call.id===503),false);
});

test('game-card content never attempts installed-license preparation',async()=>{
 let used=false;
 const result=await prepareInstalledLicense({source:{storage:2},service:async()=>{used=true;}});
 assert.equal(result,false);
 assert.equal(used,false);
});
