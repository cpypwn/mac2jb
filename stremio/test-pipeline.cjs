'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {create}=require('./pipeline.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(5);}throw Error('Fixture did not become ready');}
test('actual addon navigation controls media ownership, pause, seek and shutdown',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stremio-pipeline-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const routes={};const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(routes[req.url]||{}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base='http://127.0.0.1:'+server.address().port;
 Object.assign(routes,{'/manifest.json':{id:'fixture',version:'1.0.0',name:'Fixture',resources:['catalog','meta','stream'],types:['movie'],catalogs:[{type:'movie',id:'test'}]},'/catalog/movie/test.json':{metas:[{id:'test',type:'movie',name:'A very long movie title that scrolls under its poster'}]},'/meta/movie/test.json':{meta:{id:'test',type:'movie',name:'A very long movie title that scrolls under its poster'}},'/stream/movie/test.json':{streams:[{url:base+'/video.mp4',name:'Test source'}]}});
 const events=[],instances=[],faults=[],inputEvents=[],navigation=[],marqueeFrames=[];let count=0;
 const graphics={async publish(){count++;return true;},async poll(){return {events:inputEvents.splice(0),activeFrameSeq:count,currentButtons:0};}};
 const audio={async reset(){events.push('reset');},async playedSamples(){return 0;},async write(){events.push('write');},async pause(){events.push('pause');},async resume(){events.push('resume');}};
 const pipeline=await create({graphics,audio,addonUrls:[base+'/manifest.json'],directory,root:path.resolve(__dirname,'..'),quality:'180p',pollIntervalMs:5,onFatal:e=>faults.push(e),onNavigation:()=>navigation.push('tick'),render:async(model,options)=>{if(Number.isFinite(model.titleMarqueeMs))marqueeFrames.push(model.titleMarqueeMs);return Buffer.alloc(options.width*options.height*4);},encode:(_rgba,width,height)=>Buffer.alloc(width*height/2),createDecoder:async(source,options)=>{
  const instance={info:{duration:60,hasAudio:true,codecs:['h264','aac']},async stop(){this.stopped=true;events.push('decoder-stop');},pause(){events.push('decoder-pause');},resume(){events.push('decoder-resume');}};instances.push(instance);
  setImmediate(()=>options.onAudio(Buffer.alloc(19200),{}).then(()=>options.onVideo(Buffer.alloc(320*180*4),{ptsMs:0,index:0})).catch(e=>faults.push(e)));
  return instance;
 }});
 await until(()=>!pipeline.controller.busy&&pipeline.controller.catalogItems.length===1);
 await until(()=>marqueeFrames.length>=2&&marqueeFrames.at(-1)>marqueeFrames[0]);
 assert.equal(navigation.length,0,'caption animation does not make a navigation sound');
 inputEvents.push({buttons:1<<13});
 await until(()=>navigation.length===1);
 inputEvents.push({buttons:1<<13});
 await delay(40);
 assert.equal(navigation.length,1,'An unchanged focus must not retrigger the sound');
 inputEvents.push({buttons:1<<15});
 await until(()=>navigation.length===2);
 await pipeline.controller.handleButton('y');
 for(let n=0;n<3;n++)await pipeline.controller.handleButton('a');
 await until(()=>events.includes('write'));
 inputEvents.push({buttons:1<<14});
 await until(()=>navigation.length===3);
 await pipeline.controller.handleButton('a');assert.ok(events.indexOf('decoder-pause')<events.indexOf('pause'));
 await pipeline.controller.handleButton('a');assert.ok(events.indexOf('resume')<events.indexOf('decoder-resume'));
 await pipeline.controller.handleButton('zr');assert.equal(instances.length,2);assert.equal(instances[0].stopped,true);
 await pipeline.close();assert.equal(instances[1].stopped,true);assert.equal(faults.length,0);assert.ok(count>=1);
 const report=JSON.parse(await fs.readFile(path.join(directory,'stremio-playback.json'),'utf8'));assert.equal(report.stopped,true);assert.equal(report.sourceChanges,2);
});
test('real installed decoder feeds timed movie video and PCM through the controller pipeline',async t=>{
 try{await require('./decoder.cjs').tools();}catch{t.skip('Install Stremio to run the real media pipeline.');return;}
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stremio-real-pipeline-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 let frames=0,pcm=0,start=0,pausedAt=0,pausedTotal=0;const faults=[];
 const graphics={async publish(bytes,_ptsMs,format){assert.equal(bytes.length,require('./bc1.cjs').dimensions(format.width,format.height));frames++;return true;},async poll(){return {events:[],activeFrameSeq:frames,activePtsMs:Math.max(0,Date.now()-start)};}};
 const audio={report:{submittedSamples:0},async reset(){start=0;pausedTotal=0;this.report.submittedSamples=0;},async playedSamples(){return start?Math.max(0,Math.floor(((pausedAt||Date.now())-start-pausedTotal)*48)):0;},async write(bytes){start ||= Date.now();pcm++;this.report.submittedSamples+=bytes.length/4;await delay(100);},async pause(){pausedAt=Date.now();},async resume(){pausedTotal+=Date.now()-pausedAt;pausedAt=0;},async drain(){}};
 const pipeline=await create({graphics,audio,directory,root:path.resolve(__dirname,'..'),pollIntervalMs:50,onFatal:error=>faults.push(error),render:(model,options)=>require('./menu.cjs').renderMenu(model,{...options,python:path.resolve(__dirname,'../.build-gui/homebrew/python/bin/python3'),fontPath:path.resolve(__dirname,'../.build-gui/homebrew/fonts/DejaVuSans.ttf')})});t.after(()=>pipeline.close());
 await until(()=>!pipeline.controller.busy&&pipeline.controller.catalogItems.length===1);
 for(let i=0;i<3;i++)await pipeline.controller.handleButton('a');
 await delay(1200);assert.ok(pcm>=5,'PCM chunks='+pcm);assert.ok(pipeline.report.frames>=5,'frames='+pipeline.report.frames);assert.equal(faults.length,0);
 await pipeline.controller.handleButton('a');await delay(150);await pipeline.controller.handleButton('a');
 await pipeline.close();assert.equal(faults.length,0);assert.equal(pipeline.report.stopped,true);
});
