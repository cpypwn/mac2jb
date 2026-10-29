const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),files=require('./files.cjs');
async function all(root){const folder=path.join(root,'jobs');await fs.mkdir(folder,{recursive:true});const out=[];for(const name of await fs.readdir(folder))if(/^[a-f0-9-]+\.json$/.test(name)){const value=await files.read(path.join(folder,name));if(value)out.push(value);}return out.sort((a,b)=>a.created.localeCompare(b.created));}
async function create(root,pkg,source,{operation='load'}={}){
 if(!['load','remove'].includes(operation))throw Error('Unknown module operation');
 await fs.mkdir(root,{recursive:true});const lock=path.join(root,'queue.lock'),until=Date.now()+6000;
 for(;;)try{await fs.mkdir(lock);break;}catch(e){if(e.code!=='EEXIST')throw e;const stat=await fs.stat(lock).catch(()=>null);if(stat&&Date.now()-stat.mtimeMs>30000){await fs.rm(lock,{recursive:true,force:true});continue;}if(Date.now()>until)throw Error('Package queue is busy; try again');await new Promise(r=>setTimeout(r,20));}
 try{const current=(await all(root)).find(j=>j.packageId===pkg.id&&['queued','loading','publishing'].includes(j.status));if(current){if((current.operation||'load')!==operation)throw Error('Another operation is already queued for this module');return current;}const row={id:crypto.randomUUID(),packageId:pkg.id,file:pkg.file,name:pkg.name,source,operation,status:'queued',created:new Date().toISOString()};await save(root,row);await files.event(root,'queue',pkg.name+(operation==='remove'?' queued for removal':' queued'),{packageId:pkg.id,source});return row;}finally{await fs.rm(lock,{recursive:true,force:true});}
}
async function save(root,row){await files.write(path.join(root,'jobs',row.id+'.json'),row);}
module.exports={all,create,save};
