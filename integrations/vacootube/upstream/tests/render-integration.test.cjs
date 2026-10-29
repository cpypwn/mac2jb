const {test}=require('node:test'),assert=require('node:assert/strict');
const sizes=require('../server/local-package/render-sizes.cjs');
test('six block-aligned render profiles default to 720p and reject unsupported sizes',()=>{
 assert.equal(sizes.profile().height,720);assert.equal(sizes.profile().width,1280);
 for(const height of sizes.HEIGHTS){const p=sizes.profile(height);assert.equal(p.width%4,0);assert.equal(p.height%4,0);assert.ok(p.width*p.height/2<=0x100000);}
 assert.throws(()=>sizes.profile(1440),/Unsupported/);
});
test('touch uses the current render size and the former hidden menu badge area reaches the player',()=>{
 let current=sizes.profile(),events=[];const input=require('../server/youtube-input.cjs').create(m=>events.push(m),{size:()=>current});
 const p=Buffer.alloc(396);p.writeUInt32LE(2,328);p.writeUInt32LE(0x80000000,332);input.input(p);
 p.writeUInt32LE(1,348);p.writeUInt32LE(80,372);p.writeUInt32LE(60,376);input.input(p);assert.equal(events.at(-1).type,'touch');assert.equal(events.at(-1).phase,'touchStart');
 input.release();current=sizes.profile(1080);input.input(p);assert.equal(events.at(-1).x,120);assert.equal(events.at(-1).y,90);
 input.release();current=sizes.profile(240);input.input(p);assert.equal(events.at(-1).x,27);assert.equal(events.at(-1).y,20);
});
test('frame parser drains old-size replies but accepts only the requested render profile',()=>{
 const {frameReader}=require('../server/local-package/index.cjs'),video={frames:0},report={sourceEpoch:3};let wanted=1080;
 const parse=frameReader(video,report,{accept:f=>f.h===wanted});
 function frame(height,id){const p=sizes.profile(height),header=Buffer.alloc(32);header.write('IYF2');header.writeUInt32LE(p.width*p.height*4,4);header.writeUInt32LE(p.width,8);header.writeUInt32LE(p.height,12);header.writeUInt32LE(id,16);header.writeDoubleLE(Date.now(),24);const data=Buffer.alloc(p.width*p.height*4,id);parse(header.subarray(0,3));parse(header.subarray(3));parse(data);}
 frame(720,1);assert.equal(video.frames,0);assert.equal(report.discardedResponses,1);frame(1080,2);assert.equal(video.latest.h,1080);assert.equal(video.latest.sourceEpoch,3);
 wanted=240;frame(1080,3);frame(240,4);assert.equal(video.frames,2);assert.equal(video.latest.w,428);assert.equal(video.latest.rgba[0],4);
});
