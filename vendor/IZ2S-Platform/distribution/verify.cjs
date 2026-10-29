#!/usr/bin/env node
const fs=require('node:fs/promises'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=require('./profile.json');
async function verify(){
  const docs=spawnSync('python3',[path.join(__dirname,'check-docs.py'),root],{encoding:'utf8'});if(docs.status!==0)throw Error(docs.stderr||docs.stdout||'Documentation check failed');console.log(docs.stdout.trim());
  await require('../sdk/publish-modules.cjs').publish(root).then(r=>{if(r.errors.length)throw Error(JSON.stringify(r.errors));});
  const report=await require('../sdk/check.cjs').check(root);if(!report.valid)throw Error(JSON.stringify(report.errors));
  const shells=require('../core/descriptors.cjs').scan(root,'shell'),version=require('../package.json').version;
  if(shells.errors.length)throw Error(JSON.stringify(shells.errors));
  if(JSON.stringify(shells.items.map(s=>s.id).sort())!==JSON.stringify([...profile.shells].sort()))throw Error('Release shell inventory differs from the profile');
  for(const shell of shells.items){const app=await require('../core/services/app-catalog.cjs').readApp(path.join(shell.folder,'app'));if(shell.version!==version||app.version!==version||app.id!==shell.id)throw Error('Shell release metadata differs: '+shell.id);}
  const ids=(await fs.readdir(path.join(root,'modules'),{withFileTypes:true})).filter(e=>e.isDirectory()).map(e=>e.name).sort();
  if(JSON.stringify(ids)!==JSON.stringify([...profile.modules].sort()))throw Error('Unexpected release modules: '+ids);
  for(const id of profile.optionalEngines){const p=path.join(root,'engines',id,'upstream');const entries=await fs.readdir(p).catch(()=>[]);if(entries.some(n=>n!=='README.md'))throw Error('Release source contains downloaded engine: '+id);}
  for(const p of ['sdk/tests','sdk/fixtures','tests','data/state'])if(await fs.access(path.join(root,p)).then(()=>true,()=>false)){
    if(p==='data/state')continue;throw Error('Development-only directory: '+p);
  }
  const files=[];async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(['.git','data','dist','.dev'].includes(e.name))continue;const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Unexpected source symlink: '+f);if(e.isDirectory())await walk(f);else files.push(f);}}await walk(root);
  for(const file of files){const bytes=await fs.readFile(file);if(/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(bytes.toString()))throw Error('Possible credential in '+path.relative(root,file));
    if(file.endsWith('.cjs')||file.endsWith('.js')){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}}
  console.log('Release verified: File Exchange, IZMYSH, '+profile.optionalEngines.length+' optional engine adapters; '+files.length+' source files.');return report;
}
if(require.main===module)verify().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={verify};
