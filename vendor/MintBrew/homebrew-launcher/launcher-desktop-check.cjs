const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
async function main(){
 const source=await fs.readFile(path.join(__dirname,'launcher-check.cjs'),'utf8');
 const literal=source.match(/const cases=(\[[\s\S]*?\n  \]);/);if(!literal)throw Error('Console fixture table not found');
 const cases=vm.runInNewContext(literal[1]),directory=await fs.mkdtemp(path.join(os.tmpdir(),'hb-menu-check-')),report={consoleExecuted:false,cases:[]};
 cases.push({name:'Launcher reaches black before posting the app request',installed:1,count:1,buttons:1,selection:0,want:0,steps:1,wantLaunch:0,wantFading:true});
 for(const [i,t]of cases.entries()){
  const b=Buffer.alloc(1024),steps=t.steps||1;
  for(const [offset,value]of [[8,t.buttons],[32,t.connected===false?0:1],[80,t.selection],[84,t.previous],[92,t.modal],[112,t.count===undefined?3:t.count],[120,t.reserved],[124,t.heldTouch?1:0],[1020,t.installed]])b.writeUInt32LE(value||0,offset);
  b.writeInt32LE(t.stick||0,20);b.writeInt32LE(t.rightStick?.[0]||0,24);b.writeInt32LE(t.rightStick?.[1]||0,28);b.writeFloatLE(t.cooldown||0,76);b.writeFloatLE(t.busy||0,96);b.writeFloatLE(t.requests||0,104);
  if(t.touch){b.writeUInt32LE(1,136);b.writeUInt32LE(t.ending?2:0,152);b.writeUInt32LE(t.touch[0],160);b.writeUInt32LE(t.touch[1],164);}
  if(t.pointer){b.writeFloatLE(t.pointer[0],816);b.writeFloatLE(t.pointer[1],820);}
  b.writeUInt32LE(t.pointerInit?1:0,784);b.writeUInt32LE(t.pointerActive?1:0,788);
  const initial=path.join(directory,i+'-initial.bin'),input=path.join(directory,i+'-input.bin'),output=path.join(directory,i+'-output.bin');
  await fs.writeFile(initial,b);await fs.writeFile(input,Buffer.concat(Array.from({length:steps},()=>b.subarray(0,64))));
  try{
   execFileSync(path.join(__dirname,'game-compute-check'),[initial,output,path.join(__dirname,'shaders/launcher.comp.spv'),input,String(steps)],{stdio:['ignore','pipe','pipe']});
   const r=await fs.readFile(output),u=o=>r.readUInt32LE(o),f=o=>r.readFloatLE(o);
   const passed=(!t.wantFading||f(964)===1)&&(t.wantTicks===undefined||u(976)===t.wantTicks)&&u(80)===t.want&&f(68)===t.want&&u(92)===(t.wantModal||0)&&u(88)===steps&&f(64)>0&&
    (f(96)>0)===!!t.wantBusy&&f(104)===(t.wantRequests||0)&&f(108)===(t.wantCompletions||0)&&
    (t.wantBusy?f(100)>0:f(100)===0)&&u(120)===(t.wantReserved||0)&&u(116)===(t.wantPreview||0)&&
    u(112)===(t.wantCount===undefined?(t.count===undefined?3:t.count):t.wantCount)&&(t.wantLaunch===undefined||u(1012)===t.wantLaunch)&&
    u(1008)===(t.wantDark||0)&&(t.wantDarkLevel===undefined||f(968)>=t.wantDarkLevel)&&
    (t.wantPointerX===undefined||f(816)===t.wantPointerX)&&(t.wantPointerY===undefined||f(820)===t.wantPointerY)&&(t.wantCursor===undefined||u(1004)===t.wantCursor);
   report.cases.push({name:t.name,passed,selection:u(80),ticks:u(976),launch:u(1012),dark:u(1008)});
  }catch(error){report.cases.push({name:t.name,passed:false,error:error.message});}
 }
 report.passed=report.cases.every(t=>t.passed);await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));console.log('Evidence: '+directory);if(!report.passed)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
