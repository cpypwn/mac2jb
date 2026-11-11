'use strict';
const assert=require('node:assert/strict'),{sha}=require('../../lib/common.cjs');
const {identifyFs,verifyBulk,FS_PROGRAM}=require('../../lib/native/identity.cjs');
const {Bridge,selectNotifier}=require('../../lib/native/bridge.cjs');
// Qualify the compatibility policy independently of proprietary FS bytes.
// The same offsets and extents are exercised with deterministic page fixtures.
const profileFile=require.resolve('../../lib/native/fs-abi.json'),original=require(profileFile);
const profile=JSON.parse(JSON.stringify(original)),fixture=Buffer.alloc(profile.captureSize);
for(const range of profile.ranges)range.sha256=sha(fixture.subarray(range.offset,range.offset+range.size));
require.cache[profileFile].exports=profile;
const {validateFsAbi,validateFsMappings}=require('../../lib/native/fs-abi.cjs'),{readNativeText}=require('../../lib/native-capture.cjs');
const base=0x5000000000n,identity={pid:13n,programId:FS_PROGRAM};
let permission=1,queryResult=0,wrongPid=false,short=false,unmap=0n,reads=0;
function reply(address,length){
 const data=Buffer.alloc(56),n=short?Math.min(64,length):length;
 for(const [at,value]of [[0,wrongPid?8n:identity.pid],[8,BigInt('0x'+FS_PROGRAM)],[40,unmap],[48,BigInt(n)]])data.writeBigUInt64LE(value,at);
 return{result:0,length:n,data,bytes:fixture.subarray(Number(address-base),Number(address-base)+n)};
}
const client={async info(handle,address,pid){assert.equal(handle,9);assert.equal(pid,identity.pid);return{result:0,pid:String(identity.pid),programId:identity.programId,queryResult,memory:{address:String(address&~4095n),size:'4096',type:3,permissions:permission,attributes:0}};},
 async readBulk(handle,pid,address,length){assert.equal(handle,9);assert.equal(pid,13n);reads++;return reply(address,length);}};
