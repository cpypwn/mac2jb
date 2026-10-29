'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createController}=require('./controller.cjs');
const {closeArtworkCache,createMenuRenderer}=require('./menu.cjs');
const decoderTools=require('./decoder.cjs'),codec=require('./bc1.cjs');
const {MENU_WIDTH,MENU_HEIGHT}=require('./protocol.cjs');
const {qualityProfile}=require('./quality.cjs');
const {composite}=require('./overlay.cjs');
const subtitleTools=require('./subtitles.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const BUTTONS=[[0,'a'],[1,'b'],[2,'x'],[3,'y'],[6,'l'],[7,'r'],[8,'zl'],[9,'zr'],[10,'plus'],
 [12,'left'],[13,'up'],[14,'right'],[15,'down'],[16,'left'],[17,'up'],[18,'right'],[19,'down']];
function navigationKey(controller){
 const {view,selected,catalogIndex,tabSelected,sidebarSelected,section,focusArea,overlay}=controller;
 return [view,selected,catalogIndex,tabSelected,sidebarSelected,section,focusArea,
  overlay?.visible,overlay?.focused,overlay?.mode,overlay?.optionSelected].join('|');
}
async function create({graphics,audio,addonUrls=[],libraryItems=[],sourcePreferences,directory,root,onAccountProgress=()=>{},onFatal=()=>{},onProgress=()=>{},
 onNavigation=()=>{},createDecoder=decoderTools.create,render,encode=codec.encode,pollIntervalMs=50,quality}){
 const profile=qualityProfile(quality),format={width:profile.width,height:profile.height};
 const ownedRenderer=render?null:createMenuRenderer();render ||= ownedRenderer;
 let controller,decoder,currentSource,sourceInfo,playing=false,paused=false,seeking=false,position=0,wallStart=0,pausedAt=0,audioStarted=false,menuRevision=0;
 let generation=0,closed=false,dirty=true,tickBusy=false,timer,clockAt=0,clockValue=0,sourceBaseSamples=0,sourceOffset=0,clockOffset=0,lastAudioCount=0,startupAbort,currentTick=Promise.resolve(),lastInfo="",lastSave=0,firstFrame=false,firstMediaSequence=Infinity,progressWaiting=false,pendingProgressSnapshot,controls=Promise.resolve();
 let overlayFrame,lastFrame,displayTail=Promise.resolve(),stopTail=Promise.resolve(),stopFailure,pendingControls=0,axisAt=Date.now(),heldName='',heldSince=0,heldRepeat=0;
 let overlayKey='',overlayTail=Promise.resolve(),sourceEpoch=0,subtitleAbort,subtitleSelection=0,subtitleTracks=[],subtitleCues=[],selectedSubtitleId=null,selectedAudioId;
 let lastInputOverruns=0,touchWasDown=false,navigationSoundFailed=false;
 let marqueeKey='',marqueeStartedAt=0,marqueeRenderedAt=0;
 const acceptedTimes=[];
 const report={started:new Date().toISOString(),quality:profile.id,targetWidth:profile.width,targetHeight:profile.height,targetFPS:profile.fps,
  menuWidth:MENU_WIDTH,menuHeight:MENU_HEIGHT,frames:0,overlayFrames:0,droppedFrames:0,droppedInputActions:0,sourceChanges:0,position:0,resourcesRetained:true};
 const builtin=await require('./builtin.cjs').create({root});
 const effectiveAddons=[builtin.manifestURL,...addonUrls];
 const reporter=require('./progress.cjs').createReporter({session:path.basename(directory),emit:update=>{if(!update.itemId.startsWith('mac2jb:'))onAccountProgress(update);}});
 const reportFile=path.join(directory,'stremio-playback.json');
 const background=new Set();
 function defer(task){const pending=new Promise(resolve=>setImmediate(resolve)).then(task);background.add(pending);pending.catch(onFatal).finally(()=>background.delete(pending));}
 const save=()=>fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 function progressState(){
  if(progressWaiting&&pendingProgressSnapshot)return {...pendingProgressSnapshot};
  let actual=position;
  if(playing&&!paused){
   // cap progress while native requests are stalled.
   if(sourceInfo?.hasAudio&&clockAt)actual=clockValue+Math.min(.5,Math.max(0,(Date.now()-clockAt)/1000));
   else actual=report.displayAcknowledgedPosition??sourceOffset;
  }
  return {position:Math.max(0,Math.min(sourceInfo?.duration||Infinity,actual)),duration:sourceInfo?.duration||0,paused};
 }
 const native=async task=>{try{return await task();}catch(error){onFatal(error);throw error;}};
 function display(task){const result=displayTail.then(task);displayTail=result.catch(()=>{});return result;}
 function frameModel(ptsMs){const model=controller.getMenuModel();model.subtitleLines=subtitleTools.cueAt(subtitleCues,Math.max(0,ptsMs/1000));return model;}
 function playerLayer(model,attempt){
  const visible=Boolean(model.playbackOverlay?.visible),lines=model.subtitleLines||[];
  const key=JSON.stringify([visible?model.playbackOverlay:null,lines,sourceEpoch]);
  const result=overlayTail.then(async()=>{
   if(closed||attempt!==generation)return undefined;
   if(key===overlayKey)return overlayFrame;
   const layer=visible||lines.length?await render(model,{...renderOptions,...format,overlay:true}):undefined;
   if(closed||attempt!==generation)return undefined;
   overlayKey=key;overlayFrame=layer;return layer;
  });
  overlayTail=result.catch(()=>{});return result;
 }
 async function publishVideo(frame,attempt,mediaFrame=true){
  return display(async()=>{
   if(closed||attempt!==generation||(!playing&&!seeking))return false;
   const layer=await playerLayer(frameModel(frame.ptsMs),attempt);
   if(closed||attempt!==generation||(!playing&&!seeking))return false;
   const before=performance.now();
   const rgba=layer?composite(frame.rgba,layer,profile.width,profile.height):frame.rgba;
   const encoded=encode(rgba,profile.width,profile.height);report.lastEncodeMs=performance.now()-before;
   const uploadAt=performance.now();
   const accepted=await native(()=>graphics.publish(encoded,Math.round(frame.ptsMs),format));
   // a seek retires its decoder before draining an in-flight upload.
   // the old upload cannot update the replacement's state.
   if(closed||attempt!==generation)return false;
   report.lastUploadMs=performance.now()-uploadAt;
   if(accepted){
    if(mediaFrame){report.frames++;acceptedTimes.push(Date.now());while(acceptedTimes.length&&acceptedTimes[0]<Date.now()-10000)acceptedTimes.shift();
     report.measuredFPS=acceptedTimes.length>1?(acceptedTimes.length-1)*1000/(acceptedTimes.at(-1)-acceptedTimes[0]||1):0;}
    else report.overlayFrames++;
    if(!firstFrame)firstMediaSequence=graphics.publishedFrameSeq??0;firstFrame=true;
   }else if(mediaFrame)report.droppedFrames++;
   return accepted;
  });
 }
 function queueControl(action,{repeat=false}={}){
  if(closed||controller.busy||pendingControls>=(repeat?1:4)){report.droppedInputActions++;return false;}
  pendingControls++;
  controls=controls.then(async()=>{
   if(closed)return;
   const before=navigationKey(controller);
   await action();
   if(!closed&&navigationKey(controller)!==before)Promise.resolve().then(onNavigation).catch(()=>{
    if(!navigationSoundFailed){navigationSoundFailed=true;onProgress('Navigation sound is unavailable.');}
   });
  }).catch(()=>onProgress('The selected action could not finish.')).finally(()=>pendingControls--);
  return true;
 }
 async function stopPlayback(reset=true,{preserveFrame=false}={}){
  const ownership=++generation;startupAbort?.abort();playing=false;paused=false;
  seeking=preserveFrame&&Boolean(lastFrame);if(!preserveFrame)lastFrame=undefined;
  overlayFrame=undefined;overlayKey='';dirty=true;
  const old=decoder;decoder=undefined;
  const stopped=stopTail.then(async()=>{
   if(stopFailure)throw stopFailure;
   if(old)await old.stop();
   if(ownership!==generation)return false;
   if(reset)await native(()=>audio.reset());
   if(ownership!==generation)return false;
   dirty=true;return ownership;
  }).catch(error=>{stopFailure ||= error;throw error;});
  stopTail=stopped.catch(()=>{});return stopped;
 }
 async function start(source,startPosition=source?.resumePosition||0,isSeek=false,{audioTrackId=selectedAudioId,preservePaused=paused}={}){
  if(closed)return;
  const previousProgress=progressState();
  if(isSeek){pendingProgressSnapshot={position:startPosition,duration:sourceInfo?.duration||previousProgress.duration,paused:true};reporter.update(pendingProgressSnapshot,{reason:'seek'});}
  else{reporter.update(previousProgress,{reason:'stop'});pendingProgressSnapshot=undefined;}
  progressWaiting=true;
  const keepFrame=Boolean(lastFrame)&&controller.view==='playing';
  if(!isSeek){sourceEpoch++;subtitleSelection++;subtitleAbort?.abort();subtitleAbort=new AbortController();subtitleTracks=[];subtitleCues=[];selectedSubtitleId=null;selectedAudioId=undefined;audioTrackId=undefined;preservePaused=false;
   controller.setMediaTracks?.({audioTracks:[],subtitleTracks:[],selectedSubtitleId:null});}
  const stoppedGeneration=await stopPlayback(true,{preserveFrame:keepFrame});if(closed||stoppedGeneration!==generation)return;
  if(keepFrame)controller.updatePlayback?.({seeking:true});
  sourceOffset=startPosition;clockOffset=startPosition;lastAudioCount=0;currentSource=source;position=startPosition;sourceInfo=null;audioStarted=false;wallStart=0;clockAt=0;firstFrame=false;firstMediaSequence=Infinity;delete report.displayAcknowledgedPosition;report.sourceChanges++;
  const baseSamples=await native(()=>audio.playedSamples());if(closed||stoppedGeneration!==generation)return;
  sourceBaseSamples=baseSamples;const attempt=++generation;
  startupAbort=new AbortController();
  const callbacks={position:startPosition,quality:profile.id,audioTrackId,signal:startupAbort.signal,
   onVideo:async(rgba,frame)=>{
    if(closed||attempt!==generation)return;
    while(sourceInfo?.hasAudio&&!audioStarted&&!closed&&attempt===generation)await delay(5);
    if(closed||attempt!==generation||paused)return;
    wallStart ||= Date.now();const expected=wallStart+frame.index*1000/decoderTools.FPS;
    if(expected>Date.now())await delay(expected-Date.now());
    if(closed||attempt!==generation||paused)return;
    position=frame.ptsMs/1000;const lag=Date.now()-expected;
    if(lag>1000/decoderTools.FPS*2){report.droppedFrames++;return;}
    if(!Buffer.isBuffer(rgba)||rgba.length!==profile.width*profile.height*4)throw Error('The decoder returned a frame with the wrong quality dimensions.');
    const owned={rgba:Buffer.from(rgba),ptsMs:frame.ptsMs};lastFrame=owned;
    const accepted=await publishVideo(owned,attempt);
    if(closed||attempt!==generation)return;
    if(accepted&&seeking){seeking=false;controller.updatePlayback?.({seeking:false});dirty=true;}
   },
   onAudio:async pcm=>{
    if(closed||attempt!==generation)return;
    await native(()=>audio.write(pcm));
    if(!audioStarted){audioStarted=true;wallStart ||= Date.now();}
   },
   onError:error=>defer(async()=>{
    if(!closed&&attempt===generation){reporter.update(progressState(),{reason:'stop'});const stoppedGeneration=await stopPlayback();if(!closed&&stoppedGeneration===generation)controller.playbackFailed('This source could not be decoded or is no longer available.');}
   }),
   onEnd:()=>defer(async()=>{
    while(paused&&!closed&&attempt===generation)await delay(20);
    if(closed||attempt!==generation)return;
    if(sourceInfo?.hasAudio&&audio.drain)await native(()=>audio.drain());
    if(!closed&&attempt===generation){reporter.update({...progressState(),position:sourceInfo?.duration||position,paused:false},{reason:'ended'});const stoppedGeneration=await stopPlayback();if(!closed&&stoppedGeneration===generation)controller.playbackEnded();}
   })
  };
  let opened;
  try{opened=await createDecoder(source,callbacks);}catch(error){
   if(!closed&&attempt===generation){reporter.update(progressState(),{reason:'stop'});progressWaiting=false;pendingProgressSnapshot=undefined;seeking=false;lastFrame=undefined;controller.playbackFailed('This source could not start. Choose a supported source.');}
   throw error;
  }
  if(closed||attempt!==generation){await opened.stop();return;}
  decoder=opened;sourceInfo=opened.info;playing=true;paused=Boolean(preservePaused);progressWaiting=false;pendingProgressSnapshot=undefined;
  selectedAudioId=sourceInfo.audioTrackId??undefined;
  controller.setMediaTracks?.({audioTracks:sourceInfo.audioTracks||[],selectedAudioId});
  if(paused){decoder.pause();await native(()=>audio.pause());
   // paused playback cannot supply the new frame that normally clears seeking.
   seeking=false;controller.updatePlayback?.({seeking:false});}
  if(isSeek)reporter.update({position:startPosition,duration:sourceInfo.duration||0,paused},{reason:'pause'});
  else reporter.begin(source,{position:startPosition,duration:sourceInfo.duration||0});
  report.duration=sourceInfo.duration;report.hasAudio=sourceInfo.hasAudio;report.codecs=sourceInfo.codecs;
  report.sourceWidth=sourceInfo.sourceWidth;report.sourceHeight=sourceInfo.sourceHeight;dirty=true;
  if(!isSeek){const epoch=sourceEpoch,signal=subtitleAbort.signal;
   defer(async()=>{try{
    const tracks=await controller.addons.subtitles(source.meta.type,source.meta.videoId);
    if(!closed&&epoch===sourceEpoch&&!signal.aborted){subtitleTracks=tracks;controller.setMediaTracks?.({subtitleTracks,selectedSubtitleId:null});}
   }catch(error){if(!closed&&epoch===sourceEpoch&&!signal.aborted)onProgress('Subtitle add-on lookup could not finish.');}});
  }
 }
 async function pause(){
  if(!decoder||!playing)return;
  if(!paused){position=progressState().position;paused=true;pausedAt=Date.now();decoder.pause();await native(()=>audio.pause());}
  else{
   await native(()=>audio.resume());
   const samples=await native(()=>audio.playedSamples());
   sourceBaseSamples=samples;lastAudioCount=samples;clockOffset=position;clockValue=position;clockAt=Date.now();
   wallStart=clockAt-(position-sourceOffset)*1000;paused=false;decoder.resume();
  }
  reporter.update(progressState(),{reason:'pause'});dirty=true;
 }
 async function seekTo(seconds){if(!currentSource||!playing||!Number.isFinite(seconds))return;const target=Math.max(0,Math.min(sourceInfo?.duration?Math.max(0,sourceInfo.duration-.1):Infinity,seconds));await start(currentSource,target,true);}
 async function seek(seconds){return seekTo(progressState().position+seconds);}
 async function selectAudio(id){
  if(!sourceInfo?.audioTracks?.some(track=>track.id===id))throw Error('That audio language is unavailable in this source.');
  if(id===selectedAudioId)return;
  await start(currentSource,progressState().position,true,{audioTrackId:id,preservePaused:paused});
 }
 async function selectSubtitle(id){
  const epoch=sourceEpoch,selection=++subtitleSelection;
  if(id===null){selectedSubtitleId=null;subtitleCues=[];overlayKey='';dirty=true;menuRevision++;return;}
  const track=subtitleTracks.find(track=>track.id===id);if(!track)throw Error('That subtitle track is unavailable.');
  const cues=await subtitleTools.loadSubtitle(track,{signal:subtitleAbort?.signal});
  if(closed||epoch!==sourceEpoch||selection!==subtitleSelection)return;
  selectedSubtitleId=id;subtitleCues=cues;overlayKey='';dirty=true;menuRevision++;
 }
 controller=createController({addonUrls:effectiveAddons,libraryItems,sourcePreferences,callbacks:{play:source=>start(source),pause,seek,seekTo,selectAudio,selectSubtitle,stop:async()=>{const state=progressState();reporter.update(state,{reason:'stop'});controller.setPlaybackInfo(state);await stopPlayback();}},
  onChange:()=>{dirty=true;menuRevision++;},onLog:message=>onProgress(message)});
 const onArtworkReady=()=>{if(!closed){dirty=true;menuRevision++;}};
 const renderOptions={python:path.join(root,'homebrew/python/bin/python3'),fontPath:path.join(root,'homebrew/fonts/DejaVuSans.ttf')};
 async function drawMenu(){
  const revision=menuRevision;
  if(playing||seeking&&lastFrame){
   const attempt=generation,model=frameModel(lastFrame?.ptsMs??Math.round(position*1000));
   await playerLayer(model,attempt);
   if(closed||attempt!==generation||(!playing&&!seeking))return;
   if(lastFrame&&(paused||seeking||model.playbackOverlay?.previewKind)){dirty=!(await publishVideo(lastFrame,attempt,false))||revision!==menuRevision;}
   else dirty=revision!==menuRevision;
   return;
  }
  const renderAt=performance.now(),model=controller.getMenuModel();
  if(marqueeKey)model.titleMarqueeMs=Date.now()-marqueeStartedAt;
  const rgba=await render(model,{...renderOptions,width:MENU_WIDTH,height:MENU_HEIGHT,fetchImages:true,onArtworkReady});
  report.lastMenuRenderMs=performance.now()-renderAt;
  if(closed||playing||seeking&&lastFrame)return;
  const published=await display(()=>native(()=>graphics.publish(encode(rgba,MENU_WIDTH,MENU_HEIGHT),Math.round(position*1000),{width:MENU_WIDTH,height:MENU_HEIGHT})));
  if(published)marqueeRenderedAt=Date.now();
  dirty=!published||revision!==menuRevision;
 }
 async function tick(){
  if(closed||tickBusy)return;tickBusy=true;
  try{
   const state=await native(()=>graphics.poll());
   const held=Number(state.currentButtons)||0;
   const inPlayer=controller.view==='playing',scrubControls=inPlayer&&controller.overlay?.mode==='controls';
   const heldSeek={backward:Boolean(held&(1<<8)),forward:Boolean(held&(1<<9)),left:Boolean(held&(1<<16)),right:Boolean(held&(1<<18))};
   const overrun=Number(state.inputOverruns)||0;
   if(overrun!==lastInputOverruns){controller.cancelSeekGesture?.();lastInputOverruns=overrun;}
   for(const event of state.events||[]){
    if(event.touch){
     // a snapshot must not recapture a finger whose first tap revealed controls.
     if(['start','down','tap'].includes(event.touch.phase))touchWasDown=true;
     else if(['end','up','cancel'].includes(event.touch.phase))touchWasDown=false;
     queueControl(()=>controller.handleTouch(event.touch));continue;
    }
    const names=new Set(BUTTONS.filter(([bit])=>{
     if(!(event.buttons&(1<<bit)))return false;
     if(scrubControls&&[16,18].includes(bit))return false;
     if(scrubControls&&[8,9].includes(bit)&&held&(1<<bit))return false;
     return true;
    }).map(([,name])=>name));
    if(scrubControls){
     if(event.buttons&(1<<16)&&!(held&(1<<16)))names.add('seekLeft');
     if(event.buttons&(1<<18)&&!(held&(1<<18)))names.add('seekRight');
    }
    if(!Number.isFinite(state.rightStickX)){if(event.buttons&(1<<20))names.add('seekLeft');if(event.buttons&(1<<22))names.add('seekRight');}
    for(const name of names)queueControl(()=>controller.handleButton(name));
   }
   const now=Date.now(),axisSeconds=Math.min(.25,Math.max(0,(now-axisAt)/1000));axisAt=now;
   if(inPlayer)queueControl(async()=>{
    if(scrubControls)await controller.handleHeldSeek?.(heldSeek,axisSeconds);
    if(Number.isFinite(state.rightStickX)&&!controller.busy)await controller.handleSeekAxis(state.rightStickX,axisSeconds);
    if(state.touch&&!controller.busy){
     const point={x:state.touch.x,y:state.touch.y};
     if(controller.seekGesture?.owner==='touch')await controller.handleTouch({...point,phase:state.touch.active?'move':'end'});
     else if(state.touch.active&&!touchWasDown&&controller.overlay?.visible&&scrubControls)await controller.handleTouch({...point,phase:'start'});
     touchWasDown=state.touch.active;
    }
   },{repeat:true});
   const repeatName=(held&(1<<12))?'left':(held&(1<<13))?'up':(held&(1<<14))?'right':(held&(1<<15))?'down':
    (!scrubControls&&held&(1<<16))?'left':(held&(1<<17))?'up':(!scrubControls&&held&(1<<18))?'right':(held&(1<<19))?'down':'';
   if(repeatName!==heldName){heldName=repeatName;heldSince=heldRepeat=now;}
   else if(heldName&&now-heldSince>=450&&now-heldRepeat>=200&&!controller.busy&&pendingControls===0){
    const repeatAction=heldName;
    if(queueControl(()=>controller.handleButton(repeatAction),{repeat:true}))heldRepeat=now;
   }
   controller.tickOverlay();
   if(playing&&firstFrame&&state.activeFrameSeq>=firstMediaSequence)report.displayAcknowledgedPosition=state.activePtsMs/1000;
   if(playing&&sourceInfo?.hasAudio&&audioStarted&&!paused&&Date.now()-clockAt>=500){
    const count=await native(()=>audio.playedSamples());
    if(count<sourceBaseSamples||count<lastAudioCount){sourceBaseSamples=count;clockOffset=position;}lastAudioCount=count;
    clockValue=clockOffset+(count-sourceBaseSamples)/48000;clockAt=Date.now();
    report.audioPosition=clockValue;
    if(firstFrame&&state.activeFrameSeq>=firstMediaSequence){report.displayAcknowledgedPosition=state.activePtsMs/1000;report.avDriftMs=Math.round((report.displayAcknowledgedPosition-clockValue)*1000);}
    wallStart=clockAt-(clockValue-sourceOffset)*1000;
   }
   if(playing){reporter.update(progressState());const info={position:Math.floor(position),duration:sourceInfo?.duration||0,paused,seeking};const value=JSON.stringify(info);if(value!==lastInfo){lastInfo=value;controller.setPlaybackInfo(info);}}
   const focusedTitle=controller.view==='catalog'&&controller.focusArea==='content'?
    String(controller.catalogItems[controller.selected]?.name||''):'';
   const nextMarqueeKey=focusedTitle.length>=11?controller.catalogIndex+':'+controller.selected+':'+focusedTitle:'';
   if(nextMarqueeKey!==marqueeKey){marqueeKey=nextMarqueeKey;marqueeStartedAt=now;marqueeRenderedAt=0;}
   else if(marqueeKey&&now-marqueeRenderedAt>=125)dirty=true;
   if(dirty)await drawMenu();
   if(Date.now()-lastSave>2000){report.position=position;report.paused=paused;report.playing=playing;report.firstMediaFrameUploaded=firstFrame;await save();lastSave=Date.now();}
  }catch(error){if(!closed)onFatal(error);}finally{tickBusy=false;}
 }
 try{await drawMenu();await save();}catch(error){closed=true;controller.close?.();await ownedRenderer?.close();await builtin?.close();await closeArtworkCache();throw error;}
 timer=setInterval(()=>{if(!tickBusy&&!closed){currentTick=tick();currentTick.catch(onFatal);}},pollIntervalMs);timer.unref();
 controller.init().catch(error=>onProgress('The add-on catalog could not load.'));
 return {controller,report,async close(){
  if(closed)return;reporter.close(progressState());closed=true;clearInterval(timer);generation++;startupAbort?.abort();subtitleAbort?.abort();controller.close?.();
  await ownedRenderer?.close();
  await controls.catch(()=>{});
  if(decoder)await decoder.stop();decoder=undefined;
  await currentTick;
  await displayTail;
  await overlayTail;
  while(background.size)await Promise.allSettled([...background]);
  await builtin?.close();
  await closeArtworkCache();
  report.completed=new Date().toISOString();report.stopped=true;await save();
 }};
}
module.exports={create,BUTTONS};
