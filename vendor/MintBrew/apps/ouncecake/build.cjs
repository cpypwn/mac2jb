const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
async function main(){
 const directory=__dirname,state=Buffer.alloc(1024),memory=Buffer.alloc(4096);
 state.writeFloatLE(1,960);memory.writeUInt32LE(0x31435a4f,0);
 await fs.writeFile(path.join(directory,'state.bin'),state);
 await fs.writeFile(path.join(directory,'memory.bin'),memory);
 execFileSync('python3',[path.join(directory,'assets.py')],{stdio:'inherit'});
 const candidates=[path.resolve(directory,'../../../vendor/MintBrew/sdk/build.cjs'),
  path.resolve(directory,'../../sdk/build.cjs')];
 const sdk=candidates.find(file=>require('node:fs').existsSync(file));
 if(!sdk)throw Error('MintBrew shader build tools are unavailable');
 await require(sdk).buildApp(directory);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
