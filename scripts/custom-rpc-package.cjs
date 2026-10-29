#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');

const manifestName='mac2jb-rpc-app.json';
const ouncecakeFiles=[
  'engine/protocol.cjs','engine/session.cjs','engine/content.cjs',
  'engine/fs-context.cjs','engine/program.cjs','engine/mounts.cjs',
  'engine/ftp.cjs','engine/oz-code/native.bin'
];
const check=(value,message)=>{if(!value)throw Error(message);};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fileName=name=>typeof name==='string'&&name.length>0&&name.length<=256&&
  !path.isAbsolute(name)&&!/[\\\x00-\x1f\x7f]/.test(name)&&
  name.split('/').every(part=>part&&part!=='.'&&part!=='..');
function validateManifest(manifest){
  check(manifest&&typeof manifest==='object'&&!Array.isArray(manifest)&&
    manifest.format==='mac2jb.held-rpc-app'&&manifest.version===1&&
    ['ouncecake','script'].includes(manifest.adapter)&&
    typeof manifest.name==='string'&&manifest.name.length>0&&manifest.name.length<=80&&
    !/[\x00-\x1f\x7f]/.test(manifest.name),'Unsupported custom RPC app package.');
  check(manifest.files&&typeof manifest.files==='object'&&!Array.isArray(manifest.files),
    'Custom RPC app has no file inventory.');
  const entries=Object.entries(manifest.files),seen=new Set();
  check(entries.length>0&&entries.length<=512,'Custom RPC app file inventory is out of range.');
  for(const [name,hash] of entries){
    check(fileName(name)&&name!==manifestName&&/^[a-f0-9]{64}$/.test(hash)&&
      !seen.has(name.toLowerCase()),'Custom RPC app has an unsafe file path or digest.');
    seen.add(name.toLowerCase());
  }
  if(manifest.adapter==='ouncecake'){
    check(ouncecakeFiles.every(name=>Object.hasOwn(manifest.files,name)),
      'OunceCake compatible package is missing a runtime file.');
    check(manifest.nativeImage===undefined||manifest.nativeImage==='engine/oz-code/native.bin',
      'OunceCake native image must use engine/oz-code/native.bin.');
  }else{
    check(fileName(manifest.entry)&&manifest.entry.endsWith('.cjs')&&
      Object.hasOwn(manifest.files,manifest.entry),
      'Custom RPC script package needs an inventoried .cjs entry.');
  }
  return manifest;
}
async function readManifest(folder){
  const file=path.join(folder,manifestName),info=await fs.lstat(file);
  check(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=65536,
    'Invalid custom RPC app manifest.');
  return validateManifest(JSON.parse(await fs.readFile(file,'utf8')));
}
async function autoOunceCakeManifest(folder){
  for(const name of ouncecakeFiles){
    const file=path.join(folder,name),info=await fs.lstat(file);
    check(info.isFile()&&!info.isSymbolicLink()&&info.size>0,
      'Choose a built OunceCake fork with its engine modules and native.bin.');
  }
  let name='OunceCake fork',version='local';
  try{
    const info=await fs.lstat(path.join(folder,'package.json'));
    if(info.isFile()&&!info.isSymbolicLink()&&info.size<=65536){
      const pkg=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));
      if(typeof pkg.name==='string'&&pkg.name.length<=80&&!/[\x00-\x1f\x7f]/.test(pkg.name))name=pkg.name;
      if(typeof pkg.version==='string'&&pkg.version.length<=32)version=pkg.version;
    }
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const files={};
  async function inventory(relative){
    const directory=path.join(folder,relative),info=await fs.lstat(directory);
    check(info.isDirectory()&&!info.isSymbolicLink()&&await fs.realpath(directory)===directory,
      'OunceCake fork contains an unsafe engine directory.');
    for(const item of await fs.readdir(directory,{withFileTypes:true})){
      const name=path.posix.join(relative,item.name),file=path.join(folder,name);
      check(fileName(name),'OunceCake fork contains an unsafe file path.');
      if(item.isDirectory())await inventory(name);
      else if(item.isFile()&&/\.(?:cjs|json|bin)$/.test(item.name)&&name!=='engine/build-ftp.cjs'){
        check(Object.keys(files).length<512,'OunceCake fork has too many runtime files.');
        const fileInfo=await fs.lstat(file);
        check(fileInfo.size>0&&fileInfo.size<=32*1024*1024&&await fs.realpath(file)===file,
          'OunceCake fork contains an invalid runtime file: '+name);
        files[name]=digest(await fs.readFile(file));
      }else check(item.isFile(),'OunceCake fork contains a symlink or special file: '+name);
    }
  }
  await inventory('engine');
  return validateManifest({format:'mac2jb.held-rpc-app',version:1,adapter:'ouncecake',name,
    appVersion:version,files});
}
async function sourceManifest(folder){
  const file=path.join(folder,manifestName);
  try{await fs.lstat(file);return readManifest(folder);}
  catch(error){if(error.code!=='ENOENT')throw error;return autoOunceCakeManifest(folder);}
}
async function verifyFiles(folder,manifest,{syntax=true}={}){
  let total=0;
  const run=promisify(execFile);
  for(const [name,expected] of Object.entries(manifest.files)){
    const file=path.join(folder,name),info=await fs.lstat(file);
    check(info.isFile()&&!info.isSymbolicLink()&&await fs.realpath(file)===file&&
      info.size>0&&info.size<=32*1024*1024,'Invalid custom RPC app file: '+name);
    total+=info.size;check(total<=128*1024*1024,'Custom RPC app exceeds 128 MiB.');
    const bytes=await fs.readFile(file);
    check(digest(bytes)===expected,'Custom RPC app changed: '+name);
    if(name.endsWith('.cjs')){
      if(syntax)await run(process.execPath,['--check',file],{timeout:10000,maxBuffer:65536});
      for(const [,relative] of bytes.toString('utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)){
        const imported=path.posix.normalize(path.posix.join(path.posix.dirname(name),relative));
        check(fileName(imported)&&Object.hasOwn(manifest.files,imported),
          name+' requires missing '+imported);
      }
    }
  }
  if(manifest.adapter==='ouncecake'){
    const image=await fs.readFile(path.join(folder,'engine/oz-code/native.bin'));
    check(image.length<=0x10000,'OunceCake native image exceeds its loader limit.');
  }
  return {files:Object.keys(manifest.files).length,bytes:total,fingerprint:digest(Buffer.from(JSON.stringify(manifest)))};
}
async function verifyPackage(folder){
  const source=await fs.realpath(folder),manifest=await readManifest(source);
  const proof=await verifyFiles(source,manifest);
  return {folder:source,manifest,...proof};
}
async function preflight(root,folder){
  check(typeof folder==='string'&&path.isAbsolute(folder)&&folder.length<=4096&&
    !/[\x00\r\n]/.test(folder),'Choose a local built RPC homebrew folder.');
  const requested=path.resolve(folder),info=await fs.lstat(requested);
  check(info.isDirectory()&&!info.isSymbolicLink(),'Choose a real RPC app folder, not a link.');
  const source=await fs.realpath(requested),manifest=await sourceManifest(source);
  const parent=path.join(root,'runs');await fs.mkdir(parent,{recursive:true,mode:0o700});
  const parentInfo=await fs.lstat(parent);
  check(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink()&&parentInfo.uid===process.getuid()&&
    (parentInfo.mode&0o077)===0,'Custom RPC staging requires a private owned runs directory.');
  const directory=await fs.mkdtemp(path.join(await fs.realpath(parent),'custom-rpc-preflight-'));
  const packageFolder=path.join(directory,'package');
  try{
    await fs.mkdir(packageFolder,{mode:0o700});
    for(const [name,expected] of Object.entries(manifest.files)){
      const input=path.join(source,name),inputInfo=await fs.lstat(input);
      check(inputInfo.isFile()&&!inputInfo.isSymbolicLink()&&await fs.realpath(input)===input&&
        inputInfo.size>0&&inputInfo.size<=32*1024*1024,'Invalid custom RPC app file: '+name);
      const bytes=await fs.readFile(input);check(digest(bytes)===expected,'Custom RPC app changed: '+name);
      const output=path.join(packageFolder,name);
      await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
      await fs.writeFile(output,bytes,{flag:'wx',mode:0o600});
    }
    await fs.writeFile(path.join(packageFolder,manifestName),JSON.stringify(manifest,null,2)+'\n',
      {flag:'wx',mode:0o600});
    const proof=await verifyPackage(packageFolder);
    return {directory,kind:'rpc-app',adapter:manifest.adapter,packageFolder,
      app:{name:manifest.name,version:manifest.appVersion||'local',fingerprint:proof.fingerprint,
        adapter:manifest.adapter,files:proof.files},
      cleanup:()=>fs.rm(directory,{recursive:true,force:true})};
  }catch(error){await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});throw error;}
}

