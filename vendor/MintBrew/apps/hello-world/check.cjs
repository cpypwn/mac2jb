const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
async function main(){
 const root=path.resolve(__dirname,'../..'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'hello-world-check-'));
 for(const [name,buttons,connected,previous,want] of [['idle',0,1,0,0],['B',2,1,0,1],['Minus',2048,1,0,1],['held B',2,1,2,0],['disconnected',2,0,0,0]]){
  const state=Buffer.alloc(1024);state.writeUInt32LE(previous,84);state.writeFloatLE(1,960);
  const input=Buffer.alloc(64);input.writeUInt32LE(buttons,8);input.writeUInt32LE(connected,32);
  await fs.writeFile(path.join(dir,'state'),state);await fs.writeFile(path.join(dir,'input'),input);
  execFileSync(path.join(root,'homebrew-launcher/game-compute-check'),[path.join(dir,'state'),path.join(dir,'output'),path.join(__dirname,'app.comp.spv'),path.join(dir,'input'),'1'],{stdio:'pipe'});
  const out=await fs.readFile(path.join(dir,'output'));assert.equal(out.readUInt32LE(1016),want,name);assert.ok(out.readFloatLE(960)<1);
 }
 const state=Buffer.alloc(1024);await fs.writeFile(path.join(dir,'state'),state);
 execFileSync(path.join(root,'homebrew-launcher/game-render'),[path.join(dir,'state'),path.join(__dirname,'assets/text.bin'),__dirname,path.join(dir,'preview.rgba')],{env:{...process.env,HB_SHADER_PREFIX:'app'},stdio:'pipe'});
 execFileSync('python3',['-c','from PIL import Image; import sys; Image.frombytes("RGBA",(1920,1080),open(sys.argv[1],"rb").read()).save(sys.argv[2])',path.join(dir,'preview.rgba'),path.join(dir,'preview.png')]);
 console.log('Passed: greeting render, idle, B/Minus exit, held button and disconnected input.');console.log('Preview: '+path.join(dir,'preview.png'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
