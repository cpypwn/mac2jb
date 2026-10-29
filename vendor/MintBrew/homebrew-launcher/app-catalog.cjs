const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {inflateSync}=require('node:zlib');
const run=promisify(execFile);
const ROOT=path.resolve(__dirname,'../apps'),MAX_APPS=32,SLOT_BYTES=131072,ATLAS_BYTES=1024*2048;
const DEFAULT_ORDER=new Map(['stremio-experimental','izdoom','froggy-road','ouncecake','ftpd-sb','cpu-gpu-probe','hello-world'].map((id,index)=>[id,index]));
const order=id=>DEFAULT_ORDER.get(id)??DEFAULT_ORDER.size;
const check=(v,m)=>{if(!v)throw Error(m);};
async function asset(root,name,max){
 check(typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&!name.split(/[\\/]/).includes('..'),'Asset path must stay inside its app');
 const file=await fs.realpath(path.resolve(root,name));check(file.startsWith(root+path.sep),'Asset escapes its app folder');
 const stat=await fs.stat(file);check(stat.isFile()&&stat.size>0&&stat.size<=max,'Invalid asset size: '+name);
 return {file,bytes:await fs.readFile(file)};
}
async function readApp(directory,{validate=true}={}){
 const root=await fs.realpath(directory),manifestAsset=await asset(root,'app.json',16384),m=JSON.parse(manifestAsset.bytes);
 check(m.format==='hblauncher.gpu-app'&&m.abi===1,'Unsupported app format/ABI');
 check(typeof m.id==='string'&&/^[a-z0-9][a-z0-9-]{0,47}$/.test(m.id),'Invalid app id');
 check(typeof m.name==='string'&&m.name.trim().length>0&&m.name.length<=64,'Invalid app name');
 check(typeof m.version==='string'&&m.version.length<=32,'Invalid version');
 check(typeof m.description==='string'&&m.description.length<=160,'Invalid description');
 check(m.transition===undefined||m.transition==='none'||m.transition==='fade','Invalid transition');
 check(m.service===undefined||(m.id==='ouncecake'&&m.service==='ouncecake-v1'),
  'Unsupported host service');
 require('../sdk/host/runtime.cjs').validateManifest(m.sdk);
 const files={},hash=crypto.createHash('sha256');hash.update(manifestAsset.bytes);
 if(m.computeSequence!==undefined){check(m.computeSequence&&Number.isInteger(m.computeSequence.repeat)&&m.computeSequence.repeat>=1&&m.computeSequence.repeat<=512,'Invalid compute sequence repeat');check(typeof m.computeSequence.begin==='string'&&typeof m.computeSequence.after==='string','Invalid compute sequence shaders');}
 const stages=[['vertex',0,m.shaders?.vertex],['fragment',4,m.shaders?.fragment],['compute',5,m.shaders?.compute]];
 if(m.computeSequence)stages.push(['computeBegin',5,m.computeSequence.begin],['computeAfter',5,m.computeSequence.after]);
 for(const [stage,model,name] of stages){
  const item=await asset(root,name,1048576),b=item.bytes;
  check(b.length>=20&&b.length%4===0&&b.readUInt32LE()===0x07230203,'Invalid SPIR-V '+stage);
  let entry=false;for(let i=5;i<b.length/4;){const word=b.readUInt32LE(i*4),count=word>>>16,op=word&65535;check(count>0&&i+count<=b.length/4,'Malformed SPIR-V instruction');if(op===15&&count>=4&&b.readUInt32LE((i+1)*4)===model){const name=b.subarray((i+3)*4,(i+count)*4).toString('utf8').split('\0')[0];if(name==='main')entry=true;}i+=count;}
  check(entry,'Missing '+stage+' main entry point');
  if(validate)await run(require('../scripts/toolchain.cjs').tool('SPIRV_VAL','spirv-val'),['--target-env','vulkan1.0',item.file],{timeout:10000,maxBuffer:65536});
  files[stage]=item;hash.update(stage).update(b);
 }
 files.state=await asset(root,m.initialState,1024);check(files.state.bytes.length===1024,'Initial state must be 1024 bytes');hash.update(files.state.bytes);
 files.data=await asset(root,m.data,7*1024*1024);hash.update(files.data.bytes);
 if(m.memory!==undefined){
  check(m.memory&&Number.isInteger(m.memory.bytes)&&m.memory.bytes>=4096&&m.memory.bytes<=32*1024*1024&&m.memory.bytes%4096===0,'Invalid private GPU memory size');
  check(m.memory.encoding===undefined||m.memory.encoding==='deflate','Unsupported private memory encoding');
  const item=await asset(root,m.memory.initial,32*1024*1024);hash.update(item.bytes);
  const bytes=m.memory.encoding==='deflate'?inflateSync(item.bytes,{maxOutputLength:m.memory.bytes}):item.bytes;
  check(bytes.length<=m.memory.bytes,'Private GPU memory image exceeds allocation');files.memory={...item,bytes,allocationBytes:m.memory.bytes};
 }
 if(m.cpuBridge!==undefined){
  const bridge=m.cpuBridge;
  check(bridge&&typeof bridge==='object'&&!Array.isArray(bridge)&&
    Object.keys(bridge).length===2&&bridge.kind==='counter-v1'&&
    Number.isInteger(bridge.offset)&&bridge.offset>=0&&bridge.offset%8===0&&
    files.memory&&bridge.offset+12<=files.memory.allocationBytes,
    'Invalid CPU counter bridge mailbox');
 }
 files.icon=await asset(root,m.icon,2*1024*1024);hash.update(files.icon.bytes);
 const icon=files.icon.bytes;
 check(icon.length>=33&&icon.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&icon.toString('ascii',12,16)==='IHDR','Icon must be a PNG');
 check(icon.readUInt32BE(16)>0&&icon.readUInt32BE(16)<=4096&&icon.readUInt32BE(20)>0&&icon.readUInt32BE(20)<=4096,'Icon dimensions exceed 4096');
 await run('python3',['-c','from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.verify()',files.icon.file],{timeout:10000,maxBuffer:65536});
 const effects={},effectData={};
 check(m.audio===undefined||(m.audio.sampleRate===48000&&m.audio.channels===2&&m.audio.format==='s16le'),'Unsupported audio format');
 for(const [id,name] of Object.entries(m.audio?.effects||{})){
  check(/^(?:[1-9]|[12][0-9]|3[01])$/.test(id),'Sound event ids must be 1..31');
  const item=await asset(root,name,131072);check(item.bytes.length%4===0,'Invalid stereo PCM frame alignment');effects[id]=item.file;effectData[id]=item.bytes;hash.update(id).update(item.bytes);
 }
 return {id:m.id,name:m.name.trim(),version:m.version,description:m.description.replace(/[\s.]+$/u,''),root,manifest:m,files,effects,effectData,fingerprint:hash.digest('hex')};
}
async function scan(root=ROOT){
 root=path.resolve(root);let entries;try{entries=await fs.readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return {root,apps:[],rejected:[]};throw error;}
 const apps=[],rejected=[],ids=new Set();
 for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
  try{check(apps.length<MAX_APPS,'Catalog limit is 32 apps');const app=await readApp(path.join(root,entry.name));check(!ids.has(app.id),'Duplicate app id');ids.add(app.id);apps.push(app);}
  catch(error){rejected.push({folder:entry.name,error:error.message});}
 }
 apps.sort((a,b)=>order(a.id)-order(b.id)||
  path.basename(a.root).localeCompare(path.basename(b.root)));
 return {root,apps,rejected};
}
function summary(catalog){return {root:catalog.root,apps:catalog.apps.map(a=>({id:a.id,name:a.name,version:a.version,description:a.description,root:a.root,fingerprint:a.fingerprint,effects:a.effects})),rejected:catalog.rejected};}
async function raster(catalog,directory,label='catalog'){
 const input=path.join(directory,label+'.json'),output=path.join(directory,label+'.bin');
 const labels=[];
 for(const [i,a] of catalog.apps.entries()){
  const icon=path.join(directory,label+'-icon-'+i+'.png');await fs.writeFile(icon,a.files.icon.bytes);
  labels.push({name:a.name,description:a.description,icon,transition:a.manifest.transition});
 }
 await fs.writeFile(input,JSON.stringify(labels,null,2));
 await run('python3',[path.join(__dirname,'catalog-assets.py'),input,output],{timeout:15000,maxBuffer:65536});
 const bytes=await fs.readFile(output);check(bytes.length===MAX_APPS*SLOT_BYTES,'Invalid catalog raster');return bytes;
}
module.exports={ROOT,MAX_APPS,SLOT_BYTES,ATLAS_BYTES,asset,readApp,scan,summary,raster};
