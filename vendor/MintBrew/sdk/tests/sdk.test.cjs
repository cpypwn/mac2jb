const test=require('node:test'),assert=require('node:assert/strict');
const {validateManifest}=require('../host/runtime.cjs');
const {namespace,inventory}=require('../tools/audit.cjs');
const {create}=require('../native/client.cjs');
test('manifest validates explicit capabilities and bounded IPv4 endpoints',()=>{
 assert.deepEqual(validateManifest(),{capabilities:[],endpoints:[]});
 assert.deepEqual(validateManifest({version:1,capabilities:['udp','udp'],endpoints:[{address:'127.0.0.1',port:9000}]}).capabilities,['udp']);
 for(const value of [{version:2,capabilities:[]},{version:1,capabilities:['native']},{version:1,capabilities:['udp'],endpoints:[{address:'example.com',port:80}]},{version:1,capabilities:[],endpoints:[{address:'127.0.0.1',port:65536}]}])assert.throws(()=>validateManifest(value));
});
test('native client verifies code before allocating and enforces exact buffer bounds',async()=>{
 const calls=[],base=0x100000,memory=Buffer.alloc(4096);
 const rpc={a:{sdk:0x200000},output:0x300000,async request(v){calls.push(v);},async call(){assert.equal(calls.length,1);const output=Buffer.alloc(8);output.writeBigUInt64LE(BigInt(base));return {result:0n,output};},async write(address,b){b.copy(memory,address-base);},async read(address,n){return memory.subarray(address-base,address-base+n);},async callAddress(){return {result:0xffffffffn};}};
 const api=await create(rpc,{known:{offset:4,hex:'c0035fd6'}},4096);
 await api.write(4092,Buffer.from([1,2,3,4]));assert.equal((await api.read(4092,4)).toString('hex'),'01020304');assert.equal(await api.result('known'),0xffffffff);
 for(const [offset,length]of [[-1,1],[4096,1],[0,-1],[.5,1],[NaN,1]])await assert.rejects(api.read(offset,length),/bounds/);
 await assert.rejects(api.call('toString'),/Unknown/);await assert.rejects(api.call('known',[1,2,3,4,5]),/four/);await assert.rejects(create(rpc,{},1),/size/);
});
test('a failed instruction qualification prevents any allocation or call',async()=>{
 let touched=false;await assert.rejects(create({a:{sdk:0},async request(){throw Error('mismatch');},async call(){touched=true;}},{f:{offset:4,hex:'00000000'}}),/mismatch/);assert.equal(touched,false);
});
test('inventory parses length-prefixed namespaces and distinguishes imports',()=>{
 assert.equal(namespace('_ZN2nn8irsensor17GetIrCameraStatusEv'),'irsensor');
 assert.equal(namespace('_ZNK2nn3hid18SixAxisSensorStateEv'),'hid');
 const groups=inventory({sdk:{symbols:[{name:'_ZN2nn3hid4TestEv',type:2,section:1}]},main:{symbols:[{name:'_ZN2nn3hid4TestEv',type:2,section:0}]}});
 assert.deepEqual(groups.hid,{sdkDefinitions:1,mainImports:1,mainDefinitions:0});
});
test('motion decoder preserves u64 sample identity and signed float components',()=>{
 const b=Buffer.alloc(96);b.writeBigUInt64LE(9007199254740993n,8);b.writeFloatLE(-.5,16);const m=require('../host/layout.cjs').motion(b);assert.equal(m.sequence,'9007199254740993');assert.equal(m.acceleration[0],-.5);assert.throws(()=>require('../host/layout.cjs').motion(Buffer.alloc(95)));
});
test('mailbox dispatch acknowledges once, rejects undeclared capabilities and resets on app switch',async()=>{
 const L=require('../host/layout.cjs'),memory=Buffer.alloc(L.SIZE),mapped=0x400000;
 let pulses=0,closed=false;
 const rpc={async read(address,n){return Buffer.from(memory.subarray(address-mapped-L.OFFSET,address-mapped-L.OFFSET+n));},async write(address,b){b.copy(memory,address-mapped-L.OFFSET);}};
 const hardware={async poll(){return Buffer.alloc(1024);},async pulse(){pulses++;return {actual:Buffer.alloc(16)};},async close(){closed=true;}};
 const runtime=await require('../host/runtime.cjs').create({rpc,mapped,hardware});
 await runtime.atBoundary();memory.writeUInt32LE(1,L.FIELD.request);memory.writeUInt32LE(1,L.FIELD.request+4);
 await runtime.atBoundary();await runtime.atBoundary();assert.equal(pulses,1);assert.equal(memory.readUInt32LE(L.FIELD.response),1);
 const app={fingerprint:'test',manifest:{}};await runtime.atBoundary(app);assert.equal(memory.readUInt32LE(L.FIELD.request),0);
 memory.writeUInt32LE(1,L.FIELD.request);memory.writeUInt32LE(1,L.FIELD.request+4);await runtime.atBoundary(app);
 assert.equal(memory.readUInt32LE(L.FIELD.response+4),L.STATUS.unsupported);assert.equal(pulses,1);await runtime.close();assert.equal(closed,true);
});
test('checked-in native signatures cover optical worker dependencies',()=>{
 const d=require('../native/ipc-functions.json');for(const key of ['send','aruid','transfer','copy'])assert.ok(d[key]&&d[key].hex.length>=8);assert.equal(d.copy.offset,0x586fb0);
});
