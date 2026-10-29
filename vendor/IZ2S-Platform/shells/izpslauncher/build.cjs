// Rebuild only this shell. The primary IZlauncher and current console session are untouched.
const {execFileSync}=require('node:child_process'),path=require('node:path');
async function main(){
 const fs=require('node:fs'),env={...process.env,NODE:process.execPath};
 if(!env.HB_FONT)env.HB_FONT=['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','/usr/share/fonts/TTF/DejaVuSans.ttf'].find(f=>fs.existsSync(f));
 execFileSync('bash',[path.join(__dirname,'server/build.sh')],{stdio:'inherit',env});
 execFileSync('python3',[path.join(__dirname,'server/ps-assets.py')],{stdio:'inherit'});
 await require('./server/build-app.cjs').build();
}
main().catch(error=>{console.error(error);process.exitCode=1;});
