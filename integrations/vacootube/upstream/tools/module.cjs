#!/usr/bin/env node
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),root=path.resolve(__dirname,'..'),descriptor=require('../module.json'),args=process.argv.slice(2),action=args.shift()||'help';
function option(name){const i=args.indexOf(name);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing value for '+name);return args[i+1];}
async function platform(){const input=option('--platform')||process.env.IZ2S_ROOT;if(!input)throw Error('Specify --platform /absolute/path/to/IZ2S or set IZ2S_ROOT. IZ2S Platform is required.');const p=await fs.realpath(input);const api=require(path.join(p,'sdk/platform.cjs'));if(!api.streamMenuExtensions)throw Error('Update IZ2S Platform: this VacooTube version requires the console stream-menu extension.');if(!api.moduleDirectories)throw Error('Update IZ2S Platform: named module directories are not supported by this installation.');if(api.apiVersion!==1)throw Error('IZ2S API 1 is required');if(!require(path.join(p,'core/compatibility.cjs')).minimumVersion(require(path.join(p,'package.json')).version,'0.16.0-rc.3'))throw Error('IZ2S Platform 0.16.0-rc.3 or newer is required');await fs.access(path.join(p,'core/archive.cjs'));return p;}
const ignored=new Set(['.git','.dev','.versions','data','test-data','dist','downloads','__pycache__','node_modules','test','tests']);
async function copySource(source,target,{runtime=false}={}){await fs.mkdir(target,{recursive:true});await fs.cp(source,target,{recursive:true,verbatimSymlinks:true,filter:async p=>{const rel=path.relative(source,p);if(!rel)return true;const parts=rel.split(path.sep),n=path.basename(p);if(parts[0]==='runtime')return runtime; if(parts.some(x=>ignored.has(x)||x.startsWith('.'))||n.endsWith('.izm')||n.endsWith('.log')||n.endsWith('.pyc')||n==='checksums.json')return false;const s=await fs.lstat(p);if(s.isSymbolicLink())throw Error('Source symlinks are unsupported: '+rel);return true;}});}
async function check(p){
 const core=require(path.join(p,'core/descriptors.cjs'));core.moduleDescriptor(descriptor);if(require('../package.json').version!==descriptor.version||JSON.parse(await fs.readFile(path.join(root,descriptor.switch.entry))).version!==descriptor.version)throw Error('Repository, module and console versions must match');
 const needed=[descriptor.switch?.entry,descriptor.server?.entry,...(descriptor.switch?.files||[]),...(descriptor.server?.assets||[])].filter(Boolean);
 for(const file of needed)await fs.access(path.join(root,file));
 const failures=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(ignored.has(e.name)||e.name==='runtime'||e.name.startsWith('.'))continue;const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(/\.(cjs|js)$/.test(e.name))try{await run(process.execPath,['--check',f]);}catch(err){failures.push(err.stderr||err.message);}}}await walk(root);if(failures.length)throw Error(failures.join('\n'));
 console.log(descriptor.name+' source and declared files verified.');
}
async function pack(p,folder=root){const temp=await fs.mkdtemp(path.join(os.tmpdir(),'iz2s-module-pack-'));try{await copySource(folder,temp);const bytes=await require(path.join(p,'core/archive.cjs')).pack(temp);const archive=require(path.join(p,'core/archive.cjs')).inspect(bytes);const target=path.join(folder,descriptor.id+'.izm');await fs.writeFile(target+'.tmp',bytes);await fs.rename(target+'.tmp',target);console.log(descriptor.name+': '+bytes.length+' bytes; console payload '+archive.files.filter(f=>descriptor.switch?.files.includes(f.name)).reduce((s,f)=>s+f.bytes.length,0)+' bytes');return target;}finally{await fs.rm(temp,{recursive:true,force:true});}}
async function install(p){
 const modules=await fs.realpath(path.join(p,'modules')),paths=require(path.join(p,'core/module-paths.cjs')),target=paths.target(p,descriptor),previous=[descriptor.id,...(descriptor.legacy?.moduleIds||[])].map(id=>paths.find(p,id)).filter(Boolean).reduce((found,home)=>{if(found&&found!==home)throw Error('Multiple old/new installations found; move one aside before updating.');return home;},null);if(previous&&previous!==target&&!args.includes('--replace'))throw Error('Legacy installation found. Stop its active session, then pass --replace to migrate it and preserve its private data.');if(path.dirname(target)!==modules||!/^[-a-z0-9]+$/.test(descriptor.id))throw Error('Invalid module destination');
 if(await fs.lstat(target).then(s=>s.isSymbolicLink(),()=>false))throw Error('Module destination must not be a symlink');
 const existing=previous||target,exists=await fs.access(existing).then(()=>true,()=>false);if(exists&&!args.includes('--replace'))throw Error('Module already exists. Stop its active session, then pass --replace to keep a backup and replace it.');
 for(const d of descriptor.dependencies||[])if(d.kind==='module'){const file=path.join(paths.home(p,d.id),'module.json');const installed=await fs.readFile(file,'utf8').then(JSON.parse,()=>null);if(!installed)throw Error('Install required module first: '+d.id);const compatible=require(path.join(p,'core/compatibility.cjs'));if(!compatible.minimumVersion(installed.version,d.version))throw Error('Required module is too old: '+d.id+' '+d.version);}
 if(previous&&previous!==target&&await fs.access(target).then(()=>true,()=>false))throw Error('Destination already exists: '+target);
 const temporary=await fs.mkdtemp(path.join(modules,'.install-'+descriptor.id+'-'));let backup;
 try{
  await copySource(root,temporary,{runtime:args.includes('--with-runtime')});
  // Keep the user's settings and runtimes; never distribute their private data.
  if(exists)for(const name of ['data','runtime','.versions']){const old=path.join(existing,name);if(await fs.access(old).then(()=>true,()=>false)){if(name==='runtime'&&args.includes('--with-runtime'))continue;await fs.cp(old,path.join(temporary,name),{recursive:true,verbatimSymlinks:true});}}
  await pack(p,temporary);
  if(exists){backup=path.join(p,'data/module-backups',descriptor.id,new Date().toISOString().replace(/[:.]/g,'-'));await fs.mkdir(path.dirname(backup),{recursive:true});await fs.rename(existing,backup);}
  try{await fs.rename(temporary,target);}catch(error){if(backup)await fs.rename(backup,existing);throw error;}
  console.log('Installed '+descriptor.name+' in '+target+(backup?'\nPrevious module preserved in '+backup:''));
  console.log('No console commands were sent. Load the module in IZlauncher during a fresh session.');
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
async function sha(file){const {createReadStream}=require('node:fs'),h=crypto.createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function release(p){
 await check(p);
 const status=await run('git',['status','--porcelain','--untracked-files=normal'],{cwd:root});
 if(status.stdout.trim())throw Error('Commit source changes before making a release.');
 const commit=(await run('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'iz2s-module-release-'));
 try{
  // Read committed bytes, not the changing working tree of an active experiment.
  const sourceArchive=path.join(temp,'source.tar'),source=path.join(temp,'source');
  await run('git',['archive','--format=tar','-o',sourceArchive,commit],{cwd:root});await fs.mkdir(source);await run('tar',['-xf',sourceArchive,'-C',source]);
  const name=JSON.parse(await fs.readFile(path.join(source,'package.json'))).name,archiveRoot=descriptor.installationDirectory||name,folder=path.join(temp,archiveRoot);
  await copySource(source,folder);
  const shipped=JSON.parse(await fs.readFile(path.join(folder,'module.json')));
  if(shipped.id!==descriptor.id||shipped.version!==descriptor.version)throw Error('Source changed while release began; retry after committing.');
  if(args.includes('--with-runtime')){
   await fs.cp(path.join(root,'runtime'),path.join(folder,'runtime'),{recursive:true,verbatimSymlinks:true});
   if(shipped.id==='vacootube')await require(path.join(folder,'server/local-package/install.cjs')).locate();
  }
  await pack(p,folder);
  await fs.writeFile(path.join(folder,'release.json'),JSON.stringify({name,version:shipped.version,commit,moduleId:shipped.id,platformApi:1,runtime:args.includes('--with-runtime')?process.platform+'-'+process.arch:'not-bundled'},null,2)+'\n');
  const sums=[];async function walk(dir){for(const e of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else sums.push(await sha(f)+'  '+path.relative(folder,f));}}
  await walk(folder);await fs.writeFile(path.join(folder,'FILES.sha256'),sums.join('\n')+'\n');await fs.mkdir(path.join(root,'dist'),{recursive:true});
  const archive=path.join(root,'dist',name+'-'+shipped.version+(args.includes('--with-runtime')?'-'+process.platform+'-'+process.arch+'-offline':'-source')+'.tar.gz');
  await run('tar',['-czf',archive,'-C',temp,archiveRoot],{timeout:300000});await fs.writeFile(archive+'.sha256',await sha(archive)+'  '+path.basename(archive)+'\n');
  console.log(archive+'\n'+(await fs.stat(archive)).size+' bytes');
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
async function main(){if(action==='help'){console.log('Usage: node tools/module.cjs check|pack|install|release --platform /path/to/IZ2S [--replace] [--with-runtime]');return;}const p=await platform();if(action==='check')return check(p);if(action==='pack')return pack(p);if(action==='install')return install(p);if(action==='release')return release(p);throw Error('Unknown action: '+action);}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={copySource};
