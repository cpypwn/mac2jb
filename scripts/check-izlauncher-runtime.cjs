#!/usr/bin/env node
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile);
async function main(root=path.resolve(__dirname,'..')) {
  const prepared=require('./prepare-izlauncher.cjs'),info=prepared.verify(root),env=prepared.runtimeEnvironment(root);
  delete process.env.PYTHONHOME;Object.assign(process.env,env);
  const version=await run(path.join(root,'homebrew/python/bin/python3'),['-c','import sys,PIL; print(sys.version.split()[0], PIL.__version__)'],{env});
  if(version.stdout.trim()!=='3.13.17 13.0.0')throw Error('Unexpected IZlauncher Python/Pillow runtime.');
  const compiler=await run(env.GLSLANG,['--version'],{env});
  if(!compiler.stdout.includes('16.6.0'))throw Error('Unexpected offline IZlauncher shader compiler.');
  const catalog=require(path.join(info.directory,'core/services/app-catalog.cjs'));
  const data=await catalog.scan(env.HB_APPS_DIR);
  const expected=JSON.parse(await fs.readFile(path.join(info.directory,'mac2jb-runtime.json'),'utf8')).modules;
  if(data.rejected.length||JSON.stringify(data.apps.map(app=>app.id).sort())!==JSON.stringify([...expected].sort()))
    throw Error('Unexpected IZlauncher app catalog.');
  const registry=require(path.join(info.directory,'core/modules.cjs'));
  const modules=await registry.list(info.directory);
  if(modules.errors.length||JSON.stringify(modules.modules.map(item=>item.id).sort())!==JSON.stringify([...expected].sort()))
    throw Error('Unexpected IZlauncher module inventory.');
  await registry.verify(info.directory,expected);
  const entry=await registry.loadServer(info.directory,'iz-exchange');
  if(typeof entry.load('runtime').create!=='function')throw Error('File Exchange Mac runtime is unavailable.');
  const blitbun=await registry.loadServer(info.directory,'blitbun');
  if(typeof blitbun.load('create').create!=='function')throw Error('BlitBun Mac browser host is unavailable.');
  const blitbunFolder=modules.modules.find(item=>item.id==='blitbun')?.folder;
  if(!blitbunFolder)throw Error('Bundled Freedoom module is unavailable.');
  const doom=require(path.join(blitbunFolder,'server/lib/mac-doom.cjs'));
  const vacootube=await registry.loadServer(info.directory,'vacootube');
  if(typeof vacootube.load('create').create!=='function'||typeof vacootube.load('localPackage').create!=='function')
    throw Error('VacooTube Mac player host is unavailable.');
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'mac2jb-izlauncher-check-'));
  try {
    const game=await doom.create(scratch,{capture:true,headless:true,audio:false});
    try {
      const frame=await game.nextFrame();
      if(!Buffer.isBuffer(frame)||frame.length!==128000||!frame.some(byte=>byte!==0)||
        game.report.frames<2||game.report.exited)throw Error('Bundled Freedoom did not render a live RGB565 frame.');
    } finally {await game.close();}
    if(!game.report.exited||game.report.error)throw Error('Bundled Freedoom did not stop cleanly.');
    const shader=path.join(scratch,'custom.vert'),compiled=path.join(scratch,'custom.spv');
    await fs.writeFile(shader,'#version 450\nvoid main(){gl_Position=vec4(0.0);}\n');
    await run(env.GLSLANG,['-V','-Os','-g0','--target-env','vulkan1.0',shader,'-o',compiled],{env});
    await run(env.SPIRV_VAL,['--target-env','vulkan1.0',compiled],{env});
    const shell=await require(path.join(info.directory,'shells/izlauncher/server/composition.cjs')).build(data.apps,scratch);
    const frozen=JSON.parse(await fs.readFile(path.join(info.directory,'mac2jb-runtime.json'),'utf8')).prebuiltShells;
    if(!frozen.includes(shell.id)||shell.root!==path.join(info.directory,'shells/izlauncher/prebuilt',shell.id))
      throw Error('IZlauncher did not use a verified offline shader shell.');
    const atlas=await require(path.join(info.directory,'shells/izlauncher/server/font-data.cjs')).load();
    const type=await require(path.join(info.directory,'shells/izlauncher/server/assets.cjs')).loadTypeAtlas();
    if(atlas.length!==2097152||!type.bytes.length)throw Error('IZlauncher font atlases are incomplete.');
    const raster=await require(path.join(info.directory,'shells/izlauncher/server/raster.cjs')).raster(data,scratch,'offline-hero');
    if(raster.length!==32*131072||!raster.subarray(106496,118784).some(byte=>byte!==0))throw Error('IZlauncher hero title did not rasterize.');
    for(const stage of ['vert','frag','comp'])
      await run(env.SPIRV_VAL,['--target-env','vulkan1.0',path.join(info.directory,'shells/izlauncher/server/shaders/launcher.'+stage+'.spv')],{env});
    console.log('IZlauncher base shell + modules: integrity, Mac component loading, bundled Freedoom engine and live frame, offline shader compilation, prebuilt/compressed shaders, Python/Pillow/font and hero catalog raster passed; no USB or RPC operations.');
  } finally {await fs.rm(scratch,{recursive:true,force:true});}
  prepared.verify(root);
}
module.exports={main};
if(require.main===module)main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
