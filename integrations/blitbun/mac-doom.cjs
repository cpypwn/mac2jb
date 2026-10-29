const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');

const WIDTH=320,HEIGHT=200,FRAME_BYTES=WIDTH*HEIGHT*2;
const FRAME_TIMEOUT_MS=5000;
const ENGINE_SHA256='9521f644a40ad6b020b79a6579a4621710baee562c0002b9e489f90d6cd9efc9';
const WAD_SHA256='7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d';
const KEY={left:0xac,up:0xad,right:0xae,down:0xaf,strafeLeft:0xa0,strafeRight:0xa1,use:0xa2,fire:0xa3,run:0xb6,enter:13,escape:27,shotgun:51};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function decodeButtons(packet){
  if(!Buffer.isBuffer(packet)||packet.length!==396)throw Error('Invalid Doom input packet');
  if(packet.readUInt32LE(328)!==2||packet.readUInt32LE(336)!==0||!(packet.readUInt32LE(332)&2))return [];
  let buttons=0,lx=0,ly=0,rx=0;
  for(let index=0;index<5;index++){
    const at=8+index*64;if(!(packet.readUInt32LE(at+32)&1))continue;
    buttons|=packet.readUInt32LE(at+8);
    for(const [offset,current] of [[16,lx],[20,ly],[24,rx]]){
      const value=packet.readInt32LE(at+offset);
      if(Math.abs(value)>Math.abs(current)){
        if(offset===16)lx=value;
        else if(offset===20)ly=value;
        else rx=value;
      }
    }
  }
  const pressed=bit=>(buttons&(1<<bit))!==0,keys=new Set();
  if(pressed(13)||ly< -10000)keys.add(KEY.up);
  if(pressed(15)||ly>10000)keys.add(KEY.down);
  if(pressed(12)||lx< -10000||rx< -10000)keys.add(KEY.left);
  if(pressed(14)||lx>10000||rx>10000)keys.add(KEY.right);
  if(pressed(0)||pressed(9))keys.add(KEY.fire);
  if(pressed(1)||pressed(8))keys.add(KEY.use);
  if(pressed(3))keys.add(KEY.run);
  if(pressed(6))keys.add(KEY.strafeLeft);
  if(pressed(7))keys.add(KEY.strafeRight);
  if(pressed(10))keys.add(KEY.enter);
  if(pressed(11))keys.add(KEY.escape);
  if(pressed(2))keys.add(KEY.shotgun);
  return [...keys].sort((a,b)=>a-b);
}

function keyTransitions(previous,packet){
  const next=decodeButtons(packet),old=new Set(previous),now=new Set(next),events=[];
  for(const key of old)if(!now.has(key))events.push({key,pressed:false});
  for(const key of next)if(!old.has(key))events.push({key,pressed:true});
  return {next,events};
}

function preview(frame){
  const rgba=Buffer.allocUnsafe(WIDTH*HEIGHT*4);
  for(let index=0;index<WIDTH*HEIGHT;index++){
    const value=frame.readUInt16LE(index*2),at=index*4;
    rgba[at]=((value>>11)&31)*255/31;
    rgba[at+1]=((value>>5)&63)*255/63;
    rgba[at+2]=(value&31)*255/31;
    rgba[at+3]=255;
  }
  return rgba;
}

async function checked(file,expected){
  const stat=await fsp.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||sha(await fsp.readFile(file))!==expected)throw Error('Bundled Freedoom file failed verification: '+path.basename(file));
}

