'use strict';
// Independent ARM64 fixtures: function ordering and data placement vary without
// any firmware names, version checks or proprietary code in the test.
const assert=require('node:assert/strict');
const {branchTarget,normalize,fingerprint,dataTarget,discover,offset}=require('../../lib/native/fs-layout.cjs');
const {readExecutableText}=require('../../lib/native-capture.cjs');
const {validateFsMappings}=require('../../lib/native/fs-abi.cjs');
function branch(at,to){return(0x94000000|((to-at)/4&0x3ffffff))>>>0;}
function page(at,to,rd){const delta=((to&~4095)-(at&~4095))/4096,imm=delta&0x1fffff;return(0x90000000|((imm&3)<<29)|((imm>>>2)<<5)|rd)>>>0;}
function image(first,second,global){
 const b=Buffer.alloc(0x4000);b.fill(0xff,0,0x3100);
 const one=[0xd503245f,0xa9bf7bfd,page(first+8,global,8),(0x91000108|((global&4095)<<10))>>>0,0xf9400100,branch(first+20,second),0xa8c17bfd,0xd65f03c0];
 const two=[0xd503245f,0xb40000a0,0xf9400800,0xd65f03c0,0x52800020,0xd65f03c0,0xd503201f,0xd65f03c0];
 one.forEach((word,i)=>b.writeUInt32LE(word,first+i*4));two.forEach((word,i)=>b.writeUInt32LE(word,second+i*4));
 return b;
}
const source=image(0x100,0x200,0x8000),contract={ranges:[0x100,0x200].map(reference=>({offset:reference,size:32,purpose:'operation '+reference,prefix:normalize(source,reference,16).toString('hex'),sha256:fingerprint(source,reference,32)})),links:[{from:0x114,to:0x200}],data:[{offset:0x8000,page:0x108,consumer:0x10c}]};
const candidate=image(0x2020,0x1a00,0x14900),resolved=discover(candidate,contract);
function words(values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32LE(v>>>0,i*4));return b;}
// Page references may have instructions between ADRP and the actual load.
const delayed=words([page(0,0x8000,8),0xaa0103f3,0xf9448108,0xd65f03c0]),moved=words([page(0,0x15000,8),0xaa0103f3,0xf9450108,0xd65f03c0]);
assert(normalize(delayed).equals(normalize(moved)));
const clobbered=words([page(0,0x8000,8),0xaa0003e8,0xf9448108,0xd65f03c0]),otherField=Buffer.from(clobbered);otherField.writeUInt32LE(0xf9450108,8);
assert(!normalize(clobbered).equals(normalize(otherField)),'A pointer loaded into the page register must retain its object-field offsets');
assert.equal(offset(resolved,0x100),0x2020);assert.equal(offset(resolved,0x200),0x1a00);assert.equal(offset(resolved,0x8000),0x14900);assert.equal(offset(resolved,0x104),0x2024);
assert.equal(dataTarget(candidate,0x2028,0x202c),0x14900);assert.equal(branchTarget(candidate.readUInt32LE(0x2034),0x2034),0x1a00);
assert.equal(resolved.cave,0x3100);assert.equal(resolved.control,0x3800);
assert.throws(()=>offset(resolved,0x9911),/Unqualified FS reference/);
const broken=Buffer.from(candidate);broken.writeUInt32LE(0xf9400400,0x2030);assert.throws(()=>discover(broken,contract),/operation 256/);
const flow=Buffer.from(candidate);flow.writeUInt32LE(0xb4000080,0x1a04);assert.throws(()=>discover(flow,contract),/operation 512/);
const misdirected=Buffer.from(candidate);misdirected.writeUInt32LE(branch(0x2034,0x2100),0x2034);assert.throws(()=>discover(misdirected,contract),/call graph/);
const duplicate=Buffer.from(candidate);candidate.copy(duplicate,0x1800,0x1a00,0x1a20);assert.throws(()=>discover(duplicate,contract),/2 matches/);
const occupied=Buffer.from(candidate);occupied.fill(1,0x3f00);assert.throws(()=>discover(occupied,contract),/gateway space/);
// A logger is optional; its absence cannot make required operations disappear.
const optional={...contract,ranges:[...contract.ranges,{offset:0x700,size:16,purpose:'logger',prefix:'00'.repeat(16),sha256:'f'.repeat(64),optional:true}]};
assert.equal(discover(candidate,optional).unavailableLogging.length,1);
// Every actual hook target must be executable after relocation.
const complete={offsets:{},ranges:[],...resolved};
const native=require('../../lib/native/fs-abi.json');
for(const row of native.ranges)if(!Object.hasOwn(complete.offsets,row.offset))complete.offsets[row.offset]=0x2020;
complete.offsets[0x218870]=0x2020;
validateFsMappings([{offset:0,end:candidate.length,permissions:4}],complete);
assert.throws(()=>validateFsMappings([{offset:0,end:candidate.length,permissions:1}],complete),/not executable/);
(async()=>{
 const base=0x5000000000n,identity={pid:13n,programId:'0400000000000000'};let reads=0,badIdentity=false,badCleanup=false;
 const client={async info(){return{result:0,queryResult:0,pid:'13',programId:identity.programId,memory:{address:String(base),size:String(candidate.length),permissions:4,type:3,attributes:0}};},async readBulk(handle,pid,address,size){
  reads++;const at=Number(address-base),bytes=candidate.subarray(at,at+Math.min(size,4096)),data=Buffer.alloc(56);
  data.writeBigUInt64LE(badIdentity?8n:pid);data.writeBigUInt64LE(BigInt('0x'+identity.programId),8);data.writeBigUInt64LE(badCleanup?1n:0n,40);data.writeBigUInt64LE(BigInt(bytes.length),48);return{result:0,length:bytes.length,data,bytes};
 }};
 assert((await readExecutableText(client,9,base,identity)).equals(candidate));assert.equal(reads,4);
 badIdentity=true;await assert.rejects(readExecutableText(client,9,base,identity),/identity or alias/);badIdentity=false;
 badCleanup=true;await assert.rejects(readExecutableText(client,9,base,identity),/identity or alias/);
 console.log('FS relocation: independent code/data moves, reordered functions, branch/field integrity, ambiguity, owned padding, optional logging, executable mappings and partial RPC capture: passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
