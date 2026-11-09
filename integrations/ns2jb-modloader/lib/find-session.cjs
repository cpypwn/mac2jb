'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
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
async function findSession(verify,{proc='/proc'}={}){
 const candidates=new Set();
 for(const pid of await fs.readdir(proc)){
  if(!/^\d+$/.test(pid))continue;
  try{
   const args=(await fs.readFile(path.join(proc,pid,'cmdline'),'utf8')).split('\0');
   for(const argument of args)if(path.isAbsolute(argument)&&argument.endsWith('/switch2/pipeline.cjs'))candidates.add(path.dirname(path.dirname(argument)));
  }catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))throw error;}
 }
 const ready=[];
 for(const run of candidates)try{
  verify(run);const connection=JSON.parse(await fs.readFile(path.join(run,'connection.json'),'utf8'));
  check(connection.addresses?.session===path.basename(run)&&Number.isInteger(connection.port)&&connection.port>0&&connection.port<65536,'Session identity differs');
  await status(connection.port);ready.push(run);
 }catch{/* Ignore ended or not-yet-qualified sessions. */}
 check(ready.length,'No active FS 4/4 RPC session found. Keep your ns2jb host running, or specify --run-dir PATH.');
 check(ready.length===1,'More than one active session found. Select one with --run-dir PATH:\n'+ready.join('\n'));
 return ready[0];
}
module.exports={findSession,status};
