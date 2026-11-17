'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const {check}=require('./common.cjs');
function status(port){
 return new Promise((resolve,reject)=>{
  const request=http.request({host:'127.0.0.1',port,path:'/',method:'POST',headers:{'content-type':'application/json'}},response=>{
   let input='';response.setEncoding('utf8');response.on('data',part=>{input+=part;if(input.length>65536)request.destroy(Error('Oversized RPC status reply'));});response.on('error',reject);
   response.on('end',()=>{try{const value=JSON.parse(input);check(response.statusCode===200&&value.ready,'RPC is not ready');resolve(value);}catch(e){reject(e);}});
  });
  request.setTimeout(2000,()=>request.destroy(Error('RPC status unavailable')));request.on('error',reject);request.end('{"command":"status"}');
 });
}
function endpointInfo(socketPath){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(socketPath);let input='';socket.setEncoding('utf8');
  socket.setTimeout(2000,()=>socket.destroy(Error('FS session status unavailable')));socket.on('error',reject);
  socket.on('connect',()=>socket.write('{"command":"info"}\n'));
  socket.on('data',part=>{input+=part;if(input.length>65536)socket.destroy(Error('Oversized FS status reply'));});
  socket.on('end',()=>{try{resolve(JSON.parse(input));}catch(error){reject(error);}});
 });
}
async function liveSession(run,connection){
 const reply=await status(connection.port),session=reply.session??reply.addresses?.session;
 if(session!==undefined){check(session===path.basename(run),'Live RPC belongs to another session');return;}
 // Older hosts expose only ready/call count over HTTP. A cached local status
 // query identifies the retained endpoint without any native memory operation.
 // This prevents a stale run whose HTTP port was reused from being selected.
 const current=JSON.parse(await fs.readFile(path.join(run,'switch2/current-acquisition.json'),'utf8'));
 check(typeof current.socketPath==='string'&&current.socketPath.length,'No identifiable live FS endpoint');
 const info=await endpointInfo(current.socketPath);
 check(info.ready&&info.session===path.basename(run),'Live FS endpoint belongs to another session');
}
// ps displays argv as text, including unquoted spaces inside paths. Derive
// possible absolute script paths and qualify each run below; do not assume a
// Node installation path, executable name, flag order or shell quoting style.
function processRunDirectories(output){
 const runs=new Set();
 for(const line of output.split(/\r?\n/))for(const script of line.matchAll(/\/switch2\/pipeline\.cjs(?=$|[\s"'])/g)){
  const prefix=line.slice(0,script.index+script[0].length);
  for(const start of prefix.matchAll(/(?:^|[\s"'])(\/)/g)){
   const file=prefix.slice(start.index+start[0].length-1);
   if(path.isAbsolute(file))runs.add(path.dirname(path.dirname(file)));
  }
 }
 return runs;
}
async function findSession(verify,{proc='/proc',roots=[process.cwd(),path.dirname(process.cwd()),path.resolve(__dirname,'..'),path.resolve(__dirname,'../..')]}={}){
 const candidates=new Set();
 if(process.platform==='darwin'){
  try{
   // Both wide flags matter on BSD ps: do not truncate a long run directory.
   const {stdout}=await execFileAsync('ps',['-axww','-o','command='],{encoding:'utf8',timeout:2000,maxBuffer:4*1024*1024});
   for(const run of processRunDirectories(stdout))candidates.add(run);
  }catch{/* Process enumeration is optional; nearby runs and --run-dir remain available. */}
 }else{
 let processes=[];
 try{processes=await fs.readdir(proc);}catch(error){if(!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))throw error;}
 for(const pid of processes){
  if(!/^\d+$/.test(pid))continue;
  try{
   const args=(await fs.readFile(path.join(proc,pid,'cmdline'),'utf8')).split('\0');
   for(const argument of args)if(path.isAbsolute(argument)&&path.basename(argument)==='pipeline.cjs'&&path.basename(path.dirname(argument))==='switch2')candidates.add(path.dirname(path.dirname(argument)));
  }catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))throw error;}
 }
 }
 // Nearby run folders work with Windows hosts and providers that do not expose
 // a Linux pipeline process. Each candidate must still pass the same proof and
 // live RPC checks; no session is selected merely because its files exist.
 const folders=new Set(roots.map(root=>path.basename(root)==='runs'?path.resolve(root):path.resolve(root,'runs')));
 for(const folder of folders){
  let entries=[];
  try{entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){if(!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))throw error;}
  for(const entry of entries)if((entry.isDirectory()||entry.isSymbolicLink())&&/^switch2-[A-Za-z0-9]+$/.test(entry.name))candidates.add(path.join(folder,entry.name));
 }
 const ready=[],seen=new Set();
 for(const candidate of candidates)try{
  const run=await fs.realpath(candidate);if(seen.has(run))continue;seen.add(run);
  verify(run);const connection=JSON.parse(await fs.readFile(path.join(run,'connection.json'),'utf8'));
  check(connection.addresses?.session===path.basename(run)&&Number.isInteger(connection.port)&&connection.port>0&&connection.port<65536,'Session identity differs');
  await liveSession(run,connection);ready.push(run);
 }catch{/* Ignore ended or not-yet-qualified sessions. */}
 check(ready.length,'No active FS 4/4 RPC session found. Keep your ns2jb host running, or specify --run-dir PATH.');
 check(ready.length===1,'More than one active session found. Select one with --run-dir PATH:\n'+ready.join('\n'));
 return ready[0];
}
module.exports={findSession,status,processRunDirectories};
