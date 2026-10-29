#!/usr/bin/env node
'use strict';
// Local, explicitly armed keyboard input. Never record typed keys or replay
// input after the device has reported readiness.
const {spawn}=require('node:child_process');
const path=require('node:path');
const {autoControllers}=require('./usb-controllers.cjs');
const MAX_TEXT_BYTES=16*1024,MAX_RECORD_BYTES=MAX_TEXT_BYTES*6+256;
const neutral=Buffer.alloc(8);
function prepareText(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||
    !Object.hasOwn(value,'text')||!Object.hasOwn(value,'delayMs')||typeof value.text!=='string')
    throw Error('Send text needs a text value and a typing delay.');
  if(!Number.isInteger(value.delayMs)||value.delayMs<1||value.delayMs>2000)
    throw Error('Choose a typing delay from 1 to 2,000 ms.');
  if(!value.text.length)throw Error('Enter some text to send.');
  if(Buffer.byteLength(value.text,'utf8')>MAX_TEXT_BYTES)throw Error('Send at most 16 KiB of text at a time.');
  const text=value.text.replace(/\r\n/g,'\n'),reports=[];
  // Match sender.c's US layout, including SmileBASIC's inverted letter case.
  const unshifted="-=[]\\;',./`",shifted='_+{}|:"<>?~',codes=[45,46,47,48,49,51,52,54,55,56,53];
  for(const character of text) {
    const code=character.charCodeAt(0);let key,mods=0,index;
    if(code>=97&&code<=122){key=4+code-97;mods=2;}
    else if(code>=65&&code<=90)key=4+code-65;
    else if(code>=49&&code<=57)key=30+code-49;
    else if(character==='0')key=39;
    else if(character==='\n')key=40;
    else if(character==='\t')key=43;
    else if(character===' ')key=44;
    else if((index=unshifted.indexOf(character))>=0)key=codes[index];
    else if((index=shifted.indexOf(character))>=0){key=codes[index];mods=2;}
    else if((index='!@#$%^&*()'.indexOf(character))>=0){key=index===9?39:30+index;mods=2;}
    else throw Error('Use printable ASCII text, tabs and line breaks only. Nothing was typed.');
    reports.push(Buffer.from([mods,0,key,0,0,0,0,0]));
  }
  return {reports,total:reports.length,delayMs:value.delayMs};
}
function validReport(report) {
  if(!Array.isArray(report)||report.length!==8||Array.from(report).some(n=>!Number.isInteger(n)||n<0||n>255)||report[1]!==0)return false;
  let empty=false;const keys=new Set();
  for(const key of report.slice(2)){if(!key){empty=true;continue;}if(empty||key<4||key>0x73||keys.has(key))return false;keys.add(key);}
  return true;
}
async function main(args=process.argv.slice(2),options={}) {
  if(args.length===1&&args[0]==='--self-test') {
    const value=prepareText({text:'aA$()\r\n\t',delayMs:10});
    const expected=[[2,4],[0,4],[2,33],[2,38],[2,39],[0,40],[0,43]];
    if(value.total!==expected.length||value.reports.some((report,index)=>!validReport([...report])||
      report[0]!==expected[index][0]||report[2]!==expected[index][1]))throw Error('Keyboard text encoding check failed.');
    const emit=options.emit||((type,fields)=>process.stdout.write(JSON.stringify({type,...fields})+'\n'));
    emit('self-test',{message:'Keyboard text encoding passed. No USB input sent.'});return 0;
  }
  const mode=args[0],controller=args[1],remaining=args.slice(2);
  const text=remaining.length&&!remaining[0].startsWith('--')?remaining.shift():'4',timeout=Number(text);
  let preferredController;
  while(remaining.length) {
    const option=remaining.shift(),value=remaining.shift();
    if(option!=='--preferred-controller'||preferredController!==undefined||!/^usb-drd(?:[0-9]|1[0-5])$/.test(value||''))throw Error('Invalid keyboard settings.');
    preferredController=value;
  }
  if(args.length<2||mode!=='live'||
    !(controller==='auto'||/^usb-drd(?:[0-9]|1[0-5])$/.test(controller))||!/^\d+$/.test(text)||
    !Number.isInteger(timeout)||timeout<1||timeout>120||(preferredController!==undefined&&controller!=='auto'))throw Error('Invalid keyboard settings.');
  const candidates=controller==='auto'?autoControllers(preferredController):[controller];
  let safeFailures=0;
  const root=options.root||path.resolve(__dirname,'..'),input=options.input||process.stdin;
  let child,childDone,ready=false,stopping=false,pending='',written=false,stopTimer,failure='',outputClosed=false,textJob,textTask;
  let submittedReports=0,acknowledgedReports=0;
  const emitter=options.emit||((type,fields={})=>process.stdout.write(JSON.stringify({type,...fields})+'\n'));
  function emit(type,fields={}) {if(!outputClosed)try{emitter(type,fields);}catch{pipeError();}}
  function terminate(owned) {
    if(!owned)return;
    try{if(!owned.stdin.destroyed&&!owned.stdin.writableEnded)owned.stdin.end(Buffer.alloc(8));}catch{}
    try{owned.kill('SIGTERM');}catch{}
    if(!stopTimer){stopTimer=setTimeout(()=>{try{owned.kill('SIGKILL');}catch{}},2000);stopTimer.unref();}
  }
  function cancelText() {
    if(!textJob)return;
    textJob.cancelled=true;clearTimeout(textJob.timer);textJob.resume?.(false);
    clearTimeout(textJob.ackTimer);textJob.ackResume?.(false);
  }
  function stop(){if(stopping)return;stopping=true;cancelText();terminate(child);}
  function rejectInput(message='Keyboard input was rejected. Forwarding stopped; inspect the Switch before reconnecting.') {
    if(!failure)failure=message;
    stop();
  }
  function pipeError(){outputClosed=true;rejectInput('The keyboard control connection closed. Inspect the Switch before reconnecting.');}
  function writeReport(report) {
    if(stopping||!ready)return false;
    written=true;
    try {
      submittedReports++;
      if(!child.stdin.write(report)) {
        rejectInput('Keyboard input exceeded its buffer limit. Forwarding stopped; inspect the Switch before reconnecting.');return false;
      }
      return true;
    } catch {rejectInput('The keyboard input connection closed. Inspect the Switch before reconnecting.');return false;}
  }
  function startText(prepared) {
    const job={cancelled:false},owned=child;let sent=0,lastProgress=performance.now();
    textJob=job;
    const active=()=>!job.cancelled&&!stopping&&ready&&child===owned;
    const pause=()=>new Promise(resolve=>{
      job.resume=resolve;job.timer=setTimeout(()=>{job.resume=undefined;resolve(true);},prepared.delayMs);
    });
    const delivered=()=>new Promise(resolve=>{
      if(!active()){resolve(false);return;}
      const target=submittedReports;
      if(acknowledgedReports>=target){resolve(true);return;}
      job.ackTarget=target;job.ackResume=resolve;
      job.ackTimer=setTimeout(()=>{
        job.ackResume=undefined;resolve(false);
        rejectInput('The keyboard did not confirm text delivery. Forwarding stopped; inspect the Switch before reconnecting.');
      },options.ackTimeoutMs??2000);
    });
    textTask=(async()=>{
      emit('keyboard-text-started',{total:prepared.total});
      if(!active()||!writeReport(neutral)||!await delivered())return;
      for(const report of prepared.reports) {
        if(!active()||!writeReport(report)||!writeReport(neutral)||!await delivered())return;
        sent++;
        const now=performance.now();
        if(sent===prepared.total||now-lastProgress>=100) {
          emit('keyboard-text-progress',{sent,total:prepared.total});lastProgress=now;
        }
        if(!active()||!await pause())return;
      }
      if(active()){textJob=undefined;emit('keyboard-text-completed',{sent,total:prepared.total});}
    })().catch(()=>rejectInput('Text input stopped. Inspect the Switch before reconnecting.')).finally(()=>{
      clearTimeout(job.timer);clearTimeout(job.ackTimer);job.resume=undefined;job.ackResume=undefined;
      if(textJob===job)textJob=undefined;
    });
  }
  function data(bytes) {
    if(stopping)return;
    if(Buffer.byteLength(bytes)>MAX_RECORD_BYTES){rejectInput();return;}
    pending+=bytes;
    let at;
    while((at=pending.indexOf('\n'))>=0) {
      if(stopping)return;
      const line=pending.slice(0,at);pending=pending.slice(at+1);let value;
      try{if(Buffer.byteLength(line)>MAX_RECORD_BYTES)throw Error();value=JSON.parse(line);}catch{rejectInput();return;}
      if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'text')) {
        // Do not queue or replay another request during an accepted transfer.
        if(textJob)continue;
        let prepared;
        try{prepared=prepareText(value);}catch(error){emit('keyboard-text-rejected',{message:error.message});continue;}
        if(!ready){emit('keyboard-text-rejected',{message:'Wait for the keyboard to connect before sending text.'});continue;}
        startText(prepared);continue;
      }
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||
        !Object.hasOwn(value,'report')||!ready||mode!=='live'||!validReport(value.report)) {rejectInput();return;}
      if(textJob)continue; // Physical events cannot interleave with paced text.
      if(!writeReport(Buffer.from(value.report)))return;
    }
    if(Buffer.byteLength(pending)>MAX_RECORD_BYTES)rejectInput();
  }
  const end=()=>{if(pending)rejectInput();else stop();};
  const inputError=()=>rejectInput('The keyboard input connection closed. Inspect the Switch before reconnecting.');
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  // Keep the CLI's closed-pipe guard for pending stdout writes during exit.
  if(!options.emit)process.stdout.on('error',pipeError);
  if(mode==='live') {
    input.setEncoding('utf8');input.on('data',data);input.once('end',end);input.once('close',end);input.once('error',inputError);
    input.resume();if(input.readableEnded)stop();
  }
  try {
    for(const candidate of candidates) {
      if(stopping)break;
      emit('controller',{message:'Connecting the Switch keyboard…',controller:candidate});
      if(stopping)break;
      child=(options.spawn||spawn)(path.join(root,'mac2jb-keyboard'),[],{
        cwd:root,stdio:['pipe','pipe','pipe'],env:{...process.env,MAC2JB_CONTROLLER:candidate,MAC2JB_AUTO_WORKER:'1',MAC2JB_ENUMERATION_TIMEOUT_SECONDS:String(timeout)}});
      const owned=child;
      submittedReports=0;acknowledgedReports=0;
      let output='',error='',released=false,sawReady=false,spawnError,enumerationTimedOut=false;
      childDone=new Promise(resolve=>{owned.once('error',error=>{spawnError=error;});owned.once('close',(code,signal)=>resolve({code,signal}));});
      owned.stdin.on('error',()=>{if(!stopping)inputError();});
      const observe=line=>{
        if(line==='MAC2JB_KEYBOARD_READY') {
          if(sawReady||released){rejectInput('The keyboard helper sent an invalid readiness sequence. Inspect the Switch before reconnecting.');return;}
          sawReady=true;ready=!stopping&&!enumerationTimedOut;
          if(ready)emit('keyboard-ready',{mode,controller:candidate,message:'Keyboard connected. Click the typing area to forward keys.'});
        } else if(line.startsWith('MAC2JB_KEYBOARD_SENT')) {
          if(stopping)return;
          const match=/^MAC2JB_KEYBOARD_SENT ([1-9]\d*)$/.exec(line),count=match&&Number(match[1]);
          if(!sawReady||released||!Number.isSafeInteger(count)||count!==acknowledgedReports+1||count>submittedReports) {
            rejectInput('The keyboard helper sent an invalid delivery confirmation. Inspect the Switch before reconnecting.');return;
          }
          acknowledgedReports=count;
          if(textJob?.ackResume&&count>=textJob.ackTarget) {
            clearTimeout(textJob.ackTimer);const resume=textJob.ackResume;textJob.ackResume=undefined;resume(true);
          }
        } else if(line==='MAC2JB_KEYBOARD_RELEASED') {
          if(released){rejectInput('The keyboard helper sent an invalid release sequence. Inspect the Switch before reconnecting.');return;}
          if(textJob&&!stopping)failure='The keyboard disconnected before text delivery completed. Inspect the Switch before reconnecting.';
          released=true;ready=false;cancelText();
        }
      };
      owned.stdout.setEncoding('utf8');owned.stdout.on('data',bytes=>{
        output+=bytes;let at;
        while((at=output.indexOf('\n'))>=0){const line=output.slice(0,at);output=output.slice(at+1);if(Buffer.byteLength(line)>4096){rejectInput();return;}observe(line);}
        if(Buffer.byteLength(output)>4096)rejectInput();
      });
      owned.stdout.on('error',()=>rejectInput('The keyboard status connection closed. Inspect the Switch before reconnecting.'));
      owned.stderr.setEncoding('utf8');owned.stderr.on('data',bytes=>{error=(error+bytes).slice(-4096);});
      owned.stderr.on('error',()=>rejectInput('The keyboard status connection closed. Inspect the Switch before reconnecting.'));
      const enumerationTimer=setTimeout(()=>{
        if(!sawReady&&!released&&!stopping){enumerationTimedOut=true;terminate(owned);}
      },(timeout+2)*1000);enumerationTimer.unref();
      let outcome;
      try{outcome=await childDone;}finally{clearTimeout(enumerationTimer);clearTimeout(stopTimer);stopTimer=undefined;}
      ready=false;cancelText();if(textTask)await textTask;
      if(failure) {
        emit('failed',{message:failure+(released?' Held keys were released.':' Key release could not be confirmed; reconnect the cable if a key repeats.')});return 1;
      }
      if(stopping) {
        emit(released?'keyboard-stopped':'failed',{message:released?'Keyboard forwarding stopped. Held keys were released.':'Keyboard disconnected without confirmed key release. Reconnect the cable if a key repeats.'});return released?130:1;
      }
      const initializationError=/^(?:Could not open USB keyboard\.|USB keyboard enumeration failed\b|libusbd_init failed\b|USB configuration failed\b|USB interface setup failed\b|USB enumeration error(?::|\s))/m.test(error);
      const safeEnumerationFailure=!sawReady&&!released&&!written&&!spawnError&&!initializationError&&
        ((enumerationTimedOut&&(['SIGTERM','SIGKILL'].includes(outcome.signal)||[1,130].includes(outcome.code)))||
          (!outcome.signal&&outcome.code===1&&/^USB host did not enumerate a keyboard\.$/m.test(error)));
      if(safeEnumerationFailure){safeFailures++;continue;}
      if(spawnError||enumerationTimedOut||outcome.code!==0||outcome.signal||!sawReady||!released) {
        emit('failed',{message:sawReady?'Keyboard input stopped. Inspect the Switch before reconnecting.'+
          (released?' Held keys were released.':' Key release could not be confirmed; reconnect the cable if a key repeats.'):
          'Could not connect the keyboard. Check the USB cable and power direction.'});return 1;
      }
      emit('keyboard-stopped',{message:'Keyboard forwarding stopped. Held keys were released.'});return 0;
    }
    if(stopping)return 130;
    emit('failed',{...(safeFailures===candidates.length?{retrySafe:true}:{}),message:'No USB controller connected. Check the cable and power direction.'});return 1;
  } catch {
    rejectInput('The keyboard helper could not continue. Inspect the Switch before reconnecting.');
    if(childDone)await childDone;
    emit('failed',{message:failure});return 1;
  } finally {
    cancelText();if(textTask)await textTask;
    clearTimeout(stopTimer);
    if(mode==='live'){input.removeListener('data',data);input.removeListener('end',end);input.removeListener('close',end);input.removeListener('error',inputError);input.pause();}
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
}
module.exports={main,validReport,prepareText,MAX_TEXT_BYTES,MAX_RECORD_BYTES};
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(()=>{
  process.stdout.on('error',()=>{});
  process.stdout.write(JSON.stringify({type:'failed',message:'Invalid keyboard settings.'})+'\n');process.exitCode=1;
});
