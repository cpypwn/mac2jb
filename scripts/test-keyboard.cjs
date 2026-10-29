#!/usr/bin/env node
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {PassThrough,Writable}=require('node:stream');
const {main,validReport,prepareText,MAX_TEXT_BYTES,MAX_RECORD_BYTES}=require('./gui-keyboard.cjs');
const root=path.resolve(__dirname,'..');
const neutral=[0,0,0,0,0,0,0,0],pressed=[0,0,4,0,0,0,0,0];
async function until(check,message='Timed out waiting for the fake keyboard') {
  const deadline=Date.now()+3000;
  while(!check()){assert.ok(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,5));}
}
function fixture(t,script) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb keyboard test '));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  fs.mkdirSync(path.join(directory,'scripts'));
  fs.copyFileSync(path.join(__dirname,'gui-keyboard.cjs'),path.join(directory,'scripts/gui-keyboard.cjs'));
  fs.writeFileSync(path.join(directory,'scripts/usb-controllers.cjs'),`const real=require(${JSON.stringify(path.join(__dirname,'usb-controllers.cjs'))});
module.exports={...real,autoControllers:preferred=>real.autoControllers(preferred,()=>[...real.fallbackControllers])};\n`);
  if(script!==undefined)fs.writeFileSync(path.join(directory,'mac2jb-keyboard'),'#!'+process.execPath+'\n'+`
    const fs=require('node:fs');
    fs.appendFileSync('attempts.txt',process.env.MAC2JB_CONTROLLER+'\\n');
    ${script}
  `,{mode:0o700});
  return directory;
}
function run(t,directory,args=['live','auto'],options={}) {
  const child=spawn(process.execPath,[path.join(directory,'scripts/gui-keyboard.cjs'),...args],{
    cwd:directory,stdio:[options.closedInput?'ignore':'pipe','pipe','pipe'],env:{...process.env,...options.env}
  });
  let output='',error='';
  child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{error+=bytes;});
  const events=()=>output.split('\n').slice(0,-1).filter(Boolean).map(JSON.parse);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,output,error,events:events()}));});
  t.after(async()=>{child.kill('SIGKILL');await done;});
  return {child,done,events};
}
const interactive=`
  let closing=false;
  const close=()=>{if(closing)return;closing=true;fs.writeFileSync('released.txt','yes');console.log('MAC2JB_KEYBOARD_RELEASED');setTimeout(()=>process.exit(130),10);};
  process.on('SIGTERM',close);process.stdin.on('end',close);
  process.stdin.on('data',bytes=>fs.appendFileSync('reports.bin',bytes));
  console.log('MAC2JB_KEYBOARD_READY');
`;
function textSession(t,options={}) {
  const input=new PassThrough(),events=[],writes=[],delivered=[];
  let attempts=0,closed=false,timer,finishWrite,acknowledged=0,maxPending=0;
  const result=main(['live','usb-drd0'],{input,ackTimeoutMs:options.ackTimeoutMs,
    emit:(type,fields)=>{events.push({type,...fields,at:performance.now()});options.event?.(type,fields,input);},
    spawn:()=>{
      attempts++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.stdin=new Writable({highWaterMark:options.highWaterMark??16384,write(bytes,encoding,callback){
        if(closed){callback();return;}
        const report=[...bytes];finishWrite=callback;
        const finish=()=>{
          timer=undefined;finishWrite=undefined;
          if(!closed){
            delivered.push({report,at:performance.now()});
            if(options.ack!==false) {
              const count=++acknowledged,value=options.acknowledgement?options.acknowledgement(count):count;
              if(value!==null)child.stdout.write('MAC2JB_KEYBOARD_SENT '+value+'\n');
            }
          }
          callback();
        };
        timer=setTimeout(finish,options.sinkDelayMs??0);
      }});
      const originalWrite=child.stdin.write.bind(child.stdin);
      child.stdin.write=(bytes,...args)=>{
        writes.push({report:[...bytes],at:performance.now()});maxPending=Math.max(maxPending,writes.length-delivered.length);
        return originalWrite(bytes,...args);
      };
      child.kill=()=>{
        if(closed)return;closed=true;clearTimeout(timer);const callback=finishWrite;finishWrite=undefined;callback?.();
        delivered.push({report:neutral,at:performance.now(),cleanup:true});
        setImmediate(()=>{child.stdout.end('MAC2JB_KEYBOARD_RELEASED\n');child.emit('close',130,null);});
      };
      setImmediate(()=>child.stdout.write('MAC2JB_KEYBOARD_READY\n'));return child;
    }});
  t.after(async()=>{input.end();await result;});
  return {input,events,writes,delivered,result,attempts:()=>attempts,maxPending:()=>maxPending};
}

