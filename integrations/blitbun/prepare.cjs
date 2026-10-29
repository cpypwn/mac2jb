const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const freedoom=require('./freedoom-assets.cjs');
const doom=require('./mac-doom.cjs');
const REVISION='7d4098df26909016ace0fb4760ef9269cd2b4743';
const VERSION='1.14.4';
const MANIFEST_SHA256='c8e6cccddfe9562fa3240cfe01c460905def134dd14daaf4d22d7ea357b6f39d';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const check=(value,message)=>{if(!value)throw Error(message);};

function files(folder,prefix=''){
  const result=[];
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    const relative=prefix+entry.name,target=path.join(folder,entry.name);
    check(!entry.isSymbolicLink(),'BlitBun source contains a link: '+relative);
    if(entry.isDirectory())result.push(...files(target,relative+'/'));
    else{check(entry.isFile(),'BlitBun source contains a special file: '+relative);result.push(relative);}
  }
  return result.sort();
}

function sourceFiles(root){
  const directory=path.join(root,'vendor/BlitBun');
  const manifest=fs.readFileSync(path.join(root,'integrations/blitbun/upstream-SHA256SUMS'));
  check(sha(manifest)===MANIFEST_SHA256,'Changed BlitBun source inventory.');
  const inventory=new Map();
  for(const line of manifest.toString('utf8').trim().split('\n')){
    const row=/^([a-f0-9]{64})  (.+)$/.exec(line);
    check(row&&!path.isAbsolute(row[2])&&!/[\\\x00-\x1f]/.test(row[2])&&
      !row[2].split('/').some(part=>!part||part==='.'||part==='..')&&!inventory.has(row[2]),
      'Invalid BlitBun source inventory.');
    inventory.set(row[2],row[1]);
  }
  check(JSON.stringify(files(directory))===JSON.stringify([...inventory.keys()].sort()),
    'Unexpected or missing BlitBun source file.');
  const contents=new Map();
  for(const [name,digest] of inventory){
    const bytes=fs.readFileSync(path.join(directory,name));
    check(sha(bytes)===digest,'Changed BlitBun source: '+name);
    contents.set(name,bytes);
  }
  const descriptor=JSON.parse(contents.get('module.json'));
  check(descriptor.id==='blitbun'&&descriptor.version===VERSION&&
    JSON.stringify(descriptor.platforms)==='["linux-x64","linux-arm64"]',
    'Unexpected BlitBun source descriptor.');
  return contents;
}

function replaceOnce(contents,name,before,after){
  const original=contents.get(name)?.toString('utf8');
  check(original&&original.split(before).length===2,'BlitBun overlay no longer matches '+name);
  contents.set(name,Buffer.from(original.replace(before,after)));
}

