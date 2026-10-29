const fs=require('node:fs/promises'),path=require('node:path');
async function assertReady(rpc,directory){
 const a=JSON.parse(await fs.readFile(path.join(directory,'launcher-auto.json'))),b=JSON.parse(await fs.readFile(path.join(directory,'launcher-auto-check.json'))),loop=JSON.parse(await fs.readFile(path.join(directory,'launcher-auto-loop.json')));
 if([a,b,loop].some(x=>x.session!==rpc.a.session)||!a.ready||!a.firstShaderFramePresented||!a.scratchRestored||!b.passed||!b.scratchRestored||!loop.threadRunning)throw Error('Post-menu extension requires the original menu to be running');
 if(!(await rpc.request({command:'status'})).ready)throw Error('Console connection unavailable');
 return {session:rpc.a.session,menuReady:a.completed,inputChecks:b.completed,activated:new Date().toISOString(),bootstrapUnchanged:true};
}
module.exports={assertReady};
