#!/usr/bin/env node
'use strict';
// no console commands: verify the packaged launcher catalogs.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
async function main(root=path.resolve(__dirname,'..')) {
  const runtime=path.join(root,'homebrew');
  const manifest=JSON.parse(await fs.readFile(path.join(runtime,'manifest.json'),'utf8'));
  for(const entry of manifest.files) {
    if(typeof entry.path!=='string'||path.isAbsolute(entry.path)||entry.path.split('/').includes('..'))throw Error('Unsafe dependency manifest path');
    const file=path.join(runtime,entry.path),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unexpected runtime file: '+entry.path);
    if(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')!==entry.sha256)
      throw Error('Changed homebrew dependency: '+entry.path);
  }
  const {runtimeEnvironment,applicationConfig}=require('./gui-homebrew.cjs');
  const inherited={...process.env},env=runtimeEnvironment(root,inherited);
  delete process.env.PYTHONHOME;Object.assign(process.env,env);
  const version=await run(path.join(runtime,'python/bin/python3'),['-c','import sys,PIL; print(sys.version.split()[0], PIL.__version__)'],{env});
  if(version.stdout.trim()!=='3.13.17 13.0.0')throw Error('Unexpected Python/Pillow versions');
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'mac2jb-launcher-check-'));
  try {
    for(const application of ['hblauncher','gpubrewlauncher','mintbrew']) {
      const selected=applicationConfig(application),vendor=path.join(root,'vendor',selected.vendor);
      const launcherEnv=runtimeEnvironment(root,inherited,application);Object.assign(process.env,launcherEnv);
      const catalog=require(path.join(vendor,'homebrew-launcher/app-catalog.cjs'));
      const data=await catalog.scan(launcherEnv.HB_APPS_DIR);
      if(data.rejected.length||!data.apps.length)throw Error(selected.name+' bundled app validation failed: '+JSON.stringify(data.rejected));
      const required=application==='hblauncher'?['hello-world','ftpd-sb']:
        application==='mintbrew'?['hello-world','froggy-road','ftpd-sb','chip8-test','izdoom','ouncecake','stremio-experimental']:
          ['hello-world','froggy-road','ftpd-sb'];
      for(const id of required)
        if(!data.apps.some(app=>app.id===id))throw Error('Missing bundled '+selected.name+' app: '+id);
      if(application==='mintbrew'&&data.apps.some(app=>app.id==='mintnes'||app.id==='mintftp'))
        throw Error('Unreleased MintBrew app is still bundled');
      for(const stage of ['vert','frag','comp'])
        await run(launcherEnv.SPIRV_VAL,['--target-env','vulkan1.0',path.join(vendor,'homebrew-launcher/shaders/launcher.'+stage+'.spv')],{env:launcherEnv});
      const target=path.join(scratch,selected.id);await fs.mkdir(target);
      await catalog.raster(data,target,'packaged');
      console.log(selected.name+': portable Python/Pillow/font, shader validation, '+data.apps.length+' bundled apps and catalog raster passed; no console commands sent.');
    }
    const malformed=path.join(scratch,'invalid.spv');await fs.writeFile(malformed,Buffer.alloc(24));
    let rejected=false;
    try{await run(env.SPIRV_VAL,['--target-env','vulkan1.0',malformed],{env});}catch{rejected=true;}
    if(!rejected)throw Error('Shader validator accepted malformed SPIR-V');
  } finally {await fs.rm(scratch,{recursive:true,force:true});}
}
module.exports={main};
if(require.main===module)main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
