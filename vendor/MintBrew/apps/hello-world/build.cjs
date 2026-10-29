const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
async function main(){
 const state=Buffer.alloc(1024);state.writeFloatLE(1,960);await fs.writeFile(path.join(__dirname,'assets/state.bin'),state);
 execFileSync('python3',[path.join(__dirname,'assets.py')],{stdio:'inherit'});
 await require('../../sdk/build.cjs').buildApp(__dirname);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
