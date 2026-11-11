'use strict';
const assert=require('node:assert/strict'),{decode,checksum}=require('../../tools/read-diagnostics.cjs');
function page(generation){const p=Buffer.alloc(16384);p.write('NS2TRC01');p.writeUInt32LE(1,8);p.writeUInt32LE(16384,12);p.writeBigUInt64LE(BigInt(generation),16);p.writeBigUInt64LE(9000000n,24);p.writeBigUInt64LE(1000000n,32);
 function record(at,seq,op,result=0){p.writeBigUInt64LE(BigInt(seq),at);p.writeBigUInt64LE(8000000n,at+8);p.writeBigUInt64LE(0x100000007n,at+32);p.writeBigUInt64LE(500n,at+40);p.writeBigUInt64LE(900000n,at+56);p.writeUInt32LE(2,at+64);p.writeUInt32LE(op,at+68);p.writeUInt32LE(1,at+72);p.writeUInt32LE(result,at+76);}
 record(15488+128,5,2,0xd401);record(15488+256,8,9);record(15488+384,6,2);record(15488+512,8,9);record(15488+768,7,10);p.writeUInt32LE(checksum(p),112);return p;}
const text='File identity: id=1 program=04006e001823c001 kind=1 size=8589934592 name="/test.pak" source="/sd/test.pak"';
const trace=Buffer.concat([page(1),page(2)]),r=decode(trace,text);assert(r.available);assert.equal(r.generation,'2');assert.equal(r.highlights.firstError.nativeResult,'0xd401');assert.equal(r.highlights.lastSourceRead.file.name,'/test.pak');assert.equal(r.highlights.lastSourceRead.offset,'0x100000007');assert.equal(r.highlights.lastOriginalRead.operation,'original RomFS read');assert.equal(r.highlights.lastLockWait.operation,'wait for source cache lock');assert(r.findings.some(f=>f.kind==='native-error'));assert(r.findings.some(f=>f.kind==='slow-operation'));
trace[20000]^=1;assert.equal(decode(trace,text).generation,'1');trace[100]^=1;assert.equal(decode(trace,text).available,false);assert.throws(()=>decode(Buffer.alloc(1)),/exactly/);
console.log('Reader error/slow/lock highlights, file identity, 64-bit ranges and torn-page fallback: passed');
// Checkpoint 4 keeps an independent I/O journal and maps original PAK ranges.
const {progressChecksum}=require('../../tools/read-diagnostics.cjs');
function ioPage(generation,phase,result=0){const p=Buffer.alloc(4096);p.write('NS2IO001');p.writeUInt32LE(1,8);p.writeUInt32LE(4096,12);p.writeBigUInt64LE(BigInt(generation),16);p.writeBigUInt64LE(10000000n,24);p.writeBigUInt64LE(1000000n,32);p.writeBigUInt64LE(2n,48);p.writeUInt32LE(2,64);p.writeUInt32LE(phase,68);p.writeUInt32LE(result,72);p.writeBigUInt64LE(1000n,2696);p.writeUInt32LE(progressChecksum(p),128);return p;}
const extended=Buffer.concat([page(1),page(2),ioPage(1,1),ioPage(2,2)]);
let journal=decode(extended,text);assert.equal(journal.ioJournal.phase,'call returned');assert.equal(journal.ioJournal.completedSizeQueries,'1000');assert(journal.findings.some(f=>f.kind==='snapshot-flush-returned'));
extended[32768+4096+200]^=1;journal=decode(extended,text);assert.equal(journal.ioJournal.phase,'before call');assert(journal.findings.some(f=>f.kind==='recorder-call-not-seen-returning'));
extended[32768+200]^=1;assert.equal(decode(extended,text).ioJournal.available,false);
const noSnapshot=Buffer.concat([Buffer.alloc(32768),ioPage(1,1),ioPage(2,2)]);assert.equal(decode(noSnapshot).available,false);assert.equal(decode(noSnapshot).ioJournal.available,true);
const mapped=page(1);const at=15488+512;mapped.writeBigUInt64LE(0x1008n,at+24);mapped.writeBigUInt64LE(0x40004000n,at+32);mapped.writeBigUInt64LE(512n,at+40);mapped.writeUInt32LE(checksum(mapped),112);
const mapping='RomFS storage object 04006e001823c001 0000000000001000 00000000\nOriginal directory file 04006e001823c001 0000000000010000 00000000 /UNION/Content/Paks/pakchunk0-Sage.pak\nOriginal directory offset 04006e001823c001 0000000040000000 00000000 /UNION/Content/Paks/pakchunk0-Sage.pak\n';
const original=decode(Buffer.concat([mapped,Buffer.alloc(16384)]),mapping).highlights.lastOriginalRead;assert.equal(original.originalFile.name,'/UNION/Content/Paks/pakchunk0-Sage.pak');assert.equal(original.originalFile.offsetWithinFile,'0x4000');
console.log('I/O journal phases, independent torn-page fallback and original PAK read identity: passed');
// A saved close under a cache lock must identify its owner and other waiter.
function pending(p,slot,seq,op,thread,object,file=1){const at=128+64*128+slot*128;p.writeBigUInt64LE(BigInt(seq),at);p.writeBigUInt64LE(8000000n,at+8);p.writeBigUInt64LE(BigInt(thread),at+16);p.writeBigUInt64LE(BigInt(object),at+24);p.writeUInt32LE(1,at+64);p.writeUInt32LE(op,at+68);p.writeUInt32LE(file,at+72);}
const locked=page(3);pending(locked,0,10,14,0xaa,0x100);pending(locked,1,11,17,0xaa,0x200);pending(locked,2,12,10,0xbb,0x100);locked.writeUInt32LE(checksum(locked),112);
let locks=decode(Buffer.concat([locked,Buffer.alloc(16384)]),text).lockState;assert.equal(locks.owners[0].thread,'0xaa');assert.equal(locks.owners[0].heldAtCheckpointMs,1000);assert.equal(locks.owners[0].nestedCalls[0].operation,'close cached SD file');assert.equal(locks.waits[0].ownerThread,'0xaa');assert.equal(locks.possibleWaitCycles.length,0);
// Reciprocal wait ownership is described as a possible cycle, never a proof.
pending(locked,3,13,15,0xbb,0x300);pending(locked,4,14,11,0xaa,0x300);locked.writeUInt32LE(checksum(locked),112);
locks=decode(Buffer.concat([locked,Buffer.alloc(16384)]),text).lockState;assert(locks.possibleWaitCycles.length);assert.match(locks.interpretation,/not proof/);
const ioLocks=ioPage(4,2);locked.copy(ioLocks,136,128+64*128,128+80*128);ioLocks.writeUInt32LE(progressChecksum(ioLocks),128);
const withoutSnapshot=decode(Buffer.concat([Buffer.alloc(32768),ioLocks,Buffer.alloc(4096)]),text);assert(!withoutSnapshot.available&&withoutSnapshot.ioJournal.lockState.owners.length===2);assert(withoutSnapshot.ioJournal.lockState.possibleWaitCycles.length);
pending(locked,5,15,12,0xcc,0x999);locked.writeUInt32LE(checksum(locked),112);locks=decode(Buffer.concat([locked,Buffer.alloc(16384)]),text).lockState;assert(locks.waits.find(w=>w.thread==='0xcc').ownerNotObserved);
console.log('Saved lock ownership, nested native close, owner/waiter identity, possible cycles, missing owners and journal-only recovery: passed');
// An expected optional-command rejection is different from failed SD I/O.
for(const operation of [26,27,28]){
 const optional=page(4),at=15488+128;optional.writeUInt32LE(operation,at+68);optional.writeUInt32LE(0x313802,at+76);optional.writeUInt32LE(checksum(optional),112);
 const decoded=decode(Buffer.concat([optional,Buffer.alloc(16384)]));
 assert(decoded.findings.some(f=>f.kind==='optional-storage-unsupported'));
 assert(!decoded.findings.some(f=>f.kind==='native-error'));
 assert.notEqual(decoded.highlights.firstError.operation,'unknown');
}
console.log('Optional range/batch UnsupportedOperation is identified without reporting an SD read failure: passed');
const codeMount=page(5),mountAt=128;
codeMount.writeBigUInt64LE(1n,mountAt);codeMount.writeUInt32LE(2,mountAt+64);codeMount.writeUInt32LE(29,mountAt+68);
codeMount.writeBigUInt64LE(0x04006e001823c001n,mountAt+32);codeMount.writeBigUInt64LE((5n<<32n)|13n,mountAt+40);codeMount.writeBigUInt64LE(0x4700000010n,mountAt+48);
codeMount.writeUInt32LE(checksum(codeMount),112);
const mount=decode(Buffer.concat([codeMount,Buffer.alloc(16384)])).recentOperations[0];
assert.equal(mount.operation,'mount program CodeFS');assert.deepEqual(mount.codeMount,{programId:'04006e001823c001',attributes:13,storageId:5,filesystem:'0x4700000010'});
console.log('CodeFS mount program/storage/attributes and 64-bit returned filesystem identity: passed');
