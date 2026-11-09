'use strict';
// Restore the stock RO service before releasing the held ns2jb session.
// The resident FS overlay stays installed. Never replay a transition journal.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const check=(v,s)=>{if(!v)throw Error(s);};
const read=p=>fs.readFile(p,'utf8').then(JSON.parse);
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const PROGRAM=0x0400000000000037n;
async function transition(io,helperPid,journal,save) {
 check(/^\d+$/.test(helperPid)&&BigInt(helperPid)>1n,'Invalid helper PID');
 check(!journal.steps?.length,'A prior transition must be inspected, never replayed');
 journal.steps=[];
 async function step(name,action) {
  const row={name,pending:true,started:new Date().toISOString()};journal.steps.push(row);await save();
  const result=await action();row.result=result;row.pending=false;row.finished=new Date().toISOString();await save();return result;
 }
 check(await step('identify-current-helper',()=>io.identify(helperPid))===PROGRAM.toString(),'Current helper identity differs');
 const stockPid=await step('launch-stock-RO-suspended',()=>io.launch());
 check(/^\d+$/.test(stockPid)&&BigInt(stockPid)>1n&&stockPid!==helperPid,'Launch did not return a distinct process');
 journal.stockPid=stockPid;await save();
 check(await step('identify-stock-candidate',()=>io.identify(stockPid))===PROGRAM.toString(),'Candidate identity differs; helper remains running');
 await step('close-private-helper-clients',()=>io.closeHelper());
 await step('terminate-identified-helper',()=>io.terminate(helperPid));
 journal.helperTerminated=true;await save();
 await step('start-stock-RO',()=>io.start(stockPid));
 const health=await step('verify-standard-RO-protocol',()=>io.health());
 check(health?.moduleInfoVerified&&health?.applicationInitializeVerified,'Stock RO did not pass ordinary service checks');
 journal.stockRoProtocolVerified=true;journal.gameLaunchVerified=false;await save();
 return {stockPid,stockRoProtocolVerified:true,gameLaunchVerified:false};
}
async function apply(run,{baseline=false,residentDirectory,contextMagic='NS2LFS01'}={}) {
 run=path.resolve(run);const session=path.basename(run),dir=residentDirectory?path.resolve(residentDirectory):path.join(__dirname,'../../state',session);
 check(path.basename(dir)===session&&['SMODFS01','MKWFS002','NS2LFS01'].includes(contextMagic),'Invalid resident handoff context');
 await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'stock-ro-restoration.json');
 const journal={schema:1,session,hardwareValidated:false,baseline,started:new Date().toISOString(),steps:[]};
 // Exclusive creation deliberately refuses completed and incomplete retries alike.
 await fs.writeFile(file,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
 const save=()=>fs.writeFile(file,JSON.stringify(journal,null,2)+'\n',{mode:0o600});
 let c,healthSession,helperClosed=false,transitionStarted=false;
 try {
  const executionFile=path.join(run,'switch2/ro/current-execution.json'),execution=await read(executionFile);
  const activation=await read(execution.identity);
  check(execution.verified&&execution.session===session&&activation.session===session&&execution.pid===activation.pid&&activation.termination?.result===0,'No current qualified replacement RO');
  const {Client}=require(path.join(run,'switch2/process/client.cjs'));c=await new Client().open();
  const m=c.memory,state=await m.request({command:'root-native-info'});
  check(state.session===session&&state.worker?.joined&&!c.pending,'Worker is not idle');
  check(state.donor?.cleanedUp&&!state.donor.pendingRemoval&&state.donor.files.every(x=>!x.created||x.removed),'Donor cleanup incomplete');
  const capture=state.codeFileSystems?.find(x=>BigInt(x.title)===PROGRAM);
  check(capture&&capture.codeInfo?.isSigned===1,'No captured stock RO CodeFS');
  journal.originalFiles=[];
  for(const name of ['main','main.npdm']) {
   const item=capture.files.find(x=>x.name===name),bytes=await fs.readFile(item.file);
   check(item.captured===item.size&&bytes.length===item.size&&digest(bytes)===item.sha256,'Original RO capture changed');
   check(bytes.toString('ascii',0,4)===(name==='main'?'NSO0':'META'),'Wrong original RO file format');
   check(name!=='main'||item.sha256!==execution.payloadSha256,'Captured RO is the proof helper');
   journal.originalFiles.push({name,bytes:bytes.length,sha256:item.sha256});
  }
  const runtime=require(path.join(run,'switch2/ro/runtime.cjs'));
  journal.loaderHandoff=await runtime.handoff(); // Recheck the actual Loader wait/session fields.
  let resident;try{resident=await read(path.join(dir,'resident-install.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(baseline)check(!resident?.hookMayBeAttached,'Baseline must have no resident hook in this boot');
  else {
   check(resident?.session===session&&resident.verified&&resident.active&&resident.clientSessionClosed&&resident.hookAttached,'No verified same-session resident overlay');
   const h=await c.fsProcess(),at=BigInt(resident.context);
   const result=await c.read(h,8n,at,104);check(!result.result&&!result.unmapResult,'Cannot inspect resident context');
   const b=Buffer.from(result.hex,'hex');
   check(b.toString('ascii',0,8)===contextMagic&&b.readUInt32LE(8)===1&&b.readBigUInt64LE(88)===0n&&b.readBigUInt64LE(96)===0n,'Resident is inactive, failed or busy');
   const hooks=resident.hooks??[resident.hook];check(hooks.length>0&&hooks.every(Boolean),'Resident has no hook records');
   for(const expected of hooks){
    const hook=await c.read(h,8n,BigInt(expected.target),16);
    check(!hook.result&&!hook.unmapResult&&hook.hex===expected.replacementHex,'Resident hook changed');
   }
   journal.residentVerifiedBeforeHandoff=true;
   if(resident.exefsContext){
    const state=await c.read(h,8n,BigInt(resident.exefsContext),112);check(!state.result&&!state.unmapResult,'Cannot inspect ExeFS context');
    const bytes=Buffer.from(state.hex,'hex');check(bytes.readUInt32LE()===1&&bytes.readUInt32LE(4)===0x33465343&&bytes.readBigUInt64LE(96)===0n&&bytes.readBigUInt64LE(104)===0n,'ExeFS reader is inactive, failed or busy');journal.exefsVerifiedBeforeHandoff=true;
   }
  }
  const pmShell=state.services.find(x=>x.name==='pm:shell')?.handle,pmMonitor=state.services.find(x=>x.name==='pm:dmnt')?.handle;
  const sm=state.services.find(x=>x.name==='pm:shell')?.sm;check(pmShell&&pmMonitor&&sm,'Missing retained PM/SM clients');
  await save();
  const pm=async(handle,id,pid)=>{
   const input=Buffer.alloc(pid===undefined?0:8);if(pid!==undefined)input.writeBigUInt64LE(BigInt(pid));
   const r=await m.request({command:'root-native-ipc',handle,id,hex:input.toString('hex')});
   check(!r.result,'PM operation rejected: '+id+' result='+r.result);return Buffer.from(r.hex,'hex');
  };
  const io={
   identify:async pid=>(await pm(pmMonitor,7,pid)).readBigUInt64LE().toString(),
   launch:async()=>{
    const r=await c.worker({kind:'pm-launch',handle:pmShell,title:'0x0400000000000037',storage:3,flags:0x10},30000);
    check(!r.transport&&!r.result,'Stock RO launch failed');return Buffer.from(r.data,'hex').readBigUInt64LE().toString();
   },
   closeHelper:async()=>{await c.close();helperClosed=true;return {privateClientsClosed:true};},
   terminate:async pid=>{
    await pm(pmShell,1,pid);
    // Invalidate private-protocol discovery as soon as its server is gone.
    await fs.writeFile(executionFile,JSON.stringify({...execution,verified:false,retiredForStockRo:true,restoration:file},null,2)+'\n',{mode:0o600});
    return {terminated:true};
   },
   start:async pid=>{await pm(pmMonitor,1,pid);return {started:true};},
   health:async()=>{
    const {qualify}=require('./stock-ro-health.cjs');
    return qualify({run,memory:m,client:c,sm,pmShell,record:async op=>{
     (journal.standardProtocolChecks ||= []).push(op);await save();
    }});
   }
  };
  transitionStarted=true;const result=await transition(io,execution.pid,journal,save);
  // Prevent subsequent research tools from sending private probes to stock RO.
  await fs.writeFile(executionFile,JSON.stringify({...execution,verified:false,retiredForStockRo:true,stockPid:result.stockPid,restoration:file},null,2)+'\n',{mode:0o600});
  journal.hardwareValidated=true;journal.finished=new Date().toISOString();await save();return {file,...result};
 }catch(e){journal.error=e.stack;journal.requiresInspectionOrReboot=true;await save();throw e;}
 finally {if(c&&!c.pending&&!helperClosed&&!transitionStarted)await c.close();}
}
module.exports={transition,apply};
