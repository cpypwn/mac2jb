const fs=require('node:fs/promises'),path=require('node:path'),{execFileSync}=require('node:child_process');

async function main(){
 const root=__dirname,repository=path.resolve(root,'../../..'),state=Buffer.alloc(1024);
 await fs.writeFile(path.join(root,'assets/state.bin'),state);
 const bundled=path.join(repository,'homebrew/python/bin/python3');
 execFileSync(require('node:fs').existsSync(bundled)?bundled:'python3',[path.join(root,'assets.py')],{stdio:'inherit'});
 process.env.GLSLANG||=path.join(repository,'homebrew/bin/glslangValidator');
 process.env.SPIRV_VAL||=path.join(repository,'homebrew/bin/spirv-val');
 await require(path.resolve(root,'../../../vendor/MintBrew/sdk/build.cjs')).buildApp(root);
}

if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