async function runOunceCake(run,packageInfo,options={}){
  const {folder,manifest,files,fingerprint}=packageInfo;
  const image=await fs.readFile(path.join(folder,'engine/oz-code/native.bin'));
  const modules=Object.fromEntries(['session','content','mounts','ftp'].map(name=>
    [name,require(path.join(folder,'engine',name+'.cjs'))]));
  const snapshot={vendor:folder,image,ready:true,application:manifest.name,
    version:manifest.appVersion||'local',commit:null,files,nativeImageSha256:digest(image),
    customPackageFingerprint:fingerprint};
  const ouncecakeMain=options.ouncecakeMain||require('./gui-ouncecake.cjs').main;
  return ouncecakeMain([run],{...options,verifySnapshot:async()=>snapshot,modules});
}

function lines(stream,callback){
  let pending='';
  stream.on('data',bytes=>{
    pending+=bytes.toString();
    let at;while((at=pending.search(/[\r\n]/))>=0){
      const line=pending.slice(0,at);pending=pending.slice(at+1);if(line)callback(line);
    }
    if(pending.length>8192){callback(pending.slice(0,8192));pending='';}
  });
  stream.on('end',()=>{if(pending)callback(pending);});
}
async function runScript(run,packageInfo,options={}){
  const root=options.root||path.resolve(__dirname,'..');
  const emit=options.emit||((type,fields={})=>process.stdout.write('MAC2JB_HOMEBREW '+
    JSON.stringify({type,...fields})+'\n'));
  const selected=await require('./gui-homebrew.cjs').validateRun(root,run,
    options.verifySession||require('./gui-dump.cjs').verifiedSession);
  const request=options.request||require(path.join(root,'vendor/ns2jb/rpc.cjs')).request;
  check((await request(selected.directory,{command:'status'}))?.ready===true,
    'The held RPC session is no longer ready.');
  const parent=path.join(root,'runs');await fs.mkdir(parent,{recursive:true,mode:0o700});
  const directory=await fs.mkdtemp(path.join(await fs.realpath(parent),'custom-rpc-'));
  const markerFile=path.join(selected.directory,'.mac2jb-hblauncher-attempt.json');
  await fs.writeFile(markerFile,JSON.stringify({application:'custom-homebrew',
    adapter:'script',fingerprint:packageInfo.fingerprint,started:new Date().toISOString()}),
  {flag:'wx',mode:0o600});
  const entry=path.join(packageInfo.folder,packageInfo.manifest.entry);
  let child,failed,stopped=false,cleanupVerified=false;
  const report={application:packageInfo.manifest.name,adapter:'script',
    packageFingerprint:packageInfo.fingerprint,sourceSession:selected.proof.session,
    started:new Date().toISOString(),status:'preparing'};
  const reportFile=path.join(directory,'custom-rpc-session.json');
  const save=()=>fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  const stop=()=>child?.kill('SIGTERM');
  try{
    await save();emit('started',{path:directory,message:'Opening '+packageInfo.manifest.name+' through held RPC.'});
    child=(options.spawn||spawn)(process.execPath,[entry,selected.directory],{
      cwd:packageInfo.folder,env:{...process.env,MAC2JB_RPC_RUN:selected.directory,
        MAC2JB_RPC_CLIENT:path.join(root,'vendor/ns2jb/rpc.cjs')},stdio:['pipe','pipe','pipe']});
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    const input=options.input||process.stdin;
    input.pipe(child.stdin);
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')failed ||= error;});
    const observe=line=>{
      if(line.startsWith('MAC2JB_RPC_APP ')){
        let event;
        try{event=JSON.parse(line.slice('MAC2JB_RPC_APP '.length));}catch{return;}
        if(!event||typeof event!=='object'||Array.isArray(event)||
          !['progress','running','stopped','failed'].includes(event.type))return;
        const message=String(event.message||'').slice(0,1000);
        if(event.type==='running'){report.status='running';emit('running',{path:directory,message});}
        else if(event.type==='stopped'){stopped=true;cleanupVerified=event.cleanupVerified===true;}
        else if(event.type==='failed')failed=Error(message||'Custom RPC app failed.');
        else emit('progress',{path:directory,message});
      }else emit('progress',{path:directory,message:line.slice(0,1000)});
    };
    lines(child.stdout,observe);lines(child.stderr,observe);
    const outcome=await new Promise(resolve=>{
      child.once('error',error=>resolve({error}));
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    check(!outcome.error&&outcome.code===0&&!outcome.signal&&!failed,
      failed?.message||'Custom RPC app ended without a clean exit.');
    check(stopped&&cleanupVerified,
      'Custom RPC app did not confirm its native shutdown. Restart the console.');
    report.status='stopped';report.cleanupVerified=true;report.completed=new Date().toISOString();
    await save();emit('stopped',{path:directory,message:packageInfo.manifest.name+' stopped.'});
    return {stopped:true,run:selected.directory};
  }catch(error){
    report.status='cleanup-blocked';report.error=error.message;report.completed=new Date().toISOString();
    await save().catch(()=>{});
    emit('failed',{path:directory,cleanupBlocked:true,
      message:error.message+' Native cleanup is unverified; restart the console.'});
    error.homebrewReported=true;error.cleanupBlocked=true;throw error;
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
async function main(args=process.argv.slice(2),options={}){
  if(args.length===1&&args[0]==='--self-test'){
    const root=options.root||path.resolve(__dirname,'..');
    const prepared=await preflight(root,path.join(root,'vendor/OunceCake'));
    try{
      const packageInfo=await verifyPackage(prepared.packageFolder);
      const result={ready:true,adapter:packageInfo.manifest.adapter,files:packageInfo.files};
      process.stdout.write(JSON.stringify(result)+'\n');
      return result;
    }finally{await prepared.cleanup();}
  }
  check(args.length===2,'Usage: custom-rpc-package.cjs RUN_DIRECTORY PACKAGE_FOLDER');
  const packageInfo=await verifyPackage(args[1]);
  if(packageInfo.manifest.adapter==='ouncecake')return runOunceCake(args[0],packageInfo,options);
  return runScript(args[0],packageInfo,options);
}

module.exports={manifestName,ouncecakeFiles,validateManifest,sourceManifest,verifyPackage,
  preflight,runOunceCake,runScript,main};
if(require.main===module)main().catch(error=>{
  if(!error.homebrewReported)try{process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({
    type:'failed',cleanupBlocked:true,message:error.message+' This launch was not retried. Finish RPC and restart the console.'})+'\n');}catch{}
  process.exitCode=1;
});