async function create(directory,{capture=true,headless=true,audio=false,launch=spawn,frameTimeoutMs=FRAME_TIMEOUT_MS}={}){
  if(!capture||!headless)throw Error('Bundled Freedoom requires headless capture');
  if(!Number.isInteger(frameTimeoutMs)||frameTimeoutMs<1)throw Error('Invalid Freedoom frame timeout');
  const source=path.join(__dirname,'../doom/doom-headless'),wad=path.join(__dirname,'../doom/freedoom1.wad');
  await Promise.all([checked(source,ENGINE_SHA256),checked(wad,WAD_SHA256)]);
  const engine=path.join(directory,'doom-headless');
  await fsp.copyFile(source,engine);await fsp.chmod(engine,0o700);
  const log=fs.openSync(path.join(directory,'doom-host.log'),'a',0o600);
  const args=['-iwad',wad,'-gfxmode','rgb565','-nosound','-nomusic','-nosfx','-warp','1','-skill','3','-config',path.join(directory,'doom.cfg')];
  const child=launch(engine,args,{cwd:directory,stdio:['pipe',log,log,'pipe']});fs.closeSync(log);
  const report={source:'doom',game:'Freedoom Phase 1',width:WIDTH,height:HEIGHT,frames:0,exited:false,audio:false,started:new Date().toISOString()};
  const video={latest:null};let closed=false,pending=null,offset=0,buffer=Buffer.allocUnsafe(FRAME_BYTES),held=[],inputError=null,terminalError=null,reportWrite=Promise.resolve();
  const saveReport=()=>{const bytes=JSON.stringify(report,null,2);reportWrite=reportWrite.catch(()=>{}).then(()=>fsp.writeFile(path.join(directory,'doom-engine.json'),bytes,{mode:0o600}));return reportWrite;};
  const failed=error=>{if(terminalError)return;terminalError=error;report.error=error.message;saveReport().catch(()=>{});if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}};
  child.on('error',failed);
  child.stdin.on('error',error=>{inputError=error;failed(error);});
  child.on('exit',(code,signal)=>{report.exited=true;report.exitCode=code;report.signal=signal;if(!closed)failed(Error('Bundled Freedoom engine exited; see doom-host.log'));});
  child.stdio[3].on('data',bytes=>{
    if(!pending){if(!closed&&!terminalError)failed(Error('Unexpected Doom frame data'));return;}
    for(let index=0;index<bytes.length;){
      const count=Math.min(FRAME_BYTES-offset,bytes.length-index);bytes.copy(buffer,offset,index,index+count);offset+=count;index+=count;
      if(offset===FRAME_BYTES){
        const frame=Buffer.from(buffer);offset=0;report.frames++;report.lastFrameAt=new Date().toISOString();
        video.latest={w:WIDTH,h:HEIGHT,rgba:preview(frame),at:performance.now(),sequence:report.frames};
        const own=pending;pending=null;clearTimeout(own.timer);report.frameWaitMs=+(performance.now()-own.started).toFixed(2);own.resolve(frame);
        if(index<bytes.length)failed(Error('Unexpected extra Doom frame data'));
      }
    }
  });
  function nextFrame(timeoutMs=frameTimeoutMs){
    if(!Number.isInteger(timeoutMs)||timeoutMs<1)throw Error('Invalid Freedoom frame timeout');
    if(closed||report.exited||inputError||terminalError)return Promise.reject(inputError||terminalError||Error('Bundled Freedoom engine has stopped'));
    if(pending)return Promise.reject(Error('Doom frame request already pending'));
    return new Promise((resolve,reject)=>{
      const request={resolve,reject,started:performance.now(),at:new Date().toISOString(),sequence:report.frames+1};pending=request;
      request.timer=setTimeout(()=>setImmediate(()=>{
        if(pending!==request)return;
        const elapsedMs=+(performance.now()-request.started).toFixed(2);
        report.timeout={requestedAt:request.at,sequence:request.sequence,elapsedMs,eventLoopOverrunMs:+Math.max(0,elapsedMs-timeoutMs).toFixed(2),frameBytesReceived:offset,stdinQueuedBytes:child.stdin.writableLength,childPid:child.pid??null,childExitCode:child.exitCode??null};
        failed(Error('Bundled Freedoom engine did not produce a frame'));
      }),timeoutMs);
      if(child.stdin.writableLength>4096)return failed(Error('Doom input pipe stopped draining'));
      child.stdin.write(Buffer.from([2,0,0]));
    });
  }
  function input(packet){
    if(closed||report.exited||inputError||terminalError)return;
    report.inputPackets=(report.inputPackets||0)+1;
    const transition=keyTransitions(held,packet);held=transition.next;
    if(transition.events.length){
      if(child.stdin.writableLength>4096)return failed(Error('Doom input pipe stopped draining'));
      child.stdin.write(Buffer.from(transition.events.flatMap(event=>[1,event.key,event.pressed?1:0])));
    }
  }
  async function close(){
    if(closed)return;closed=true;
    if(pending){clearTimeout(pending.timer);pending.reject(Error('Doom capture stopped'));pending=null;}
    child.stdin.end();child.kill('SIGTERM');
    if(!report.exited){await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(1000)]);if(!report.exited)child.kill('SIGKILL');}
    await reportWrite.catch(()=>{});
  }
  try{await nextFrame();}catch(error){await close();throw error;}
  return {report,video,audio:null,nextFrame,input,close};
}

function start({remote,stream,onError=()=>{}}){
  let stopped=false;const abort=new AbortController();
  const done=(async()=>{
    let recent=[];
    while(!stopped){
      try{
        await stream.waitForRoute?.({signal:abort.signal});
        if(stopped)break;
        const frame=await remote.nextFrame();if(stopped)break;
        const started=performance.now(),metrics=Buffer.alloc(32);metrics.writeUInt32LE(0x495a4d35);
        const now=performance.now();recent.push(now);recent=recent.filter(at=>now-at<1000);
        metrics.writeUInt32LE(Math.round((recent.length>1?(recent.length-1)*1000/(recent.at(-1)-recent[0]):0)*100),4);
        await stream.push(frame,WIDTH,HEIGHT,0,metrics);
        Object.assign(stream.stats,{source:'doom',game:'Freedoom Phase 1',targetFps:35,audio:false,frameBytes:FRAME_BYTES,captureMs:0,encodeMs:0,latencyMs:+(performance.now()-started).toFixed(2),doomEngine:{...remote.report}});
      }catch(error){
        if(stopped||error.name==='AbortError')break;
        if(error.recoverable){await wait(error.retryAfterMs||500);continue;}
        throw error;
      }
    }
  })().catch(error=>{if(!stopped){stream.stats.doomEngine={...remote.report};onError(error);}});
  return {done,async close(){if(stopped)return;stopped=true;abort.abort();await done;}};
}

module.exports={WIDTH,HEIGHT,FRAME_BYTES,FRAME_TIMEOUT_MS,ENGINE_SHA256,WAD_SHA256,KEY,decodeButtons,keyTransitions,create,start};