(async()=>{
 const identified=await identifyFs({info:async handle=>{assert.equal(handle,9);return{result:0,pid:'13',programId:FS_PROGRAM};}},9,{pid:'13',programId:FS_PROGRAM});assert.deepEqual(identified,identity);
 await assert.rejects(identifyFs({info:async()=>({result:0,pid:'13',programId:'0100000000000000'})},9),/not native FS/);
 await assert.rejects(identifyFs({info:async()=>({result:0,pid:'13',programId:FS_PROGRAM})},9,{pid:'8',programId:FS_PROGRAM}),/current session proof/);
 const notifier={E:100,B:200},proof={notifier:{object:100,backend:200,handle:17}};
 assert.equal(selectNotifier({worker:{joined:true},notifiers:[12,17,19]},proof,notifier),17);
 assert.throws(()=>selectNotifier({worker:{joined:false},notifiers:[17]},proof,notifier),/worker/);
 assert.throws(()=>selectNotifier({worker:{joined:true},notifiers:[12,19]},proof,notifier),/unavailable/);
 assert.throws(()=>selectNotifier({worker:{joined:true},notifiers:[17]},proof,{E:101,B:200}),/current FS proof/);
 const bridge=new Bridge();Object.assign(bridge,{base,c:client,h:9,pid:identity.pid,identity,capture:fixture});
 const bridgeBytes=await bridge.read(base,256);assert.equal(bridgeBytes.length,256);
 client.patch=async(handle,pid,address,before,after)=>{assert.equal(handle,9);assert.equal(pid,13n);assert.equal(address,base);assert.equal(before.length,16);assert.equal(after.length,16);return{result:0,expectedMatched:true,readbackMatched:true,unmapResult:0};};
 await bridge.patch(base,Buffer.alloc(16),Buffer.alloc(16));
 for(const permissions of [1,4,5]){permission=permissions;short=permissions===5;const bytes=await readNativeText(client,9,base,identity);assert.equal(bytes.length,fixture.length);assert.equal(validateFsAbi(bytes).validatedRanges,profile.ranges.length);}
 const executableMaps=[{offset:0,end:0x23e000,permissions:4},{offset:0x23e000,end:0x23f000,permissions:1},{offset:0x23f000,end:profile.captureSize,permissions:5}];
 validateFsMappings(executableMaps);
 const maps=[];let cursor=0;
 for(const offset of [0x1050a0,0x1053d0,0x105410]){maps.push({offset:cursor,end:offset,permissions:5},{offset,end:offset+16,permissions:1});cursor=offset+16;}
 maps.push({offset:cursor,end:profile.captureSize,permissions:5});assert.equal(validateFsMappings(maps).loggingExecutable,false);
 assert.throws(()=>validateFsMappings([{offset:0,end:profile.captureSize,permissions:1}]),error=>error.fsCompatibility?.stage==='native-code-mappings');
 permission=3;let before=reads;await assert.rejects(readNativeText(client,9,base,identity),error=>error.fsCompatibility?.stage==='capture-mapping');assert.equal(reads,before);
 permission=1;queryResult=0xf601;await assert.rejects(readNativeText(client,9,base,identity),/queryResult=62977/);queryResult=0;
 wrongPid=true;await assert.rejects(readNativeText(client,9,base,identity),/identity or alias/);wrongPid=false;
 unmap=0xd401n;await assert.rejects(readNativeText(client,9,base,identity),/identity or alias/);unmap=0n;
 short=false;const bulk=reply(base,64);bulk.data.writeBigUInt64LE(63n,48);assert.throws(()=>verifyBulk(bulk,identity,64),/identity or alias/);
 const zero={...reply(base,1),length:0,bytes:Buffer.alloc(0)};assert.throws(()=>verifyBulk(zero,identity,64,{partial:true}),/invalid length/);
 // Unused page contents do not constrain the gateway. Actual code and the
 // blocks that will be overwritten remain qualified.
 fixture[0x24dc00]=1;assert.equal(validateFsAbi(fixture).validatedRanges,profile.ranges.length);
 // These bytes used to gate compatibility only because they shared a 4 KiB
 // page with an SDK function. They are neither executed nor overwritten.
 for(const offset of [0x4b000,0x69000,0xed000,0xef000,0x103000,0x104000,0x105a00,0x107000,0x120000,0x121000,0x24a000]){
  assert(!profile.ranges.some(range=>range.offset<=offset&&offset<range.offset+range.size));fixture[offset]=1;
 }
 assert.equal(validateFsAbi(fixture).validatedRanges,profile.ranges.length);
 const body=profile.ranges.find(range=>range.offset===0x1045b0),byte=body.offset+body.size-4;
 fixture[byte]=1;assert.throws(()=>validateFsAbi(fixture),error=>error.fsCompatibility?.stage==='native-functions');fixture[byte]=0;
 // A logger ABI change must disable its native calls without excluding an
 // otherwise valid FS or accepting changed modloader code.
 for(const offset of [0x1050a0,0x1053d0,0x105410])fixture[offset]=1;
 const optional=validateFsAbi(fixture);assert.equal(optional.runtimeLoggingCompatible,false);assert.equal(optional.loggingMismatches.length,3);assert.equal(optional.validatedRanges,profile.ranges.length-3);
 for(const offset of [0x1050a0,0x1053d0,0x105410])fixture[offset]=0;
 fixture[profile.padding.used[0].offset]=1;assert.throws(()=>validateFsAbi(fixture),/gateway space/);fixture[profile.padding.used[0].offset]=0;
 fixture[profile.padding.used[1].offset]=1;assert.throws(()=>validateFsAbi(fixture),/gateway space/);fixture[profile.padding.used[1].offset]=0;
 const changed=profile.ranges[0];fixture[changed.offset]=1;
 assert.throws(()=>validateFsAbi(fixture),error=>error.fsCompatibility?.mismatches[0].actual===sha(fixture.subarray(changed.offset,changed.offset+changed.size)));
 console.log('FS compatibility: read-only/RX/X captures, dynamic PID, partial transfers, identity and cleanup failures, qualified functions and scoped gateway padding: passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
