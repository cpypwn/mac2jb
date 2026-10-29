// Start a fresh native session and restore the launcher when the console connects.
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const children=new Set();
let stopping,sessionDirectory,keepSession;
function start(script,args=[],readyText,options={}){
 const child=spawn(process.execPath,[script,...args],{cwd:root,stdio:[options.stdin||'ignore','pipe','inherit']});
 child.script=script;children.add(child);let output='',readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 // Some stages only need completion; keep unused readiness rejections handled.
 ready.catch(()=>{});
 child.stdout.on('data',bytes=>{
  process.stdout.write(bytes);output=(output+bytes).slice(-32768);
  if(readyText&&output.includes(readyText))readyResolve(output);
 });
 const done=new Promise((resolve,reject)=>{
  child.once('error',reject);
  child.once('close',(code,signal)=>{children.delete(child);readyReject(Error(script+' exited before ready'));if(code===0)resolve(output);else reject(Error(script+' exited: '+(signal||code)));});
 });
 done.catch(()=>{});return {child,ready,done};
}
function stop(){
 if(stopping)return stopping;
 stopping=(async()=>{
  async function end(child){
   if(!children.has(child))return;
   await new Promise(resolve=>{const timer=setTimeout(resolve,5000);child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
  }
  // Close file-transfer handles and commit writes while RPC is still available.
  await Promise.all([...children].filter(c=>c.script==='sdk/host/ftp-service.cjs').map(end));
  // Keep RPC alive until the audio owner has stopped its console output.
  await Promise.all([...children].filter(c=>/\/game-audio\.cjs$/.test(c.script)).map(end));
  await Promise.all([...children].filter(c=>c.script!=='smilebasic/host.cjs').map(end));
  await Promise.all([...children].map(end));
 })();return stopping;
}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
async function main(){
 keepSession=process.env.HB_KEEP_SESSION==='1';
 // Session files are scratch data. Keep them out of the project unless the
 // operator explicitly asks to retain them for debugging.
 if(keepSession)await fs.mkdir(path.join(root,'runs'),{recursive:true,mode:0o700});
 sessionDirectory=await fs.mkdtemp(path.join(keepSession?path.join(root,'runs'):os.tmpdir(),keepSession?'launcher-':'mintbrew-'));
 process.env.HB_SESSION_DIR=sessionDirectory;
 if(keepSession)console.log('Keeping this session in: '+sessionDirectory);
 const host=start('smilebasic/host.cjs',process.argv.slice(2),'Qualified native session ready for graphics inspection.',{stdin:'inherit'});
 const directory=sessionDirectory;
 try{
  await host.ready;
  const stages=[['homebrew-launcher/inspect-display.cjs'],['homebrew-launcher/inspect-compatibility.cjs'],['homebrew-launcher/inspect-input.cjs'],['homebrew-launcher/vulkan-copy.cjs','display'],['homebrew-launcher/launcher.cjs','auto'],['homebrew-launcher/launcher-check.cjs','auto']];
  for(const [script,...args] of stages)await start(script,[directory,...args]).done;
  const graphics=start('homebrew-launcher/launcher-loop.cjs',[directory,'auto'],'MintBrew game event source ready.');
  await graphics.ready;
  const ftp=start('sdk/host/ftp-service.cjs',[directory],'SDK FTP service ready.');await ftp.ready;
  const effects=start('homebrew-launcher/game-audio.cjs',[directory],'Game sound effects ready.');await effects.ready;
  console.log('MintBrew GPU app runtime and package sound effects are running.');
  await Promise.race([host.done,graphics.done,effects.done,ftp.done]);
 }finally{
  await stop();
  if(!keepSession)await fs.rm(sessionDirectory,{recursive:true,force:true});
 }
}
main().catch(error=>{if(!stopping){console.error(error);process.exitCode=1;}});
