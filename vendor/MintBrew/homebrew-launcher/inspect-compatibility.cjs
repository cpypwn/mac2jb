const fs=require('node:fs/promises'),path=require('node:path');
const {inspectModule}=require('./inspect.cjs');
async function main(directory){
 directory=path.resolve(directory);const rpc=require(path.join(directory,'shared/rpc.cjs'));
 const imports=JSON.parse(await fs.readFile(path.join(directory,'display-inspection.json')));
 if(imports.session!==rpc.a.session)throw Error('Display inspection belongs to another session');
 const target=imports.imports.nvnBootstrapLoader.target;
 const region=await rpc.query(target);
 if(region.permissions!==5||region.ipcReferences)throw Error('Driver mapping changed');
 const module=await inspectModule(rpc,region.address,0x10000000);
 await fs.writeFile(path.join(directory,'compatibility-module.json'),JSON.stringify(module),{mode:0o600});
 console.log(JSON.stringify({base:module.base,symbols:module.symbols.length,
  vulkanExports:module.symbols.filter(s=>s.section&&s.name.startsWith('vk')).length}));
}
if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e.stack);process.exitCode=1;});
