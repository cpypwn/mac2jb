'use strict';
const fs=require('node:fs'),path=require('node:path');
const {writeJson,check}=require('./common.cjs');
function start(root,session,version){
 check(/^switch2-[A-Za-z0-9]+$/.test(session),'Invalid setup diagnostic session');
 let warned=false;function safe(operation){try{return operation();}catch(error){if(!warned){console.warn('WARNING: PC setup reporting is unavailable: '+error.message);warned=true;}}}
 const folder=path.join(root,'logs');safe(()=>fs.mkdirSync(folder,{recursive:true,mode:0o700}));
 const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z';
 const file=path.join(folder,stamp+'-'+session+'.install.json');
 const old=(safe(()=>fs.readdirSync(folder))||[]).filter(n=>/^\d{8}T\d{6}Z-switch2-[A-Za-z0-9]+\.install\.json$/.test(n)).sort();
 for(const name of old.slice(0,Math.max(0,old.length-2)))safe(()=>fs.unlinkSync(path.join(folder,name)));
 const state={schema:1,version,session,started:new Date().toISOString(),status:'installing',stage:'starting',phases:[]};
 function mark(stage){const now=new Date().toISOString();const previous=state.phases.at(-1);if(previous&&!previous.finished)previous.finished=now;state.stage=stage;state.phases.push({stage,started:now});safe(()=>writeJson(file,state));}
 function finish(error,details={}){const now=new Date().toISOString(),last=state.phases.at(-1);if(last&&!last.finished)last.finished=now;state.status=error?'stopped':'complete';state.finished=now;state.elapsedMs=Date.parse(now)-Date.parse(state.started);if(error){state.error=String(error.stack||error);if(error.fsCompatibility)state.fsCompatibility=error.fsCompatibility;}Object.assign(state,details);safe(()=>writeJson(file,state));}
 mark('starting');return{file,mark,finish};
}
module.exports={start};