test('text preflight normalizes CRLF, enforces complete ASCII input and bounds without a controller',async()=>{
  assert.equal(prepareText({text:'A\r\nB\t',delayMs:10}).total,4);
  assert.equal(prepareText({text:'x'.repeat(MAX_TEXT_BYTES),delayMs:2000}).total,MAX_TEXT_BYTES);
  for(const value of [{text:'',delayMs:10},{text:'A'.repeat(MAX_TEXT_BYTES+1),delayMs:10},
    {text:'valid prefix\u00e9',delayMs:10},{text:'A\rB',delayMs:10},{text:'A\0',delayMs:10},{text:'A\x7f',delayMs:10},
    {text:'A',delayMs:0},{text:'A',delayMs:2001},{text:'A',delayMs:1.5},{text:'A',delayMs:'10'},
    {text:'A'},{text:1,delayMs:10},{text:'A',delayMs:10,report:pressed}])assert.throws(()=>prepareText(value));
  const events=[];
  assert.equal(await main(['--self-test'],{emit:(type,fields)=>events.push({type,...fields}),spawn:()=>{throw Error('Unexpected USB');}}),0);
  assert.equal(events[0].type,'self-test');
});
test('unsupported pasted text is rejected before any report and leaves the keyboard usable',async t=>{
  const session=textSession(t);await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  for(const value of [{text:'DO_NOT_LOG valid prefix\u00e9',delayMs:10},{text:'x'.repeat(MAX_TEXT_BYTES+1),delayMs:10},
    {text:'safe',delayMs:0},{text:'A\rB',delayMs:10}])session.input.write(JSON.stringify(value)+'\n');
  await until(()=>session.events.filter(row=>row.type==='keyboard-text-rejected').length===4);
  assert.equal(session.writes.length,0);assert.equal(session.events.some(row=>row.type==='keyboard-text-started'),false);
  assert.doesNotMatch(JSON.stringify(session.events),/DO_NOT_LOG|valid prefix/);
  session.input.write(JSON.stringify({text:'OK',delayMs:1})+'\n');
  await until(()=>session.events.some(row=>row.type==='keyboard-text-completed'));
  session.input.end();assert.equal(await session.result,130);
});
test('literal pasted text preserves symbols, case, tab and line endings without a trailing Enter or interleaving',async t=>{
  const text='$HOME $(echo nope) `uname` "A" aA !@#$%^&*()_-+={}[]|\\:;\'<>.,?/~\r\n\tEND';
  const expected=prepareText({text,delayMs:1});
  const session=textSession(t,{event:(type,fields,input)=>{
    if(type==='keyboard-text-started') {
      input.write(JSON.stringify({report:[0,0,20,0,0,0,0,0]})+'\n');
      input.write(JSON.stringify({text:'DO_NOT_QUEUE',delayMs:1})+'\n');
    }
  }});
  await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({report:pressed})+'\n');
  await until(()=>session.delivered.length===1);
  const line=JSON.stringify({text,delayMs:1})+'\n';session.input.write(line.slice(0,100));session.input.write(line.slice(100));
  await until(()=>session.events.some(row=>row.type==='keyboard-text-completed'));
  assert.deepEqual(session.writes.map(row=>row.report),[pressed,neutral,...expected.reports.flatMap(report=>[[...report],neutral])]);
  assert.equal(session.writes.filter(row=>row.report[2]===40).length,1);
  assert.equal(session.events.filter(row=>row.type==='keyboard-text-started').length,1);
  const complete=session.events.find(row=>row.type==='keyboard-text-completed');
  assert.equal(complete.sent,expected.total);assert.equal(complete.total,expected.total);
  assert.doesNotMatch(JSON.stringify(session.events),/HOME|echo nope|uname|DO_NOT_QUEUE/);
  session.input.write(JSON.stringify({report:pressed})+'\n');
  await until(()=>session.writes.at(-1).report[2]===4);
  session.input.end();assert.equal(await session.result,130);
});
test('slow native delivery gates progress and the per-character delay with at most two reports outstanding',async t=>{
  const session=textSession(t,{sinkDelayMs:35});
  await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({text:'ABC',delayMs:30})+'\n');
  await until(()=>session.writes.length===3);
  assert.equal(session.events.some(row=>row.type==='keyboard-text-progress'||row.type==='keyboard-text-completed'),false);
  await until(()=>session.events.some(row=>row.type==='keyboard-text-completed'));
  assert.ok(session.maxPending()<=2);
  for(let index=1;index<3;index++)
    assert.ok(session.writes[1+index*2].at-session.delivered[index*2].at>=25,'Pacing starts after the prior release was delivered');
  const complete=session.events.find(row=>row.type==='keyboard-text-completed');
  assert.ok(complete.at-session.delivered.at(-1).at>=25);
  const progress=session.events.filter(row=>row.type==='keyboard-text-progress');
  assert.equal(progress.at(-1).sent,3);assert.ok(progress.length<=3);
  for(let index=1;index<progress.length;index++)assert.ok(progress[index].sent>progress[index-1].sent);
  session.input.end();assert.equal(await session.result,130);
});
test('missing delivery confirmation fails once, releases keys and never reports typed progress',async t=>{
  const session=textSession(t,{ack:false,ackTimeoutMs:30});
  await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({text:'NEVER SENT',delayMs:10})+'\n');
  assert.equal(await session.result,1);
  assert.deepEqual(session.writes.map(row=>row.report),[neutral]);
  assert.equal(session.attempts(),1);assert.equal(session.events.some(row=>row.type==='keyboard-text-progress'||row.type==='keyboard-text-completed'),false);
  assert.deepEqual(session.delivered.at(-1).report,neutral);
});
for(const [name,acknowledgement] of [['missing release',count=>count===3?null:count],['skipped count',count=>count===2?3:count],
  ['duplicate count',count=>count===2?1:count]])
