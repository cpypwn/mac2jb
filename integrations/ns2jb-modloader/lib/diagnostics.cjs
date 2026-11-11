'use strict';
const {isUncertain}=require('./game-files/uncertain.cjs');
const path=require('node:path');
const {check}=require('./common.cjs'),{attachGame,createGameFiles}=require('./game-files/mount-api.cjs'),{pathRequest}=require('./game-files/protocol.cjs');
const VERSION='0.3.4';
function logPath(session,date=new Date()){
 check(/^switch2-[A-Za-z0-9]+$/.test(session),'Invalid report session');return'/ns2jb-modloader/logs/'+date.toISOString().replace(/[-:]/g,'').slice(0,15)+'Z-'+session+'.log';
}
function report({session,sdPath,collection,captures=[],plan,error,status='prepared',trace=false}){
 const parts=[],viewOffsets={},sourceOffsets={},moduleOffsets={},MAX=1024*1024;let bytes=0,omitted=0,budget=MAX/3;
 function line(value,essential=false){const text=value+'\n',n=Buffer.byteLength(text);if(bytes+n>budget&&!essential){omitted++;return false;}parts.push(text);bytes+=n;return true;}
 function patchDetail(patch){return patch.inputFormat==='pchtxt'?' compiled=IPSwitch->IPS32 BuildID='+patch.buildId+' records='+patch.patchRecords+' patchedBytes='+patch.patchedBytes:'';}
 line('ns2jb-modloader '+VERSION);line('Session: '+session);line('Status: '+status);const prefix='Activation complete: ';line(prefix+'0');const readyOffset=bytes-2;
 if(plan?.nativeProfile)line('FS profile: '+JSON.stringify(plan.nativeProfile));
 if(plan?.nativeRuntime)line('Native components SHA-256: '+plan.nativeRuntime);
 if(error)line('Error: '+String(error.stack||error));
 if(error?.fsCompatibility)line('FS compatibility: '+JSON.stringify(error.fsCompatibility));
 line('');line('Prepared content:');
 for(const game of collection?.games||[]){
  line('Title ID: '+game.titleId);const inventory=captures.find(c=>c.inventory?.titleId===game.titleId)?.inventory;
  if(inventory){
   line('Selection: '+JSON.stringify(inventory.selection));
   for(const section of ['romfs','exefs'])if(inventory[section]){const original=inventory[section];line(section+' source: '+JSON.stringify(original.source));if(section==='romfs')line('Original RomFS bytes: '+original.size);else for(const file of original.files)line('NSO: '+file.name+' size='+file.size+' Build ID='+(file.buildId||'none'));}
  }
 }
 for(const group of plan?.namespaces||[])line('CodeFS owner: '+group.titleId+' Program ID='+BigInt(group.owner.programId).toString(16).padStart(16,'0')+' source='+JSON.stringify(group.source));
 for(const game of collection?.games||[]){
  for(const section of ['romfs','exefs'])for(const file of game[section]||[])if(file.type==='file')line(game.titleId+' '+section+' mod: '+JSON.stringify(file.path)+' size='+file.size+' source='+JSON.stringify(file.sdPath||file.file));
  for(const patch of game.patches||[])line('Title-scoped IPS input: '+game.titleId+' '+JSON.stringify(patch.sdPath||patch.file)+' size='+patch.size+patchDetail(patch));
  for(const name of ['romfsImage','exefsImage'])if(game[name])line(name+': '+JSON.stringify(game[name].sdPath||game[name].file)+' size='+game[name].size);
 }
 for(const reference of [...(collection?.patchReferences||[]),...(collection?.games||[]).flatMap(game=>game.patchReferences||[])])line('IPSwitch reference: '+JSON.stringify(reference.sdPath||reference.file)+'; using binary '+JSON.stringify(reference.binary));
 if(plan){
  if(plan.lazy){
   for(const patch of plan.lazyPatches)line('IPS input: '+JSON.stringify(patch.sdPath)+' size='+patch.size+patchDetail(patch));
   if(omitted)line('Additional mod entries: '+omitted+' (report size limit)');
   line('');line('Runtime events: operation | Program ID | size/offset | native result | source path');
   line('Source samples use FNV-1a 64 over the first min(read size, 64) bytes at the recorded offset.');
   line('Game content is prepared at mount time. No game data is cached.');
   if(trace){
    let fileId=0;for(const game of plan.lazyGames)for(const file of game.files)line('File identity: id='+(++fileId)+' program='+game.titleId+' kind='+file.kind+' size='+(file.size||0)+' name='+JSON.stringify(file.name)+' source='+JSON.stringify(file.sdPath||''));
    for(const file of plan.lazyPatches)line('File identity: id='+(++fileId)+' program=global kind='+file.kind+' size='+(file.size||0)+' name='+JSON.stringify(file.name)+' source='+JSON.stringify(file.sdPath||''));
    line('Diagnostic trace: '+sdPath.replace(/\.log$/,'.trace'));
    line('Trace snapshots are activity-driven, not a watchdog. Pending means pending at the saved checkpoint; calls may have completed later. A total FS failure can prevent saving.');
    line('Trace I/O journal records entry/return of text and trace write/flush. It can be newer than the normal snapshot. Original package offsets identify reads where known.');
    line('Trace keeps recent operation entry/exit records, observed file counters and PAK metadata. It does not capture internal engine errors. Dropped records and invalid/torn snapshot pages are reported by tools/read-diagnostics.cjs.');
   }
   const buffer=Buffer.from(parts.join(''));return{sdPath,...(trace?{tracePath:sdPath.replace(/\.log$/,'.trace')}:{}),buffer,viewOffsets,sourceOffsets,moduleOffsets,unmatchedOffset:0,readyOffset,errorOffset:0};
  }
  for(const row of plan.deferredGames||[])line('Saved preparation: '+row.titleId+' (game unavailable during activation)');
  for(const row of plan.pendingGames||[])line('Pending: '+row.titleId+' '+row.reason);
  for(const entry of plan.exefs)for(const patch of entry.patches||[])line('Applied IPS: '+JSON.stringify(patch)+' -> '+entry.titleId+'/'+entry.name);
  for(const patch of plan.ignoredPatches||[])line('Unapplied IPS: '+JSON.stringify(patch)+' (no matching Build ID)');
  budget=MAX-4096;
  if(omitted)line('Additional metadata entries: '+omitted+' (summarized to keep this report bounded)');
  line('');line('Runtime observations: read seen (0/1) | first bytes | error seen (0/1) | first native error (hex)');
  const values='0'.padStart(20)+' '+'0'.padStart(20)+' '+'0'.padStart(20)+' 00000000';
  function counters(label){if(bytes+Buffer.byteLength(label)+values.length+2>budget){omitted++;return 0;}line(label);const at=bytes;line(values);return at;}
  for(const view of plan.views)viewOffsets[view.titleId]=counters('RomFS '+view.titleId);
  for(const entry of plan.exefs)if(entry.modified)moduleOffsets[entry.titleId+'/'+entry.name]=counters('ExeFS '+entry.titleId+'/'+entry.name);
  for(const source of plan.sources)sourceOffsets[source.sdPath]=counters('Source '+JSON.stringify(source.sdPath));
  if(omitted)line('Entries omitted from this bounded report: '+omitted,true);
  budget=MAX;line('');line('Unmatched RomFS: seen (0/1) | first size | identity mismatch (0/1) | first rejection stage (hex: 1=header, 2=entry, 3=data)');const unmatchedOffset=bytes;line(values,true);
  line('First source error (native result and SD path):');const errorOffset=bytes;line('00000000 '+' '.repeat(0x300),true);
  line('');line('Game counters start after installer verification. Activation complete only confirms installation.');
  const buffer=Buffer.from(parts.join(''));check(buffer.length<=MAX,'Report budget exceeded');return{sdPath,buffer,viewOffsets,sourceOffsets,moduleOffsets,unmatchedOffset,readyOffset,errorOffset};
 }
 const buffer=Buffer.from(parts.join(''));return{sdPath,buffer,viewOffsets,sourceOffsets,unmatchedOffset:0,readyOffset,errorOffset:0};
}
async function writeReport(run,report){
 check(/^\/ns2jb-modloader\/logs\/\d{8}T\d{6}Z-switch2-[A-Za-z0-9]+\.log$/.test(report.sdPath),'Invalid report destination');
 const a=await attachGame(run),files=createGameFiles(a),{s,domain,filesystem}=a;let sd,file,uncertain=false;
 async function operation(id,name,data=Buffer.alloc(0)){
  check(name==='/ns2jb-modloader'||name==='/ns2jb-modloader/logs'||/^\/ns2jb-modloader\/logs\/\d{8}T\d{6}Z-switch2-[A-Za-z0-9]+\.(?:log|trace)$/.test(name),'Invalid report path operation');const b=Buffer.alloc(0x304);b.write(name);await s.write(s.base+0x2000,b);return domain.send(s,'Report SD path '+id,sd,pathRequest(id,data,s.base+0x2000));
 }
 try{
  sd=domain.oneHandle(await s.ipc('Open SD reports',a.root,18));
  for(const name of ['/ns2jb-modloader','/ns2jb-modloader/logs']){const st=await operation(7,name);if(st.canonicalResult===0x202)check(!(await operation(2,name)).result,'Cannot create reports directory');else check(!st.result&&st.data.readUInt32LE()===0,'Report path is not a directory');}
  const logs=(await files.list({handle:sd},'/ns2jb-modloader/logs',()=>false)).filter(row=>row.type==='file'&&/^\d{8}T\d{6}Z-switch2-[A-Za-z0-9]+\.log$/.test(row.name)&&row.name!==path.posix.basename(report.sdPath)).sort((a,b)=>a.name.localeCompare(b.name));
  for(const row of logs.slice(0,Math.max(0,logs.length-2))){
   check(!(await operation(1,'/ns2jb-modloader/logs/'+row.name)).result,'Cannot rotate old SD report');
   const trace='/ns2jb-modloader/logs/'+row.name.replace(/\.log$/,'.trace'),found=await operation(7,trace);
   if(!found.result)check(!(await operation(1,trace)).result,'Cannot rotate old trace');
   else check(found.canonicalResult===0x202,'Cannot inspect old trace');
  }
  const st=await operation(7,report.sdPath);
  if(st.canonicalResult===0x202){const create=Buffer.alloc(16);create.writeBigUInt64LE(BigInt(report.buffer.length),8);check(!(await operation(0,report.sdPath,create)).result,'Cannot create SD report');}else check(!st.result&&st.data.readUInt32LE()===1,'Report destination is not a file');
  const mode=Buffer.alloc(4);mode.writeUInt32LE(3);const opened=await operation(8,report.sdPath,mode);check(!opened.result,'Cannot open SD report');file=domain.oneHandle(opened);
  const size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(report.buffer.length));check(!(await s.ipc('Resize SD report',file,3,size)).result,'Cannot size SD report');
  for(let at=0;at<report.buffer.length;at+=0x40000){const b=report.buffer.subarray(at,at+0x40000);await s.write(s.base+0x6000,b);const input=Buffer.alloc(24);input.writeBigUInt64LE(BigInt(at),8);input.writeBigUInt64LE(BigInt(b.length),16);const result=await s.ipc('Write SD report',file,1,input,{send:[{address:s.base+0x6000,size:b.length,mode:1}]});check(!result.result,'Cannot write SD report: 0x'+result.result.toString(16));}
  check(!(await s.ipc('Flush SD report',file,2)).result,'Cannot flush SD report');await s.close(file);file=null;
  if(report.tracePath){
   check(report.tracePath===report.sdPath.replace(/\.log$/,'.trace'),'Invalid trace destination');
   const found=await operation(7,report.tracePath);
   if(found.canonicalResult===0x202){const create=Buffer.alloc(16);create.writeBigUInt64LE(40960n,8);check(!(await operation(0,report.tracePath,create)).result,'Cannot create trace');}
   else check(!found.result&&found.data.readUInt32LE()===1,'Trace destination is not a file');
   const opened=await operation(8,report.tracePath,mode);check(!opened.result,'Cannot open trace');file=domain.oneHandle(opened);
   const traceSize=Buffer.alloc(8);traceSize.writeBigUInt64LE(40960n);check(!(await s.ipc('Size bounded trace',file,3,traceSize)).result,'Cannot size trace');
   await s.write(s.base+0x6000,Buffer.alloc(40960));const input=Buffer.alloc(24);input.writeBigUInt64LE(40960n,16);
   check(!(await s.ipc('Initialize bounded trace',file,1,input,{send:[{address:s.base+0x6000,size:40960,mode:1}]})).result,'Cannot initialize trace');
   check(!(await s.ipc('Flush bounded trace',file,2)).result,'Cannot flush trace');await s.close(file);file=null;
  }
  return{sdPath:report.sdPath,bytes:report.buffer.length,tracePath:report.tracePath};
 }catch(error){uncertain=isUncertain(error);throw error;}
 finally{if(!uncertain){if(file)await s.close(file);await a.close();}}
}
module.exports={logPath,report,writeReport,VERSION};
