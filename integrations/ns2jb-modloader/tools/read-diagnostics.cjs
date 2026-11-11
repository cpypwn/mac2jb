#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const PAGE=16384,RECORD=128,IO_PAGE=4096;
const operations={1:'source open/cache lookup',2:'SD source read',3:'game RomFS read',4:'game RomFS size',5:'mount current program',6:'mount explicit program',7:'mount data program',8:'prepare virtual RomFS',9:'original RomFS read',10:'wait for source cache lock',11:'wait for preparation lock'};
Object.assign(operations,{12:'wait for tracked object lock',13:'holding tracked object lock',14:'holding source cache lock',15:'holding preparation lock',16:'release tracked SDK object',17:'close cached SD file',18:'retain SD file for read',19:'native SD file open',20:'program identity lookup',21:'allocate native plan memory',22:'free native plan memory',23:'release SD read reference',24:'retain tracked SDK object',25:'drop untracked SDK reference'});
Object.assign(operations,{26:'game RomFS QueryRange',27:'game RomFS Invalidate',28:'game RomFS BatchRead'});
Object.assign(operations,{29:'mount program CodeFS',30:'prepare mounted CodeFS'});
const ioOperations={1:'trace snapshot write',2:'trace snapshot flush',3:'text log write',4:'text log flush'};
function checksumBytes(b,size,offset){let h=2166136261;for(let i=0;i<size;i++)h=Math.imul((h^(i>=offset&&i<offset+4?0:b[i]))>>>0,16777619)>>>0;return h;}
const checksum=b=>checksumBytes(b,PAGE,112),progressChecksum=b=>checksumBytes(b,IO_PAGE,128);
function decode(buffer,text=''){
 if(![PAGE*2,PAGE*2+IO_PAGE*2].includes(buffer.length))throw Error('Trace must contain exactly 32 KiB (legacy) or 40 KiB (with I/O journal)');
 const pages=[];for(let i=0;i<2;i++){
  const b=buffer.subarray(i*PAGE,(i+1)*PAGE);
  const valid=b.toString('ascii',0,8)==='NS2TRC01'&&b.readUInt32LE(8)===1&&b.readUInt32LE(12)===PAGE&&b.readUInt32LE(112)===checksum(b);
  pages.push({slot:i,valid,generation:valid?b.readBigUInt64LE(16):0n,buffer:b});
 }
 const valid=pages.filter(p=>p.valid).sort((a,b)=>a.generation>b.generation?-1:a.generation<b.generation?1:0),files=new Map(),storages=[];let storage=null;
 for(const line of text.split('\n')){
  const identity=/^File identity: id=(\d+) program=(\S+) kind=(\d+) size=(\d+) name=("(?:\\.|[^"\\])*") source=("(?:\\.|[^"\\])*")$/.exec(line);
  if(identity)files.set(+identity[1],{program:identity[2],kind:+identity[3],size:identity[4],name:JSON.parse(identity[5]),source:JSON.parse(identity[6])});
  const event=/^(RomFS storage object|Original directory file|Original directory offset|RomFS virtual size) ([0-9a-f]{16}) ([0-9a-f]{16}) ([0-9a-f]{8})(?: (.*))?$/.exec(line);if(!event||event[4]!=='00000000')continue;
  if(event[1]==='RomFS storage object'){storage={object:BigInt('0x'+event[3]),program:event[2],originalFiles:[]};storages.push(storage);}
  else if(storage&&event[2]===storage.program){
   if(event[1]==='RomFS virtual size')storage.virtualSize=BigInt('0x'+event[3]);
   else if(event[1]==='Original directory file')storage.originalFiles.push({name:event[5],size:BigInt('0x'+event[3])});
   else{const file=storage.originalFiles.find(f=>f.name===event[5]);if(file)file.offset=BigInt('0x'+event[3]);}
  }
 }
 const hex=n=>'0x'+n.toString(16),milliseconds=(n,f)=>f?Number(n)*1000/f:null;
 function record(b,at,frequency){
  const seq=b.readBigUInt64LE(at);if(!seq)return null;
  const file=b.readUInt32LE(at+72),sample=b.readUInt32LE(at+120);if(sample>32)throw Error('Trace sample length is invalid');
  const operationId=b.readUInt32LE(at+68),object=b.readBigUInt64LE(at+24),offset=b.readBigUInt64LE(at+32),requested=b.readBigUInt64LE(at+40);
  const owners=storages.filter(s=>s.object===(operationId===9?object-8n:object)),owner=owners.length===1?owners[0]:null;
  const original=owner&&[3,9].includes(operationId)?owner.originalFiles.find(f=>f.offset!==undefined&&offset>=f.offset&&offset-f.offset<f.size&&requested<=f.size-(offset-f.offset)):null;
  return{sequence:String(seq),event:b.readUInt32LE(at+64)===1?'begin':'end',operation:operations[operationId]||'unknown',operationId,fileId:file,file:files.get(file)||null,tick:String(b.readBigUInt64LE(at+8)),thread:hex(b.readBigUInt64LE(at+16)),object:hex(object),offset:hex(offset),requested:String(requested),actualOrProgramId:String(b.readBigUInt64LE(at+48)),durationMs:milliseconds(b.readBigUInt64LE(at+56),frequency),nativeResult:hex(BigInt(b.readUInt32LE(at+76))),parentSequence:String(b.readBigUInt64LE(at+80)),sampleHex:b.subarray(at+88,at+88+sample).toString('hex'),flags:b.readUInt32LE(at+124),...(operationId===29?{codeMount:{programId:offset.toString(16).padStart(16,'0'),attributes:Number(requested&0xffffffffn),storageId:Number(requested>>32n),filesystem:b.readUInt32LE(at+64)===2?hex(b.readBigUInt64LE(at+48)):null}}:{}),...(owner?{storageProgram:owner.program}:owners.length>1?{storageIdentityAmbiguous:true}:{}),...(original?{originalFile:{name:original.name,offsetWithinFile:hex(offset-original.offset),size:String(original.size)}}:{})};
 }
 function pendingRecords(b,offset,tick,frequency){const list=[];for(let i=0;i<16;i++){const r=record(b,offset+i*RECORD,frequency);if(r)list.push({...r,ageAtCheckpointMs:milliseconds(tick-BigInt(r.tick),frequency)});}return list;}
 function lockState(list){
  const pairs=new Map([[13,12],[14,10],[15,11]]),held=list.filter(r=>pairs.has(r.operationId));
  const owners=held.map(r=>({lock:r.object,thread:r.thread,operation:r.operation,heldAtCheckpointMs:r.ageAtCheckpointMs,file:r.file,waiters:list.filter(w=>w.operationId===pairs.get(r.operationId)&&w.object===r.object).map(w=>({thread:w.thread,waitAtCheckpointMs:w.ageAtCheckpointMs,file:w.file})),nestedCalls:list.filter(n=>n.thread===r.thread&&n.sequence!==r.sequence&&BigInt(n.tick)>=BigInt(r.tick)&&![10,11,12,13,14,15].includes(n.operationId))}));
  const waits=list.filter(r=>[10,11,12].includes(r.operationId)).map(r=>{const candidates=held.filter(h=>pairs.get(h.operationId)===r.operationId&&h.object===r.object);return{...r,...(candidates.length===1?{ownerThread:candidates[0].thread}:candidates.length>1?{ownerAmbiguous:true}:{ownerNotObserved:true})};});
  const cycles=[];for(const start of waits){let next=start,path=[],seen=new Set();while(next&&!seen.has(next.thread)){seen.add(next.thread);path.push({thread:next.thread,lock:next.object,ownerThread:next.ownerThread});if(next.ownerThread===start.thread){cycles.push(path);break;}next=next.ownerThread?waits.find(w=>w.thread===next.ownerThread):null;}}
  return{owners,waits,possibleWaitCycles:cycles,interpretation:'Ownership and waits were observed at this saved moment. A possible cycle or pending call is not proof of a sustained deadlock; missing records are counted separately.'};
 }
 let ioJournal={available:false,reason:buffer.length===PAGE*2?'Legacy trace does not include an I/O journal.':'No valid I/O journal page.'};
 if(buffer.length>PAGE*2){
  const ioPages=[];for(let i=0;i<2;i++){
   const b=buffer.subarray(PAGE*2+i*IO_PAGE,PAGE*2+(i+1)*IO_PAGE);
   const valid=b.toString('ascii',0,8)==='NS2IO001'&&b.readUInt32LE(8)===1&&b.readUInt32LE(12)===IO_PAGE&&b.readUInt32LE(128)===progressChecksum(b);
   ioPages.push({slot:i,valid,generation:valid?b.readBigUInt64LE(16):0n,buffer:b});
  }
  const good=ioPages.filter(p=>p.valid).sort((a,b)=>a.generation>b.generation?-1:a.generation<b.generation?1:0);
  if(good.length){const b=good[0].buffer,frequency=Number(b.readBigUInt64LE(32)),tick=b.readBigUInt64LE(24),operation=b.readUInt32LE(64),phase=b.readUInt32LE(68),result=b.readUInt32LE(72),locks=b.readUInt32LE(120);
   ioJournal={available:true,generation:String(good[0].generation),selectedPage:good[0].slot,pages:ioPages.map(p=>({slot:p.slot,valid:p.valid,generation:String(p.generation)})),tick:String(tick),tickFrequency:frequency,thread:hex(b.readBigUInt64LE(40)),snapshotGeneration:String(b.readBigUInt64LE(48)),sequence:String(b.readBigUInt64LE(56)),operation:ioOperations[operation]||'unknown',operationId:operation,phase:phase===1?'before call':'call returned',nativeResult:hex(BigInt(result)),offset:hex(b.readBigUInt64LE(80)),length:String(b.readBigUInt64LE(88)),completedOperations:String(b.readBigUInt64LE(96)),logCursor:String(b.readBigUInt64LE(104)),activeRomfsCalls:String(b.readBigUInt64LE(112)),locks:{traceWriter:!!(locks&1),textWriter:!!(locks&2),preparation:!!(locks&4)},traceWriteFailure:hex(BigInt(b.readUInt32LE(124))),textLogFailed:!!b.readUInt32LE(132),pendingAtJournal:pendingRecords(b,136,tick,frequency),lastCompleted:record(b,2184,frequency),lastSourceRead:record(b,2312,frequency),lastOriginalRead:record(b,2440,frequency),lastSizeQuery:record(b,2568,frequency),completedSizeQueries:String(b.readBigUInt64LE(2696))};
   ioJournal.lockState=lockState(ioJournal.pendingAtJournal);
  }else ioJournal.pages=ioPages.map(p=>({slot:p.slot,valid:p.valid}));
 }
 if(!valid.length)return{available:false,reason:'No complete trace checkpoint. Activation may not have reached the first snapshot, or both pages are incomplete.',pages:pages.map(p=>({slot:p.slot,valid:p.valid})),ioJournal};
 const b=valid[0].buffer,frequency=Number(b.readBigUInt64LE(32)),ms=n=>milliseconds(n,frequency),recent=[],pending=pendingRecords(b,128+64*RECORD,b.readBigUInt64LE(24),frequency),stats=[];
 for(let i=0;i<64;i++){const r=record(b,128+i*RECORD,frequency);if(r)recent.push(r);}recent.sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1);
 for(let i=0;i<64;i++){
  const at=128+80*RECORD+i*80,id=b.readUInt32LE(at);if(!id)continue;const flags=b.readUInt32LE(at+4);
  stats.push({fileId:id,file:files.get(id)||null,reads:String(b.readBigUInt64LE(at+8)),bytes:String(b.readBigUInt64LE(at+16)),errors:String(b.readBigUInt64LE(at+24)),lastOffset:hex(b.readBigUInt64LE(at+32)),lastRequested:String(b.readBigUInt64LE(at+40)),lastTick:String(b.readBigUInt64LE(at+48)),pak:flags&1?{version:b.readUInt32LE(at+72),indexOffset:hex(b.readBigUInt64LE(at+56)),indexSize:String(b.readBigUInt64LE(at+64)),firstIndexRequestObserved:!!(flags&4),firstIndexRequestCompleted:!!(flags&8),laterDataRequestObserved:!!(flags&32),laterDataRequestCompleted:!!(flags&64)}:null});
 }
 const highlights={};for(const [i,name]of ['lastCompleted','firstError','slowestCompleted','lastSourceRead','lastOriginalRead','lastPreparation','lastLockWait'].entries())highlights[name]=record(b,15488+i*128,frequency);
 const lockOwnership=lockState(pending),findings=[];
 if(lockOwnership.possibleWaitCycles.length||ioJournal.lockState?.possibleWaitCycles.length)findings.push({kind:'possible-lock-cycle-at-save',message:'A saved set of lock owners and waiters contains a possible wait cycle. Compare its ages and later progress; a saved moment does not establish a lasting deadlock.'});
 if(highlights.firstError){
  const optional=[26,27,28].includes(highlights.firstError.operationId)&&highlights.firstError.nativeResult==='0x313802';
  findings.push({kind:optional?'optional-storage-unsupported':'native-error',message:optional?'An optional command returned UnsupportedOperation for a modified RomFS, following fs.mitm policy. This is not an SD read failure and does not prove a freeze.':'A native operation returned an error. Inspect its operation, file and native result.',operation:highlights.firstError});
 }
 if(pending.length)findings.push({kind:'pending-at-snapshot',message:'These operations were pending at the saved snapshot. Check the later I/O journal before attributing a stall to them.',count:pending.length});
 if(ioJournal.available){
  if(ioJournal.phase==='before call')findings.push({kind:'recorder-call-not-seen-returning',message:'The latest durable journal precedes a recorder I/O call. A stall in that call or a later failure to save progress remain possible.',operation:ioJournal.operation});
  else if(ioJournal.operationId===2&&ioJournal.nativeResult==='0x0')findings.push({kind:'snapshot-flush-returned',message:'The snapshot flush returned successfully at the last saved I/O journal. This distinguishes it from an operation still pending in the earlier snapshot.'});
 }
 if(highlights.slowestCompleted?.durationMs>=500)findings.push({kind:'slow-operation',message:'At least one completed operation took 500 ms or more.',operation:highlights.slowestCompleted});
 if(stats.some(s=>s.pak?.firstIndexRequestCompleted))findings.push({kind:'pak-index-read',message:'The game received at least one read overlapping a mod PAK index. This does not establish engine acceptance of the index or assets.'});
 if(!findings.length)findings.push({kind:'no-error-observed',message:'No native error is recorded in this snapshot. This does not rule out an error after it or inside the game.'});
 return{available:true,highlights,findings,ioJournal,lockState:lockOwnership,format:'NS2TRC01',selectedPage:valid[0].slot,generation:String(valid[0].generation),pages:pages.map(p=>({slot:p.slot,valid:p.valid,generation:String(p.generation)})),checkpointTick:String(b.readBigUInt64LE(24)),tickFrequency:frequency,checkpoints:String(b.readBigUInt64LE(96)),completed:String(b.readBigUInt64LE(56)),errors:String(b.readBigUInt64LE(64)),sourceBytes:String(b.readBigUInt64LE(72)),writeFailures:String(b.readBigUInt64LE(104)),omittedObservations:String(b.readBigUInt64LE(48)),omittedTextEvents:String(BigInt(b.readUInt32LE(116))|(BigInt(b.readUInt32LE(120))<<32n)),pendingAtSavedCheckpoint:pending,fileCounters:stats,recentOperations:recent,originalStorages:storages.map(s=>({object:hex(s.object),program:s.program,...(s.virtualSize!==undefined?{virtualSize:String(s.virtualSize)}:{}),originalFiles:s.originalFiles.map(f=>({name:f.name,size:String(f.size),...(f.offset!==undefined?{offset:hex(f.offset)}:{})}))})),limitations:['Snapshots and I/O journal are saved on observed FS activity; there is no independent watchdog.','Pending at a snapshot does not prove an operation stayed blocked; consult the later journal.','The journal cannot report a physical SD failure or a freeze before its next durable write.','Recent history and counters are bounded; source counters retain up to 64 file IDs.','Source opens include cache hits. PAK index completion describes a read overlap, not engine validation or full index coverage.','This is an FS trace, not a capture of Unreal errors, rendering, or a game backtrace.']};
}
function inspect(file){
 const log=file.endsWith('.trace')?file.replace(/\.trace$/,'.log'):file,trace=log.replace(/\.log$/,'.trace');
 const text=fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
 return{log,trace,...decode(fs.readFileSync(trace),text)};
}
if(require.main===module){try{
 const input=process.argv[2];if(!input)throw Error('Usage: node tools/read-diagnostics.cjs LOG_OR_TRACE_OR_LOGS_DIRECTORY');
 const p=path.resolve(input),files=fs.statSync(p).isDirectory()?fs.readdirSync(p).filter(n=>n.endsWith('.trace')).sort().map(n=>path.join(p,n)):[p];
 console.log(JSON.stringify(files.map(inspect),null,2));
}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={decode,inspect,checksum,progressChecksum};