test(name+' acknowledgement cannot advance text progress or complete a transfer',async t=>{
  const session=textSession(t,{acknowledgement,ackTimeoutMs:30});
  await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({text:'ABC',delayMs:10})+'\n');
  assert.equal(await session.result,1);
  assert.ok(session.writes.filter(row=>row.report[2]).length<=1);
  assert.equal(session.events.some(row=>row.type==='keyboard-text-progress'||row.type==='keyboard-text-completed'),false);
  assert.deepEqual(session.delivered.at(-1).report,neutral);
});
test('EOF cancels a long pacing wait immediately and never replays remaining pasted text',async t=>{
  const session=textSession(t);await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({text:'ABC',delayMs:2000})+'\n');
  await until(()=>session.delivered.length===3);const before=performance.now();session.input.end();
  assert.equal(await session.result,130);assert.ok(performance.now()-before<500);
  assert.equal(session.writes.filter(row=>row.report[2]).length,1);
  assert.deepEqual(session.delivered.at(-1).report,neutral);
  assert.equal(session.events.some(row=>row.type==='keyboard-text-completed'),false);
  assert.equal(session.attempts(),1);
});
test('EOF while native delivery is pending cancels before any text and confirms release',async t=>{
  const session=textSession(t,{sinkDelayMs:1000});await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({text:'ABC',delayMs:10})+'\n');
  await until(()=>session.writes.length===1);session.input.end();
  assert.equal(await session.result,130);
  assert.deepEqual(session.writes.map(row=>row.report),[neutral]);
  assert.equal(session.events.some(row=>row.type==='keyboard-text-completed'),false);
});
test('text pipe backpressure fails closed without queued retries or completion',async t=>{
  const session=textSession(t,{highWaterMark:1});await until(()=>session.events.some(row=>row.type==='keyboard-ready'));
  session.input.write(JSON.stringify({text:'ABC',delayMs:10})+'\n');
  assert.equal(await session.result,1);
  assert.deepEqual(session.writes.map(row=>row.report),[neutral]);
  assert.equal(session.events.some(row=>row.type==='keyboard-text-completed'),false);
});
test('Stop keyboard interrupts an accepted pasted string and joins its native worker without replay',async t=>{
  const directory=fixture(t,interactive+`
    let pending=Buffer.alloc(0),count=0;
    process.stdin.on('data',bytes=>{
      pending=Buffer.concat([pending,bytes]);
      while(pending.length>=8){pending=pending.subarray(8);console.log('MAC2JB_KEYBOARD_SENT '+(++count));}
    });
  `),runner=run(t,directory);
  await until(()=>runner.events().some(row=>row.type==='keyboard-ready'));
  runner.child.stdin.write(JSON.stringify({text:'ABC',delayMs:2000})+'\n');
  const received=()=>fs.existsSync(path.join(directory,'reports.bin'))?fs.readFileSync(path.join(directory,'reports.bin')):Buffer.alloc(0);
  await until(()=>received().length>=24);const before=performance.now();runner.child.kill('SIGTERM');
  const result=await runner.done;assert.equal(result.code,130,result.error);assert.ok(performance.now()-before<1000);
  const bytes=received();let presses=0;for(let offset=0;offset+8<=bytes.length;offset+=8)if(bytes[offset+2])presses++;
  assert.equal(presses,1);assert.equal(result.events.some(row=>row.type==='keyboard-text-completed'),false);
  assert.ok(result.events.some(row=>row.type==='keyboard-stopped'));assert.ok(fs.existsSync(path.join(directory,'released.txt')));
  assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd0\n');
});

