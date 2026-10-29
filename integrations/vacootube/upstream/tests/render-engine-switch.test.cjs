const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ownTransport,replaceRenderer}=require('../server/streaming/render-lifecycle.cjs');
test('switch joins the previous renderer before selecting and starting its replacement',async()=>{
 const events=[],callbacks={};for(const name of ['pause','stopEncoder','closeTransport','select','createTransport','startEncoder'])callbacks[name]=async()=>{events.push(name);};
 await replaceRenderer(callbacks);assert.deepEqual(events,Object.keys(callbacks));
 events.length=0;callbacks.closeTransport=async()=>{throw Error('Receiver did not join');};await assert.rejects(replaceRenderer(callbacks),/did not join/);assert.deepEqual(events,['pause','stopEncoder']);
});
test('close waits for receiver preparation and cancels and joins its pending upload',async()=>{
 let releasePrepare,releasePush,closed=false,uploadSettled=false;const events=[];
 const stream=ownTransport({prepare:()=>new Promise(r=>releasePrepare=r),push:()=>new Promise(r=>releasePush=()=>{uploadSettled=true;r();}),close:async()=>{closed=true;releasePush();}});
 const preparing=stream.prepare(),upload=stream.push();await Promise.resolve();
 const closing=stream.close().then(()=>events.push('closed'));await Promise.resolve();assert.equal(closed,false);
 releasePrepare();await preparing;await closing;await upload;assert.equal(uploadSettled,true);assert.equal(closed,true);assert.deepEqual(events,['closed']);await assert.rejects(stream.push(),/closing/);
});
test('Classic is the default, Advanced persists separately without changing resolution',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vacoo-engine-'));try{
 const file=path.join(dir,'render.json'),{open}=require('../server/render-settings.cjs');let settings=await open({file});assert.equal(settings.engine(),'run13');assert.equal(settings.profile().height,720);
 await settings.set(480);await settings.setEngine('run16');settings=await open({file});assert.equal(settings.engine(),'run16');assert.equal(settings.profile().height,480);
 await settings.setEngine('run13');assert.equal(settings.profile().height,480);assert.throws(()=>settings.setEngine('other'),/Unsupported/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('console engine labels are Classic and Advanced while saved IDs stay compatible',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../switch/modules/vacootube-menu.glsl'),'utf8');
 const array=source.match(/engineChars\[\d+\]=uint\[\d+\]\(([^)]+)\)/)[1];
 const text=String.fromCharCode(...array.split(',').map(value=>parseInt(value,10)));
 assert.equal(text,'RENDER ENGINECLASSICADVANCED');
 const renderer=require('../server/streaming/stream.cjs');assert.deepEqual(renderer.ENGINES,['run13','run16']);
});