function overlay(source,root){
  const out=new Map(source);
  const descriptor=JSON.parse(out.get('module.json'));
  descriptor.platforms=['darwin-arm64'];
  descriptor.server.assets.push('server/lib/mac-panel.cjs','server/lib/mac-stream-host.cjs','server/lib/mac-doom.cjs','server/doom/doom-headless','server/doom/freedoom1.wad','server/doom/COPYING.txt','server/doom/CREDITS.txt','server/doom/CREDITS-MUSIC.txt','server/doom/doomgeneric-LICENSE');
  descriptor.description='Browser capture and bundled Freedoom streaming to Switch 2 on Apple silicon Mac';
  out.set('module.json',Buffer.from(JSON.stringify(descriptor,null,2)+'\n'));
  const app=JSON.parse(out.get('switch/app.json'));
  app.description='Share a Mac screen or play bundled Freedoom on Switch 2';
  out.set('switch/app.json',Buffer.from(JSON.stringify(app,null,2)+'\n'));
  out.set('server/lib/mac-panel.cjs',fs.readFileSync(path.join(root,'integrations/blitbun/mac-panel.cjs')));
  out.set('server/lib/mac-stream-host.cjs',fs.readFileSync(path.join(root,'integrations/mac-stream-host.cjs')));
  out.set('server/lib/mac-doom.cjs',fs.readFileSync(path.join(root,'integrations/blitbun/mac-doom.cjs')));
  const engine=fs.readFileSync(path.join(root,'integrations/blitbun/doom-engine/doom-headless'));
  check(sha(engine)===doom.ENGINE_SHA256,'Changed bundled Doom engine.');
  out.set('server/doom/doom-headless',engine);
  out.set('server/doom/doomgeneric-LICENSE',fs.readFileSync(path.join(root,'integrations/blitbun/doom-engine/source/LICENSE')));
  for(const [name,bytes] of freedoom.load(root))out.set('server/doom/'+name,bytes);
  replaceOnce(out,'server/application-host.cjs',
    "cropWindow=require('./lib/window-crop.cjs').crop",
    "cropWindow=async(width,height)=>({x:0,y:0,w:width,h:height,exact:false})");
  replaceOnce(out,'server/application-host.cjs',
    "openWindow=url=>require(require('node:path').join(require('./lib/platform.cjs').root,\"core/services/open-panel.cjs\")).openPanel(url,{env:{...process.env,HB_OPEN_PANEL:'1'}})",
    "openWindow=url=>require('./lib/mac-panel.cjs').openPanel(url)");
  replaceOnce(out,'server/application-host.cjs',"next={...next};if(['space-rangers'",
    "next={...next};if(next.source&&!['browser','doom'].includes(next.source)||next.launch!==undefined&&next.launch!=='doom'||next.windowId!==undefined||next.controller&&next.controller!=='off'&&next.controller!=='gamepad')throw Error('This macOS BlitBun package supports browser capture and bundled Freedoom only.');if(['space-rangers'");
  replaceOnce(out,'server/application-host.cjs',"source!=='player'&&!preview)){await pad?.close()",
    "source!=='player'&&source!=='doom'&&!preview)){await pad?.close()");
  replaceOnce(out,'server/application-host.cjs',"if(next.controller!=='off'&&!preview&&source!=='player')pad=await newGamepad()",
    "if(next.controller!=='off'&&!preview&&source!=='player'&&source!=='doom')pad=await newGamepad()");
  replaceOnce(out,'server/application-host.cjs',"remote=await (await component('doom','create')).create(directory,{capture:true,headless:true,audio:true})",
    "remote=await require('./lib/mac-doom.cjs').create(directory,{capture:true,headless:true,audio:false})");
  replaceOnce(out,'server/application-host.cjs',
    "try{audioSink=await audioFactory({rpc,directory,source:remote.audio,enabled:()=>audioEnabled&&routeGate.allowNow(),audioOutput:()=>options.audioOutput});}catch(error){console.error('Doom audio: '+error.message);await fs.writeFile(path.join(directory,'stream-audio-error.json'),JSON.stringify({error:error.message,at:new Date().toISOString()}));}",
    "stream.stats.audio=false;");
  replaceOnce(out,'server/application-host.cjs',"pump=(await component('doom','stream')).start({remote,stream,onError:",
    "pump=require('./lib/mac-doom.cjs').start({remote,stream,onError:");
  replaceOnce(out,'server/application-host.cjs',"controller:{source:pad?.report?.source,profile:",
    "controller:{source:source==='doom'?'Switch controller':pad?.report?.source,profile:");
  replaceOnce(out,'server/application-host.cjs',"ready:!!pad&&!pad.report?.exited,packets:pad?.report?.packets||0",
    "ready:source==='doom'?!!remote&&!remote.report.exited:!!pad&&!pad.report?.exited,packets:source==='doom'?(remote?.report?.inputPackets||0):(pad?.report?.packets||0)");
  replaceOnce(out,'server/application-host.cjs',"if(next.source&&next.source!==source){await stream.invalidate?.('source-changed');source=next.source;",
    "if(next.source&&next.source!==source){const wasDoom=source==='doom';await stream.invalidate?.('source-changed');source=next.source;");
  replaceOnce(out,'server/application-host.cjs',"await browserPending?.catch(()=>{});await stopPump();}\n   if(next.controller",
    "await browserPending?.catch(()=>{});await stopPump();if(wasDoom){await remote?.close();remote=null;}}\n   if(next.controller");
  replaceOnce(out,'server/application-host.cjs',"await stopPump();source='browser';await stream.close?.();",
    "await stopPump();await remote?.close();remote=null;source='browser';await stream.close?.();");
  replaceOnce(out,'server/application-host.cjs',"if((action===1||action===3||action===5)",
    "if((action===1||action===2||action===3||action===5)");
  replaceOnce(out,'server/lib/route-gate.cjs',"mode==='handheld'?'wifi':null",
    "mode==='handheld'?'ethernet-or-wifi':null");
  replaceOnce(out,'server/lib/route-gate.cjs',"'waiting-for-wifi'?'Waiting for the portable Wi-Fi connection'",
    "'waiting-for-portable-network'?'Waiting for the portable Wi-Fi or Ethernet connection'");
  replaceOnce(out,'server/lib/route-gate.cjs',":'waiting-for-wifi'};",
    ":'waiting-for-portable-network'};");
  replaceOnce(out,'server/lib/pc-stream-delta.cjs',
    "const host=process.env.HB_STREAM_HOST||'10.42.0.1';if(!net.isIPv4(host)||host==='0.0.0.0')throw Error('Invalid PC stream host');",
    '');
  replaceOnce(out,'server/lib/pc-stream-delta.cjs',
    "report.consoleIP=consoleIP;",
    "report.consoleIP=consoleIP;const host=await require('./mac-stream-host.cjs').select(consoleIP);report.hostIP=host;");
  replaceOnce(out,'switch/modules/pc-screen-input.glsl',"mode==0u?type==1u:type==2u||(policy==1u&&type==1u)",
    "mode==0u?(type==1u||type==2u):type==2u||(policy==1u&&type==1u)");
  replaceOnce(out,'switch/modules/pc-screen-input.glsl',
    'if(start&&(pressed&HB_B)!=0u){c.atlas[CB+1u]=0u;c.library.w=held?1u:0u;menu=0u;}',
    'if(start&&menu==0u){c.atlas[CB+1u]=0u;c.library.w=held?1u:0u;}');
  replaceOnce(out,'switch/modules/pc-screen-draw.glsl',
    'if(!displayReady&&menu==0u)return background;',
    'if(!displayReady&&menu==0u&&c.atlas[SB+38u]==0u)return background;');
  replaceOnce(out,'switch/modules/pc-screen-draw.glsl',
    'return streamMenuDraw(p,color,menu,c.atlas[SB+39u],kind==2u?6u:kind==3u?7u:kind==4u?8u:5u,c.atlas[SB+38u]!=0u);',
    'color=streamMenuDraw(p,color,menu,c.atlas[SB+39u],kind==2u?6u:kind==3u?7u:kind==4u?8u:5u,c.atlas[SB+38u]!=0u);if(menu==0u&&c.atlas[SB+38u]!=0u){float d=box(p,vec2(960,540),vec2(180,56),8);color=mix(color,BLUE,fill(d));color=mix(color,BG,streamStartText(p,vec2(860,512),8.0,0));}return color;');
  replaceOnce(out,'server/lib/pc-screen.html','id="start">Share window ↗</button>',
    'id="start">Share screen or window ↗</button>');
  replaceOnce(out,'server/lib/pc-screen.html','id="browser-start" title=',
    'id="browser-start" hidden title=');
  replaceOnce(out,'server/lib/pc-screen.html','id="stop" disabled>End stream</button>',
    'id="stop" disabled>End stream</button><button id="launch">▶ Play Freedoom</button>');
  replaceOnce(out,'server/lib/pc-screen.html',"$('start').disabled=busy;$('browser-start').disabled=busy;",
    "$('start').disabled=busy||currentSource==='doom';$('start').title=currentSource==='doom'?'End Freedoom before sharing the Mac screen.':'';$('browser-start').disabled=busy;$('launch').disabled=busy||currentSource==='doom';");
  replaceOnce(out,'server/lib/pc-screen.html',"...(launch==='browser'?{source:'browser'}:{})",
    "...(launch===true?{launch:'doom'}:launch==='browser'?{source:'browser'}:{})");
  replaceOnce(out,'server/lib/pc-screen.html',"controller:$('control').checked?'gamepad':'off'",
    "controller:launch==='browser'?'off':$('control').checked?'gamepad':'off'");
  replaceOnce(out,'server/lib/pc-screen.html',"eventFeed.onmessage=async e=>{",
    "let panelPoll=null,polling=false,panelFailures=0;const renderStatus=async e=>{");
  replaceOnce(out,'server/lib/pc-screen.html',
    "window.addEventListener('pagehide',()=>{stop();worker?.terminate();eventFeed?.close();});",
    "window.addEventListener('pagehide',()=>{stop();worker?.terminate();eventFeed?.close();if(panelPoll!==null)clearInterval(panelPoll);});");
  replaceOnce(out,'server/lib/pc-screen.html',
    "panelChannel.onmessage=()=>{inactive=true;eventFeed?.close();stop();$('status').textContent='Panel opened in another tab';};",
    "panelChannel.onmessage=()=>{inactive=true;eventFeed?.close();if(panelPoll!==null)clearInterval(panelPoll);stop();$('status').textContent='Panel opened in another tab';};");
  replaceOnce(out,'server/lib/pc-screen.html',
    "};\neventFeed.onerror=()=>{updateRoute({...routeState,ready:false});if(!inactive){$('connection-badge').textContent='CONNECTION INTERRUPTED';$('status').textContent='Panel connection interrupted. Use STOP in the connection tab if the session is stuck.';}};",
    "};\neventFeed.onmessage=e=>{if(panelPoll!==null){clearInterval(panelPoll);panelPoll=null;}panelFailures=0;return renderStatus(e);};\neventFeed.onerror=()=>{updateRoute({...routeState,ready:false});if(inactive)return;$('connection-badge').textContent='RECONNECTING';$('status').textContent='Reconnecting to the local panel…';if(panelPoll!==null)return;panelPoll=setInterval(async()=>{if(inactive||polling)return;polling=true;try{const response=await fetch('/status',{cache:'no-store'});if(!response.ok)throw Error('Panel status unavailable');panelFailures=0;await renderStatus({data:await response.text()});}catch{if(++panelFailures>=3){$('connection-badge').textContent='CONNECTION INTERRUPTED';$('status').textContent='Local panel unavailable. Return to mac2jb and check the held RPC session.';}}finally{polling=false;}},1500);};");
  replaceOnce(out,'server/lib/pc-screen.html',"$('focus').onclick=focusGame;",
    "$('focus').onclick=focusGame;$('launch').onclick=()=>options(true);");
  replaceOnce(out,'server/lib/pc-screen.html',"if(currentSource==='doom'){\n  $('size').value='320';",
    "if(currentSource==='doom'){\n  $('audio-status').textContent='Freedoom test game is silent in this build.';$('controller-status').textContent=d.sourceError||'Switch controller → Freedoom · A: fire · B: use · Y: run · −: menu';$('size').value='320';");
  replaceOnce(out,'server/lib/pc-screen.html',
    "$('status').textContent=d.sourceError||((d.width||320)+' × '+(d.height||200)+' · '+(d.fps||0)+' fps · '+(d.latencyMs||0)+' ms to GPU · Encode '+(d.encodeMs||0)+' ms · Upload + console '+(d.lastMs||0)+' ms');",
    "$('status').textContent=d.sourceError||(!d.consoleVideoVisible?'Preparing Freedoom video on Switch…':((d.width||320)+' × '+(d.height||200)+' · '+(d.fps||0)+' fps · '+(d.latencyMs||0)+' ms to GPU · Encode '+(d.encodeMs||0)+' ms · Upload + console '+(d.lastMs||0)+' ms'));");
  replaceOnce(out,'server/lib/pc-screen.html',"$('start').onclick=openNativePicker;",
    "$('start').onclick=startCapture;");
  replaceOnce(out,'server/lib/pc-screen.html','<label class="check"><input id="control"',
    '<label class="check" hidden><input id="control"');
  replaceOnce(out,'server/lib/pc-screen.html','<p class="audio-note" id="controller-status" aria-live="polite">Connect your controller to Switch 2. Enable Controller to send input to the PC game.',
    '<p class="audio-note" id="controller-status" aria-live="polite">Browser capture uses the permission dialog. Switch controller input works with bundled Freedoom.');
  replaceOnce(out,'server/lib/pc-screen.html','Native Wayland windows and desktop capture may need two system confirmations.',
    'Select a tab, window, or screen in the browser permission dialog.');
  replaceOnce(out,'server/lib/pc-screen.html','On Wayland, allow restoring this selection to avoid a second confirmation.',
    'Allow screen recording when macOS asks.');
  replaceOnce(out,'server/lib/capture-audio.js',
    'The browser supplied no audio track. Use native window capture for application sound.',
    'The browser supplied no audio track. Choose a source with shared audio in the browser picker.');
  replaceOnce(out,'server/lib/capture-audio.js','No audio track · use native window capture',
    'No audio track · choose a source with shared audio');
  return out;
}

