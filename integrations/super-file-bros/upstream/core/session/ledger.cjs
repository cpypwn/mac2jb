const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const valid=/^[a-f0-9-]{36}$/;
const redact=value=>String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/Orange\s*Pi/gi,'Input bridge').replace(/V=START\([^)]*\)/g,'V=START(…)').replace(/(https?:\/\/[^\s#]+\/#)[a-f0-9]{24,64}/gi,'$1[private]').replace(/(Bearer\s+)[^\s"']+/gi,'$1[private]').replace(/((?:token|secret|password|api[_-]?key|key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,'$1[private]');
async function readJson(file,fallback=null){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function saveJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);}
function createLedger(root){
 const folder=path.join(root,'data/state/attempts');
 const location=id=>{if(!valid.test(id))throw Error('Invalid attempt identifier');return path.join(folder,id);};
 async function append(id,type,message,details={}){const dir=location(id);await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.appendFile(path.join(dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...details,type,message:redact(message).slice(0,1600)})+'\n',{mode:0o600});}
 async function events(id,limit){try{return (await fs.readFile(path.join(location(id),'events.jsonl'),'utf8')).split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).sort((a,b)=>a.at.localeCompare(b.at)).slice(limit ? -limit : 0);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 const recent=id=>events(id,250),all=id=>events(id);
 async function listFailures(){await fs.mkdir(folder,{recursive:true});const out=[];for(const name of await fs.readdir(folder)){if(!valid.test(name))continue;const row=await readJson(path.join(folder,name,'attempt.json'));if(row&&['failed','cancelled'].includes(row.status))out.push(row);}return out.sort((a,b)=>b.created.localeCompare(a.created));}
 async function removeFailure(id,activeId){if(id===activeId)throw Error('An active attempt cannot be deleted');const dir=location(id),row=await readJson(path.join(dir,'attempt.json'));if(!row||!['failed','cancelled'].includes(row.status))throw Error('Only failed attempt logs can be deleted');if(row.runDirectory){const run=path.resolve(row.runDirectory);if(path.dirname(run)!==path.join(root,'data/sessions')||!/^launcher-[A-Za-z0-9]+$/.test(path.basename(run)))throw Error('Invalid run log directory');await fs.rm(run,{recursive:true,force:true});}await fs.rm(dir,{recursive:true,force:true});}
 return {append,recent,all,listFailures,removeFailure,read:id=>readJson(path.join(location(id),'attempt.json')),write:row=>saveJson(path.join(location(row.id),'attempt.json'),row),session:id=>path.join(location(id),'session')};
}
module.exports={createLedger,readJson,saveJson,redact};