test('keyboard reports require canonical bounded eight-byte HID values',()=>{
  for(const value of [neutral,pressed,[255,0,4,5,6,7,8,0],[0,0,0x73,0,0,0,0,0]])assert.equal(validReport(value),true);
  for(const value of [null,{},'secret',[],[0,0,4],[-1,0,4,0,0,0,0,0],[256,0,4,0,0,0,0,0],
    [0,1,4,0,0,0,0,0],[0,0,3,0,0,0,0,0],[0,0,0x74,0,0,0,0,0],[0,0,4,4,0,0,0,0],
    [0,0,4,0,5,0,0,0],[0,0,4.5,0,0,0,0,0]])assert.equal(validReport(value),false,JSON.stringify(value));
  assert.equal(validReport(Object.assign(new Array(8),{0:0,1:0})),false);
});
test('keyboard settings reject extra arguments and malformed controller/time values before spawning',async()=>{
  for(const args of [["--shortcut-prg1","auto"],["--run-demo-save","auto"],[],['live'],['bad','auto'],['live','usb-drd16'],['live','usb-drd01'],['live','auto','0'],
    ['live','auto','121'],['live','auto','1e2'],['live','auto',''],['live','auto','4','extra']]) {
    await assert.rejects(main(args,{spawn:()=>{throw Error('Unexpected spawn');}}),/Invalid keyboard settings/);
  }
});
test('preferred keyboard controller settings are auto-only, canonical and unique',async()=>{
  for(const args of [['live','auto','--preferred-controller'],['live','auto','--preferred-controller','auto'],
    ['live','auto','--preferred-controller','usb-drd16'],['live','auto','--preferred-controller','usb-drd01'],
    ['live','auto','4','--preferred-controller','usb-drd3','--preferred-controller','usb-drd1'],
    ['live','usb-drd3','--preferred-controller','usb-drd1']])
    await assert.rejects(main(args,{spawn:()=>{throw Error('Unexpected spawn');}}),/Invalid keyboard settings/);
});
for(const [preferred,expected] of [['usb-drd1','usb-drd1\nusb-drd0\nusb-drd3\n'],['usb-drd15','usb-drd15\nusb-drd0\nusb-drd1\nusb-drd3\n']])
test('unresponsive preferred keyboard candidates are deduplicated and safe only after exhaustion: '+preferred,async t=>{
  const directory=fixture(t,`console.error('USB host did not enumerate a keyboard.');process.exitCode=1;`);
  const result=await run(t,directory,['live','auto','4','--preferred-controller',preferred]).done;
  assert.equal(result.code,1,result.error);assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),expected);
  assert.equal(result.events.some(event=>event.type==='keyboard-ready'),false);assert.equal(result.events.findLast(event=>event.type==='failed').retrySafe,true);
});
test('only a responding fallback keyboard controller becomes successful readiness proof',async t=>{
  const directory=fixture(t,`if(process.env.MAC2JB_CONTROLLER==='usb-drd15'){console.error('USB host did not enumerate a keyboard.');process.exitCode=1;}else{console.log('MAC2JB_KEYBOARD_READY');console.log('MAC2JB_KEYBOARD_RELEASED');}`);
  const result=await run(t,directory,['live','auto','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,0,result.error);assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd15\nusb-drd0\n');
  assert.deepEqual(result.events.filter(event=>event.type==='keyboard-ready').map(event=>event.controller),['usb-drd0']);
});
for(const diagnostic of ['Could not open USB keyboard.','USB keyboard enumeration failed; no input sent.',
  'USB configuration failed on selected controller','USB enumeration error: 0xdeadbeef'])
test('keyboard initialization failure cannot enable another probe or safe Skip: '+diagnostic,async t=>{
  const directory=fixture(t,`console.error(${JSON.stringify(diagnostic)});console.error('USB host did not enumerate a keyboard.');process.exitCode=1;`);
  const result=await run(t,directory,['live','auto','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,1);assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd15\n');
  assert.equal(result.events.some(event=>event.type==='keyboard-ready'||event.retrySafe===true),false);
});
test('a late positive release without readiness cannot enable another controller probe',async t=>{
  const directory=fixture(t,`console.error('USB host did not enumerate a keyboard.');console.log('MAC2JB_KEYBOARD_RELEASED');process.exitCode=1;`);
  const result=await run(t,directory,['live','auto','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,1);assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd15\n');
  assert.equal(result.events.some(event=>event.type==='keyboard-ready'||event.retrySafe===true),false);
});
test('a bounded unresponsive keyboard worker can fail safely after its only attempt',{timeout:6000},async t=>{
  const directory=fixture(t,`setInterval(()=>{},1000);`);
  const result=await run(t,directory,['live','usb-drd7','1']).done;
  assert.equal(result.code,1,result.error);assert.equal(result.events.findLast(event=>event.type==='failed').retrySafe,true);
  assert.equal(result.events.some(event=>event.type==='keyboard-ready'),false);
});
test('late preferred keyboard readiness at its deadline is not learned, retried or safe to Skip',{timeout:6000},async t=>{
  const directory=fixture(t,`process.on('SIGTERM',()=>{console.log('MAC2JB_KEYBOARD_READY');console.log('MAC2JB_KEYBOARD_RELEASED');process.exit(0);});setInterval(()=>{},1000);`);
  const result=await run(t,directory,['live','auto','1','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,1,result.error);assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd15\n');
  assert.equal(result.events.some(event=>event.type==='keyboard-ready'||event.type==='keyboard-stopped'||event.retrySafe===true),false);
});
test('only orderly pre-readiness enumeration failures advance to another controller',async t=>{
  const directory=fixture(t,`if(process.env.MAC2JB_CONTROLLER==='usb-drd0'){console.error('USB host did not enumerate a keyboard.');process.exitCode=1;}
    else{console.log('MAC2JB_KEYBOARD_READY');console.log('MAC2JB_KEYBOARD_RELEASED');}`);
  const result=await run(t,directory,['live','auto']).done;
  assert.equal(result.code,0,result.error);
  assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd0\nusb-drd1\n');
  assert.equal(result.events.filter(row=>row.type==='keyboard-stopped').length,1);
});
for(const [label,script] of [
  ['abnormal termination',`console.error('USB host did not enumerate a keyboard.');process.kill(process.pid,'SIGTERM');`],
  ['failure after readiness',`console.log('MAC2JB_KEYBOARD_READY');console.error('USB host did not enumerate a keyboard.');console.log('MAC2JB_KEYBOARD_RELEASED');process.exitCode=1;`],
  ['missing release proof',`console.log('MAC2JB_KEYBOARD_READY');`],
  ['missing readiness proof',`console.log('MAC2JB_KEYBOARD_RELEASED');`],
  ['marker substrings',`console.log('prefix_MAC2JB_KEYBOARD_READY');console.log('prefix_MAC2JB_KEYBOARD_RELEASED');`],
  ['release before readiness',`console.log('MAC2JB_KEYBOARD_RELEASED');console.log('MAC2JB_KEYBOARD_READY');setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(1));`]
])test(`${label} fails once without replay or a keyboard completion`,async t=>{
  const directory=fixture(t,script),result=await run(t,directory,['live','auto']).done;
  assert.equal(result.code,1,result.error);
  assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd0\n');
  assert.equal(result.events.some(row=>row.type==='keyboard-stopped'),false);
  assert.equal(result.events.some(row=>row.retrySafe===true),false);
  assert.ok(result.events.some(row=>row.type==='failed'));
});
test('fragmented exact markers are drained before accepting keyboard completion',async t=>{
  const directory=fixture(t,`process.stdout.write('MAC2JB_KEY');setTimeout(()=>{process.stdout.write('BOARD_READY\\nMAC2JB_KEYBOARD_REL');setTimeout(()=>process.stdout.write('EASED\\n'),5);},5);`);
  const result=await run(t,directory,['live','auto']).done;
  assert.equal(result.code,0,result.error);
  assert.deepEqual(result.events.map(row=>row.type),['controller','keyboard-ready','keyboard-stopped']);
});
test('live fragmented JSON forwards binary reports and EOF waits for positive release',async t=>{
  const directory=fixture(t,interactive),runner=run(t,directory);
  await until(()=>runner.events().some(row=>row.type==='keyboard-ready'));
  runner.child.stdin.write('{"report":[0,0,');runner.child.stdin.write('4,0,0,0,0,0]}\n');
  await until(()=>fs.existsSync(path.join(directory,'reports.bin')));
  runner.child.stdin.end();const result=await runner.done;
  assert.equal(result.code,130,result.error);
  assert.deepEqual([...fs.readFileSync(path.join(directory,'reports.bin')).subarray(0,8)],pressed);
  assert.ok(fs.existsSync(path.join(directory,'released.txt')));
  assert.ok(result.events.some(row=>row.type==='keyboard-stopped'&&/released/.test(row.message)));
  assert.equal(result.events.some(row=>row.type==='failed'),false);
});
for(const line of ['null\n','[]\n','{"report":[0,0,4,0,0,0,0,0],"secret":"DO_NOT_LOG"}\n',
  '{"report":[0,1,4,0,0,0,0,0]}\n','not-json-DO_NOT_LOG\n','x'.repeat(MAX_RECORD_BYTES+1)])
  test('invalid live input fails without logging typed data: '+line.slice(0,24),async t=>{
    const directory=fixture(t,interactive),runner=run(t,directory);
    await until(()=>runner.events().some(row=>row.type==='keyboard-ready'));
    runner.child.stdin.write(line);const result=await runner.done;
    assert.equal(result.code,1,result.error);
    assert.ok(result.events.some(row=>row.type==='failed'&&/rejected/.test(row.message)));
    assert.equal(result.events.some(row=>row.type==='keyboard-stopped'),false);
    assert.equal(result.events.some(row=>row.retrySafe===true),false);
    assert.doesNotMatch(result.output+result.error,/DO_NOT_LOG|not-json/);
    assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd0\n');
  });
test('a truncated JSON record at EOF is a failure even when keys release',async t=>{
  const directory=fixture(t,interactive),runner=run(t,directory);
  await until(()=>runner.events().some(row=>row.type==='keyboard-ready'));
  runner.child.stdin.end('{"report":');const result=await runner.done;
  assert.equal(result.code,1);assert.ok(result.events.some(row=>row.type==='failed'));
  assert.equal(result.events.some(row=>row.type==='keyboard-stopped'),false);
    assert.equal(result.events.some(row=>row.retrySafe===true),false);
});
test('reports before readiness are rejected without reaching a controller',async t=>{
  const directory=fixture(t,`process.on('SIGTERM',()=>{console.log('MAC2JB_KEYBOARD_RELEASED');process.exit(130);});setTimeout(()=>console.log('MAC2JB_KEYBOARD_READY'),500);setInterval(()=>{},1000);`);
  const runner=run(t,directory);await until(()=>runner.events().some(row=>row.type==='controller'));
  runner.child.stdin.write(JSON.stringify({report:pressed})+'\n');const result=await runner.done;
  assert.equal(result.code,1);assert.equal(result.events.some(row=>row.type==='keyboard-ready'||row.type==='keyboard-stopped'),false);
});
test('stdin pipe loss after readiness is a failure and never retries',async t=>{
  const directory=fixture(t,`fs.closeSync(0);process.on('SIGTERM',()=>{console.log('MAC2JB_KEYBOARD_RELEASED');process.exit(130);});console.log('MAC2JB_KEYBOARD_READY');setInterval(()=>{},1000);`);
  const runner=run(t,directory);await until(()=>runner.events().some(row=>row.type==='keyboard-ready'));
  runner.child.stdin.write(JSON.stringify({report:pressed})+'\n');const result=await runner.done;
  assert.equal(result.code,1);assert.ok(result.events.some(row=>row.type==='failed'));
  assert.equal(result.events.some(row=>row.type==='keyboard-stopped'),false);
    assert.equal(result.events.some(row=>row.retrySafe===true),false);
  assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd0\n');
});
test('stdout EPIPE still stops and joins the owned fake keyboard',async t=>{
  const directory=fixture(t,interactive),runner=run(t,directory);
  await until(()=>runner.events().some(row=>row.type==='controller'));
  runner.child.stdout.destroy();
  const result=await runner.done;
  assert.equal(result.code,1,result.error);
  assert.ok(fs.existsSync(path.join(directory,'released.txt')));
  assert.doesNotMatch(result.error,/Unhandled|EPIPE/);
});
test('stop racing a late ready marker cannot re-arm keyboard input',async t=>{
  const directory=fixture(t,`process.on('SIGTERM',()=>{console.log('MAC2JB_KEYBOARD_READY');console.log('MAC2JB_KEYBOARD_RELEASED');process.exit(130);});fs.writeFileSync('listening.txt','yes');setInterval(()=>{},1000);`);
  const runner=run(t,directory);await until(()=>fs.existsSync(path.join(directory,'listening.txt')));
  runner.child.kill('SIGTERM');const result=await runner.done;
  assert.equal(result.code,130,result.error);
  assert.equal(result.events.some(row=>row.type==='keyboard-ready'),false);
  assert.ok(result.events.some(row=>row.type==='keyboard-stopped'));
});
test('a missing native worker fails promptly without probing other controllers',async t=>{
  const directory=fixture(t),result=await run(t,directory,['live','auto']).done;
  assert.equal(result.code,1);assert.equal(result.events.filter(row=>row.type==='controller').length,1);
  assert.ok(result.events.some(row=>row.type==='failed'));
});
test('binary pipe backpressure stops once and reports a failure after releasing keys',{timeout:2000},async()=>{
  const input=new PassThrough(),events=[];let attempts=0;
  const result=await main(['live','auto'],{input,emit:(type,fields)=>{
    events.push({type,...fields});if(type==='keyboard-ready')input.write(JSON.stringify({report:pressed})+'\n');
  },spawn:()=>{
    attempts++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin=new Writable({highWaterMark:1,write(bytes,encoding,callback){setImmediate(callback);}});
    let ended=false;child.kill=()=>{if(ended)return;ended=true;setImmediate(()=>{child.stdout.end('MAC2JB_KEYBOARD_RELEASED\n');child.emit('close',130,null);});};
    setImmediate(()=>child.stdout.write('MAC2JB_KEYBOARD_READY\n'));return child;
  }});
  assert.equal(result,1);assert.equal(attempts,1);
  assert.ok(events.some(row=>row.type==='failed'&&/buffer limit/.test(row.message)));
  assert.equal(events.some(row=>row.type==='keyboard-stopped'),false);
});
test('enumeration deadline drains a late ready marker without re-arming or shortcut success',{timeout:6000},async t=>{
  const directory=fixture(t,`process.on('SIGTERM',()=>{console.log('MAC2JB_KEYBOARD_READY');console.log('MAC2JB_KEYBOARD_RELEASED');process.exit(0);});setInterval(()=>{},1000);`);
  const result=await run(t,directory,['live','usb-drd0','1']).done;
  assert.equal(result.code,1,result.error);
  assert.equal(result.events.some(row=>row.type==='keyboard-ready'||row.type==='keyboard-stopped'),false);
  assert.ok(result.events.some(row=>row.type==='failed'));
  assert.equal(fs.readFileSync(path.join(directory,'attempts.txt'),'utf8'),'usb-drd0\n');
});

test('production keyboard native entry uses stubbed USB for validation, one-shot keys and shutdown proof',async t=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-keyboard-native-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const production=fs.readFileSync(path.join(root,'keyboard.c'),'utf8').replace('int main(int argc,char **argv) {','int keyboard_test_entry(int argc,char **argv) {');
  const harness=`
    #include <libusbd.h>
    #include <time.h>
    #include <stdio.h>
    #include <stdlib.h>
    static long long ticks=1000000000LL;
    static int setting(const char *name){const char *value=getenv(name);return value?atoi(value):0;}
    static int mock_write(libusbd_ctx_t*,uint8_t,uint64_t,const void*,uint32_t,uint64_t);
    static int mock_clock(clockid_t,struct timespec*);
    static int mock_pause(const struct timespec*,struct timespec*);
    #define libusbd_init(ctx) (puts("TEST_INIT"),*(ctx)=(libusbd_ctx_t*)1,0)
    #define libusbd_free(...) (puts("TEST_FREE"),0)
    #define libusbd_set_pid(...) (0)
    #define libusbd_set_version(...) (0)
    #define libusbd_set_class(...) (0)
    #define libusbd_set_subclass(...) (0)
    #define libusbd_set_protocol(...) (0)
    #define libusbd_set_manufacturer_str(...) (0)
    #define libusbd_set_product_str(...) (0)
    #define libusbd_set_serial_str(...) (0)
    #define libusbd_iface_alloc(ctx,iface) (*(iface)=0,0)
    #define libusbd_config_finalize(...) (setting("TEST_CONFIG_FAIL")?-1:0)
    #define libusbd_iface_set_class(...) (0)
    #define libusbd_iface_set_subclass(...) (0)
    #define libusbd_iface_set_protocol(...) (0)
    #define libusbd_iface_standard_desc(...) (0)
    #define libusbd_iface_nonstandard_desc(...) (0)
    #define libusbd_iface_add_endpoint(ctx,iface,type,direction,size,interval,unknown,ep) (*(ep)=0,0)
    #define libusbd_iface_finalize(...) (0)
    #define libusbd_ep_write mock_write
    #define clock_gettime mock_clock
    #define nanosleep mock_pause
    ${production}
    static int mock_write(libusbd_ctx_t *ctx,uint8_t iface,uint64_t ep,const void *data,uint32_t len,uint64_t timeout){
      static int count=0;count++;const uint8_t *b=data;
      int result=setting("TEST_ENUM_FAIL")?LIBUSBD_NOT_ENUMERATED:
        count==setting("TEST_FAIL_AT")?LIBUSBD_TIMEOUT:
        count==setting("TEST_SHORT_AT")||(setting("TEST_SHORT_FROM")&&count>=setting("TEST_SHORT_FROM"))?setting("TEST_SHORT_VALUE"):(int)len;
      printf("TEST_USB {\\"call\\":%d,\\"report\\":[%u,%u,%u,%u,%u,%u,%u,%u],\\"result\\":%d}\\n",count,b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],result);fflush(stdout);
      if(count==setting("TEST_CANCEL_AT_WRITE"))raise(SIGTERM);
      return result;
    }
    static int mock_clock(clockid_t clock,struct timespec *value){value->tv_sec=ticks/1000000000LL;value->tv_nsec=ticks%1000000000LL;return 0;}
    static int mock_pause(const struct timespec *value,struct timespec *unused){ticks+=(long long)value->tv_sec*1000000000LL+value->tv_nsec;if(setting("TEST_CANCEL_AT_WAIT"))raise(SIGTERM);return 0;}
    int main(int argc,char **argv){
      if(argc==2&&!strcmp(argv[1],"--encode-ascii")){
        for(int index=0;index<97;index++){
          unsigned char c=index<95 ? (unsigned char)(32+index) : index==95 ? '\\t' : '\\n';
          Stroke value;if(!encode(c,&value))return 1;
          printf("TEST_ENCODE [%u,0,%u,0,0,0,0,0]\\n",value.mods,value.key);
        }
        return 0;
      }
      return keyboard_test_entry(argc,argv);
    }
  `;
  const source=path.join(temporary,'keyboard-test.c'),executable=path.join(temporary,'keyboard-test');
  fs.writeFileSync(source,harness);
  const compiled=spawnSync(process.platform === 'darwin' ? 'xcrun' : 'cc',[...(process.platform === 'darwin' ? ['clang'] : []),'-std=c11','-D_POSIX_C_SOURCE=200809L','-DMAC2JB_GUI=1','-I'+root,'-I'+path.join(root,'vendor/libusbd/include'),source,'-o',executable],{encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
  const env=extra=>({...process.env,MAC2JB_CONTROLLER:'usb-drd0',...extra});
  const runNative=(args=[],input=Buffer.alloc(0),extra={})=>spawnSync(executable,args,{input,env:env(extra),encoding:'utf8',timeout:3000});
  const usb=output=>output.split('\n').filter(line=>line.startsWith('TEST_USB ')).map(line=>JSON.parse(line.slice(9)));
  await t.test('pasted ASCII mapping exactly matches production sender.c for every supported character',()=>{
    const text=Array.from({length:95},(_,index)=>String.fromCharCode(index+32)).join('')+'\t\n';
    const native=runNative(['--encode-ascii']);assert.equal(native.status,0,native.stderr);
    const reports=native.stdout.split('\n').filter(line=>line.startsWith('TEST_ENCODE ')).map(line=>JSON.parse(line.slice(12)));
    assert.deepEqual(prepareText({text,delayMs:10}).reports.map(report=>[...report]),reports);
    assert.equal(reports.length,97);assert.doesNotMatch(native.stdout,/TEST_INIT|TEST_USB/);
  });
  await t.test('native delivery acknowledgements count only successful stream reports',()=>{
    const delivered=runNative([],Buffer.from([...pressed,...neutral]));assert.equal(delivered.status,0,delivered.stderr);
    assert.deepEqual(delivered.stdout.match(/MAC2JB_KEYBOARD_SENT \d+/g),['MAC2JB_KEYBOARD_SENT 1','MAC2JB_KEYBOARD_SENT 2']);
    const failed=runNative([],Buffer.from(pressed),{TEST_SHORT_AT:'2',TEST_SHORT_VALUE:'0'});
    assert.equal(failed.status,1);assert.doesNotMatch(failed.stdout,/MAC2JB_KEYBOARD_SENT/);
    assert.match(failed.stdout,/MAC2JB_KEYBOARD_RELEASED/);
  });
  await t.test('validation/self-test and invalid settings never initialize USB',()=>{
    for(const args of [['--self-test'],['--help'],['--validate']]) {
      const result=runNative(args,Buffer.from([...pressed,...neutral]));assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/TEST_INIT|TEST_USB|MAC2JB_KEYBOARD_READY|MAC2JB_KEYBOARD_RELEASED/);
    }
    for(const input of [Buffer.from([0,0,4]),Buffer.from([0,1,4,0,0,0,0,0]),Buffer.from([0,0,4,4,0,0,0,0])]) {
      const result=runNative(['--validate'],input);assert.equal(result.status,1);assert.doesNotMatch(result.stdout,/TEST_INIT|TEST_USB/);
    }
    for(const controller of ['auto','usb-drd16','usb-drd01','bad']) {
      const result=runNative([],Buffer.alloc(0),{MAC2JB_CONTROLLER:controller});assert.equal(result.status,2);assert.doesNotMatch(result.stdout,/TEST_INIT/);
    }
  });
  await t.test('removed demo shortcuts fail before USB initialization',()=>{
    for(const args of [['--shortcut-prg1'],['--run-demo-save']]) {
      const result=runNative(args);assert.equal(result.status,2);assert.doesNotMatch(result.stdout,/TEST_INIT|TEST_USB/);
    }
  });
  await t.test('live EOF/invalid/truncated input always releases the last forwarded key',()=>{
    for(const [input,status] of [[Buffer.from([...pressed,...neutral]),0],[Buffer.from([...pressed,0,1,4,0,0,0,0,0]),1],[Buffer.from([...pressed,0,0,4]),1]]) {
      const result=runNative([],input);assert.equal(result.status,status,result.stderr);
      const reports=usb(result.stdout);assert.deepEqual(reports.at(-1).report,neutral);assert.equal(reports.at(-1).result,8);
      assert.match(result.stdout,/MAC2JB_KEYBOARD_RELEASED/);assert.equal(result.stdout.split('TEST_FREE').length,2);
    }
  });
  await t.test('short/timeout input writes fail once and only the neutral cleanup may follow',()=>{
    for(const extra of [{TEST_SHORT_AT:'2',TEST_SHORT_VALUE:'0'},{TEST_SHORT_AT:'2',TEST_SHORT_VALUE:'7'},{TEST_FAIL_AT:'2'}]) {
      const result=runNative([],Buffer.from(pressed),extra);assert.equal(result.status,1,result.stderr);
      const reports=usb(result.stdout);assert.equal(reports.filter(row=>row.report[2]===4).length,1);
      assert.deepEqual(reports.at(-1).report,neutral);assert.match(result.stdout,/MAC2JB_KEYBOARD_RELEASED/);
    }
  });
  await t.test('short enumeration and failed cleanup cannot produce readiness/release proof',()=>{
    const short=runNative([],Buffer.from(pressed),{TEST_SHORT_AT:'1',TEST_SHORT_VALUE:'0'});
    assert.equal(short.status,1);assert.doesNotMatch(short.stdout,/MAC2JB_KEYBOARD_READY/);assert.equal(usb(short.stdout).some(row=>row.report[2]),false);
    const failed=runNative([],Buffer.from(pressed),{TEST_SHORT_FROM:'3',TEST_SHORT_VALUE:'0'});
    assert.equal(failed.status,1);assert.doesNotMatch(failed.stdout,/MAC2JB_KEYBOARD_RELEASED/);assert.equal(failed.stdout.split('TEST_FREE').length,2);
    const config=runNative([],Buffer.alloc(0),{TEST_CONFIG_FAIL:'1'});
    assert.equal(config.status,1);assert.doesNotMatch(config.stdout,/TEST_USB|MAC2JB_KEYBOARD_RELEASED/);assert.match(config.stdout,/TEST_FREE/);
  });
  await t.test('cancellation before readiness or during live input releases held keys',()=>{
    const early=runNative([],Buffer.from(pressed),{TEST_CANCEL_AT_WRITE:'1'});
    assert.equal(early.status,130);assert.doesNotMatch(early.stdout,/MAC2JB_KEYBOARD_READY/);assert.match(early.stdout,/MAC2JB_KEYBOARD_RELEASED/);
  });
  await t.test('SIGTERM interrupts live poll and confirms a neutral report before exit',async()=>{
    const child=spawn(executable,[],{env:env({}),stdio:['pipe','pipe','pipe']});let output='',error='';
    child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);
    const done=new Promise(resolve=>child.once('close',code=>resolve(code)));t.after(async()=>{child.kill('SIGKILL');await done;});
    await until(()=>output.includes('MAC2JB_KEYBOARD_READY'));child.stdin.write(Buffer.from(pressed));
    await until(()=>usb(output).some(row=>row.report[2]===4));child.kill('SIGTERM');
    assert.equal(await done,130,error);assert.deepEqual(usb(output).at(-1).report,neutral);assert.match(output,/MAC2JB_KEYBOARD_RELEASED/);
  });
});