function packagedContents(root){
  const contents=overlay(sourceFiles(root),root);
  for(const name of [...contents.keys()])if(name.split('/').some(part=>part.startsWith('.'))||
    ['tests','test','test-data','node_modules','runtime','data','__pycache__'].some(part=>name.split('/').includes(part))||
    name.endsWith('.izm')||name==='checksums.json')contents.delete(name);
  return contents;
}

function packageBytes(root,archive){
  const contents=packagedContents(root);
  const checks={algorithm:'sha256',files:Object.fromEntries([...contents].map(([name,bytes])=>[name,sha(bytes)]))};
  const bytes=archive.encode([...contents].map(([name,bytes])=>({name,bytes})).concat(
    [{name:'checksums.json',bytes:Buffer.from(JSON.stringify(checks,null,2)+'\n')}]));
  const pkg=archive.inspect(bytes);
  check(pkg.descriptor.id==='blitbun'&&pkg.descriptor.version===VERSION&&
    JSON.stringify(pkg.descriptor.platforms)==='["darwin-arm64"]','Invalid Mac BlitBun package.');
  return {bytes,pkg,contents};
}

function expected(root,archive){
  const {bytes,pkg,contents}=packageBytes(root,archive);
  const prefix='modules/blitbun/';
  const result=new Map([[prefix+'blitbun.izm',bytes]]);
  for(const file of pkg.files)result.set(prefix+'.versions/'+pkg.sha256+'/'+file.name,file.bytes);
  for(const name of pkg.descriptor.switch.files)
    result.set('data/app-links/blitbun/'+name.slice(7),contents.get(name));
  return {files:result,pkg,bytes};
}

function prepare(root,runtime,archive,write){
  const info=expected(root,archive);
  for(const [name,bytes] of info.files)write(path.join(runtime,name),bytes);
  return {sha256:info.pkg.sha256,packageBytes:info.bytes.length};
}

function verify(root,runtime,archive){
  const info=expected(root,archive);
  for(const [name,bytes] of info.files){
    const file=path.join(runtime,name),stat=fs.lstatSync(file);
    check(stat.isFile()&&!stat.isSymbolicLink()&&fs.readFileSync(file).equals(bytes),
      'Changed Mac BlitBun runtime file: '+name);
  }
  return {allowed:new Set(info.files.keys()),sha256:info.pkg.sha256,packageBytes:info.bytes.length};
}

module.exports={REVISION,VERSION,MANIFEST_SHA256,sourceFiles,overlay,packagedContents,packageBytes,expected,prepare,verify};
