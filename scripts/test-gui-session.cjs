#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {heldResult, heldMessage} = require('./gui-session.cjs');
function completeJSONRecords(output) {
  const newline = output.lastIndexOf('\n');
  if (newline < 0) return [];
  return output.slice(0, newline).split('\n').filter(Boolean).map(JSON.parse);
}
function held() {
  return {verified:true, fs:{verified:true, restored:true, retainedEndpoint:{ready:true,session:'switch2-test'},
    cleanup:{deferred:true,donor:{cleanedUp:true}}}, rpc:{mode:'held',state:'listening'}};
}
function fixture(t, options = {}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mac2jb-session-test-')));
  const host=path.join(root,'vendor/ns2jb');
  fs.mkdirSync(host,{recursive:true});fs.mkdirSync(path.join(root,'scripts'));
  for(const name of ['gui-host.cjs','gui-session.cjs','host-profiles.cjs','izlauncher-panel.cjs'])
    fs.copyFileSync(path.join(__dirname,name),path.join(root,'scripts',name));
  fs.mkdirSync(path.join(root,'packaging'));
  fs.copyFileSync(path.join(__dirname,'../packaging/host-profiles.json'),path.join(root,'packaging/host-profiles.json'));
  fs.writeFileSync(path.join(host,'worker.cjs'),[
    "const fs=require('fs');",
    "process.on('SIGTERM',()=>{fs.writeFileSync('group-signal.txt','wrong');process.exit(7);});",
    "process.on('message',value=>{if(value==='release')process.exit(0);});process.send('ready');"
  ].join('\n'));
  fs.writeFileSync(path.join(host,'run.cjs'),[
    "const fs=require('fs'),path=require('path'),{fork}=require('child_process');",
    'const options='+JSON.stringify(options)+';',
    "fs.writeFileSync('host-pid',String(process.pid));",
    "fs.writeFileSync('settings.json',JSON.stringify({args:process.argv.slice(2),arity:process.env.NS2_BASIC_ARITY,rpc:process.env.NS2_RPC_MODE,dump:process.env.NS2_FIRMWARE_DUMP_DIR}));",
    "if(options.bindFailure){fs.appendFileSync('host-invocations.txt','once\\n');const evidence={pairing:'V=START(39380,127,0,0,1)\\n',connected:'Connected. Checking the application\\n',native:'1/4 native work\\n',typing:'Sending: LOAD\\n'}[options.bindEvidence]||'';",
    "process.stdout.write(evidence+'Error: listen EADDRNOTAVAIL: address not available 127.0.0.1:39380\\n    at Server.setupListenHandle (node:net:1:1)\\n'+(options.latePairing?'V=START(39380,127,0,0,1)\\n':''));setInterval(()=>{},1000);",
    "}else{",
    "const directory=path.join(__dirname,'runs/switch2-test');fs.mkdirSync(directory,{recursive:true});",
    'let result='+JSON.stringify(held())+';',
    'if(options.invalid)result.fs.restored=false;',
    "const save=()=>fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result));",
    "fs.writeFileSync(path.join(directory,'connection.json'),JSON.stringify({port:12345,addresses:{session:options.wrongSession?'wrong':'switch2-test',target:'switch2'}}));",
    "const worker=fork(path.join(__dirname,'worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc']});",
    "let stopping=false;const onStop=()=>{",
    "if(stopping)return;stopping=true;fs.appendFileSync('runner-signals.txt','TERM\\n');",
    "if(options.expectHomebrew)fs.writeFileSync('hbl-was-stopped.txt',String(fs.existsSync(path.join(__dirname,'../../homebrew-stop-completed'))));",
    "setTimeout(()=>{worker.once('exit',()=>{result.rpc.state='closed';result.rpc.reason='SIGTERM';",
    "result.fs.cleanup={cleanedUp:!options.badCleanup};result.completed=new Date().toISOString();",
    "if(options.finalError)result.error='cleanup failure';save();process.exit(options.finalError?1:0);});",
    "worker.send('release');},options.cleanupMs||20);};",
    "if(!options.signalDelayMs)process.on('SIGTERM',onStop);",
    "process.on('SIGUSR1',()=>{result.error='Held RPC disconnected';result.rpc.state='closed';result.rpc.reason='disconnected';save();worker.once('exit',()=>process.exit(1));worker.send('release');});",
    "worker.once('message',()=>{save();for(const line of options.pairingPrefix||[])console.log(line);console.log('V=START(39380,127,0,0,1)');console.log('Run folder: '+directory);",
    "if(options.delayReady)setTimeout(()=>console.log("+JSON.stringify(heldMessage)+"),options.delayReady);",
    "else console.log("+JSON.stringify(heldMessage)+");",
    "if(options.signalDelayMs)setTimeout(()=>process.on('SIGTERM',onStop),options.signalDelayMs);});",
    "}"
  ].join('\n'));
  fs.writeFileSync(path.join(host,'rpc.cjs'),[
    "exports.request=async(directory,request)=>{require('fs').appendFileSync(require('path').join(__dirname,'status-calls.txt'),JSON.stringify(request)+'\\n');",
    'await new Promise(resolve=>setTimeout(resolve,'+Number(options.statusMs||10)+'));',
    options.statusFail ? "throw Error('status unavailable');};" : 'return {ready:true,calls:7};};'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'scripts/gui-dump.cjs'),[
    "const fs=require('fs'),path=require('path');const [run,dump]=process.argv.slice(2);",
    "fs.writeFileSync('helper-pid',String(process.pid));",
    "fs.appendFileSync('dump-invocations.txt',JSON.stringify({run,dump,env:process.env.NS2_FIRMWARE_DUMP_DIR})+'\\n');",
    "process.on('SIGTERM',()=>{fs.writeFileSync('dump-interrupted.txt','yes');process.exit(2);});",
    "console.log('Firmware: capturing test code');setTimeout(()=>{",
    options.dumpFail ? 'process.exit(1);' :
      "fs.writeFileSync(path.join(dump,'firmware-dump.json'),JSON.stringify({complete:true,inventory:{total:1},entries:"+(options.badManifest?'[]':"[{id:'test'}]")+"}));console.log('Firmware: manifest complete');process.exit(0);",
    '},'+Number(options.dumpMs||30)+');'
  ].join('\n'));
  fs.writeFileSync(path.join(root,'scripts/gui-homebrew.cjs'),[
    "const fs=require('fs'),path=require('path');const options="+JSON.stringify(options)+";",
    "exports.preflightCustomApp=async(root,folder)=>{fs.appendFileSync(path.join(root,'custom-preflight-calls.txt'),folder+'\\n');",
    "if(folder==='/tmp/soulja-launcher')return {kind:'launcher',app:{name:'SouljaLauncher 2'},launcherFolder:path.join(root,'staged/souljalauncher'),cleanup:async()=>{fs.writeFileSync(path.join(root,'custom-preflight-cleaned'),'yes');}};",
    "if(folder==='/tmp/ouncecake-fork')return {kind:'rpc-app',adapter:'ouncecake',app:{name:'OunceCake fork'},packageFolder:path.join(root,'staged/ouncecake-fork'),cleanup:async()=>{fs.writeFileSync(path.join(root,'custom-preflight-cleaned'),'yes');}};",
    "if(folder==='/tmp/custom-rpc-app')return {kind:'rpc-app',adapter:'script',app:{name:'Custom RPC app'},packageFolder:path.join(root,'staged/custom-rpc-app'),cleanup:async()=>{fs.writeFileSync(path.join(root,'custom-preflight-cleaned'),'yes');}};",
    "if(folder!=='/tmp/custom-gpu-app')throw Error('Missing or incompatible app.json');",
    "return {app:{name:'My GPU App'},appFolder:path.join(root,'staged/my-gpu-app'),cleanup:async()=>{fs.writeFileSync(path.join(root,'custom-preflight-cleaned'),'yes');}};};",
    "if(require.main===module){",
    "fs.writeFileSync('homebrew-pid',String(process.pid));fs.appendFileSync('homebrew-invocations.txt',process.argv[2]+'\\n');",
    "const emit=type=>console.log('MAC2JB_HOMEBREW '+JSON.stringify({type,path:process.argv[2],message:'test '+type,retrySafe:type==='failed'&&options.hblRetrySafe,cleanupBlocked:type==='failed'&&options.hblStopFail}));",
    "let running=false,terminal=false,stop=false;",
    "const close=code=>setTimeout(()=>{fs.writeFileSync('homebrew-stop-completed','yes');process.exit(code);},options.hblCloseMs||20);",
    "process.on('SIGTERM',()=>{if(terminal){fs.writeFileSync('homebrew-extra-signal','wrong');return;}if(stop)return;stop=true;",
    "setTimeout(()=>{terminal=true;emit(options.hblStopFail?'failed':running?'stopped':'failed');close(options.hblStopFail?1:running?0:1);},options.hblStopMs||20);});",
    "emit('started');emit('progress');setTimeout(()=>{if(stop)return;",
    "if(options.hblFail||options.hblFailFirst&&fs.readFileSync('homebrew-invocations.txt','utf8').trim().split('\\n').length===1){terminal=true;emit('failed');close(1);return;}",
    "running=true;emit('running');if(options.hblTerminal)setTimeout(()=>{terminal=true;emit(options.hblTerminal);close(options.hblTerminal==='failed'?1:0);},10);",
    "},options.hblLaunchMs||20);setInterval(()=>{},1000);",
    "}"
  ].join('\n'));
  fs.writeFileSync(path.join(root,'scripts/gui-mintbrew.cjs'),
    "require('fs').writeFileSync('mint-entry-used',process.argv[2]);\n"+
    fs.readFileSync(path.join(root,'scripts/gui-homebrew.cjs'),'utf8'));
  fs.writeFileSync(path.join(root,'scripts/gui-izlauncher.cjs'),
    "require('fs').writeFileSync('iz-args',JSON.stringify(process.argv.slice(3)));require('fs').writeFileSync('iz-entry-used',process.argv[2]);require('fs').writeFileSync('iz-stream-host',process.env.HB_STREAM_HOST||'');process.stdin.on('data',bytes=>{require('fs').appendFileSync('iz-controls',bytes);console.log('MAC2JB_HOMEBREW '+JSON.stringify({type:'module-progress',message:'Queued 1 IZlauncher module from this Mac.'}));});process.stdin.resume();\n"+
    fs.readFileSync(path.join(root,'scripts/gui-homebrew.cjs'),'utf8'));
  fs.writeFileSync(path.join(root,'scripts/izlauncher-modules.cjs'),
    "exports.validIds=ids=>Array.isArray(ids)&&ids.length<=15&&ids.every(id=>/^[a-z0-9][a-z0-9-]{0,47}$/.test(id))&&new Set(ids).size===ids.length;exports.catalog=async()=>[{id:'blitbun',name:'BlitBun',version:'1.14.4',description:'Streaming'}];exports.withDefaults=ids=>[...new Set(['iz-exchange','blitbun','vacootube',...ids])];\n");
  if(options.customRpcAdapter==='ouncecake') {
    fs.writeFileSync(path.join(root,'scripts/gui-custom-homebrew.cjs'),[
      "const fs=require('fs'),assert=require('assert/strict');",
      'assert.deepEqual(process.argv.slice(3),'+JSON.stringify(['--rpc-folder',path.join(root,'staged/ouncecake-fork')])+');',
      "fs.writeFileSync('custom-entry-used',process.argv[2]);",
      "const emit=(type,fields={})=>console.log('MAC2JB_HOMEBREW '+JSON.stringify({type,path:process.argv[2],...fields}));",
      "let config,buffer='';emit('started');",
      "process.stdin.on('data',bytes=>{buffer+=bytes;let at;while((at=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line)continue;const item=JSON.parse(line);if(!config){config=item;fs.writeFileSync('custom-config',JSON.stringify(item));emit('catalog',{games:[{titleId:'0100000000000001',name:'Fixture game',storages:[4]}]});}else if(item.action==='select-game'){fs.writeFileSync('custom-selection',JSON.stringify(item));emit('running',{host:config.consoleAddress,port:2121,ftpURL:'ftp://'+config.consoleAddress+':2121'});}}});",
      "process.on('SIGTERM',()=>{emit('stopped');process.exit(0);});process.stdin.resume();setInterval(()=>{},1000);"
    ].join('\n'));
  } else {
    fs.writeFileSync(path.join(root,'scripts/gui-custom-homebrew.cjs'),
      "require('assert/strict').deepEqual(process.argv.slice(3),"+
        (options.customRpcAdapter==='script'?JSON.stringify(['--rpc-folder',path.join(root,'staged/custom-rpc-app')]):
          options.souljaLauncher?JSON.stringify(['--launcher-folder',path.join(root,'staged/souljalauncher')]):
          JSON.stringify(['--app-folder',path.join(root,'staged/my-gpu-app')]))+
        ");require('fs').writeFileSync('custom-entry-used',process.argv[2]);\n"+
      fs.readFileSync(path.join(root,'scripts/gui-homebrew.cjs'),'utf8'));
  }
  fs.writeFileSync(path.join(root,'scripts/stage-custom-izmodule.cjs'),[
    "const fs=require('fs'),path=require('path');",
    "exports.stage=async(root,folder)=>{fs.appendFileSync(path.join(root,'izmodule-preflight-calls.txt'),folder+'\\n');",
    "if(folder!=='/tmp/compatible-izmodule')throw Error('The module is incompatible');",
    "return {id:'my-module',name:'My Module',version:'1.0.0',cleanup:async()=>{fs.writeFileSync(path.join(root,'izmodule-preflight-cleaned'),'yes');}};};"
  ].join('\n'));
  const child=spawn(process.execPath,[path.join(root,'scripts/gui-host.cjs'),'host','127.0.0.1','--post-run-options'],{
    detached:true,stdio:['pipe','pipe','pipe'],env:{...process.env,NS2_BASIC_ARITY:'9',NS2_RPC_MODE:'1'}
  });
  let output='',error='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{error+=bytes;});
  const done=new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,output,error}));
  });
  t.after(async()=>{
    for(const file of [path.join(root,'helper-pid'),path.join(root,'homebrew-pid'),path.join(host,'host-pid')]) {
      try{process.kill(-Number(fs.readFileSync(file,'utf8')),'SIGKILL');}catch{}
    }
    try{process.kill(-child.pid,'SIGKILL');}catch{}
    await Promise.race([done,new Promise(resolve=>setTimeout(resolve,1000))]);
    fs.rmSync(root,{recursive:true,force:true});
  });
  function events(){return completeJSONRecords(output);}
  async function wait(type,count=1){
    const deadline=Date.now()+5000;
    while(events().filter(event=>event.type===type).length<count){
      assert.ok(child.exitCode===null&&child.signalCode===null,output+error);
      assert.ok(Date.now()<deadline,'Missing '+type+'\n'+output+error);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    return events().filter(event=>event.type===type).at(-1);
  }
  return {root,host,child,done,events,wait,send:value=>child.stdin.write(JSON.stringify(value)+'\n'),
    pid:()=>Number(fs.readFileSync(path.join(host,'host-pid'),'utf8'))};
}
test('fixture JSON reader waits for newline across a fragmented large record and rejects completed malformed JSON',()=>{
  const first={type:'homebrew-started'};
  const catalog={type:'homebrew-catalog',games:Array.from({length:500},(_,index)=>({titleId:String(index),name:'🌿'+'x'.repeat(160)}))};
  const head=JSON.stringify(first)+'\n',record=JSON.stringify(catalog)+'\n';
  assert.ok(Buffer.byteLength(record)>65536);
  let output=head+record.slice(0,65536);
  assert.deepEqual(completeJSONRecords(output),[first]);
  output+=record.slice(65536,-1);
  assert.deepEqual(completeJSONRecords(output),[first],'valid JSON without its newline is still pending');
  output+='\n';
  assert.deepEqual(completeJSONRecords(output),[first,catalog]);
  output+='{"type":';
  assert.deepEqual(completeJSONRecords(output),[first,catalog],'a partial next record must not break earlier events');
  assert.throws(()=>completeJSONRecords(output+'\n'),SyntaxError,'a completed malformed record must still fail the test');
  assert.deepEqual(completeJSONRecords('{"type":"waiting"}'),[]);
});
test('held proof requires restoration, a live endpoint and deferred donor cleanup',()=>{
  assert.equal(heldResult(held()),true);
  for(const modify of [value=>{value.verified=false;},value=>{value.fs.restored=false;},
    value=>{value.fs.retainedEndpoint.ready=false;},value=>{value.fs.cleanup.deferred=false;},
    value=>{value.fs.cleanup.donor.cleanedUp=false;},value=>{value.rpc.state='closed';},
    value=>{value.error='failed';},value=>{value.completed='done';},value=>{value.cleanupErrors=[{error:'failed'}];}]){
    const value=held();modify(value);assert.equal(heldResult(value),false);
  }
});
test('held adapter bind failure preserves the Mac error without pairing, HID or replay',{timeout:10000},async t=>{
  const session=fixture(t,{bindFailure:true,latePairing:true});const result=await session.done;
  assert.equal(result.code,1,result.output+result.error);const failures=session.events().filter(event=>event.type==='network-unavailable');
  assert.equal(failures.length,1);assert.equal(failures[0].retrySafe,true);assert.equal(failures[0].address,'127.0.0.1');
  assert.match(failures[0].diagnostic,/listen EADDRNOTAVAIL.*127\.0\.0\.1:39380/);assert.match(failures[0].message,/Refresh network addresses/);
  assert.ok(session.events().some(event=>event.type==='log'&&event.message===failures[0].diagnostic));
  assert.equal(session.events().some(event=>['host-ready','post-run-ready','verified','failed','typing'].includes(event.type)),false);
  assert.equal(fs.existsSync(path.join(session.host,'runs/mac2jb-active-connect.txt')),false);
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  assert.equal(fs.readFileSync(path.join(session.host,'host-invocations.txt'),'utf8'),'once\n');
});
for(const bindEvidence of ['pairing','connected','native','typing'])
test('held adapter requires restart for bind failure after '+bindEvidence,{timeout:10000},async t=>{
  const session=fixture(t,{bindFailure:true,bindEvidence});const result=await session.done;assert.equal(result.code,1,result.output+result.error);
  assert.equal(session.events().some(event=>event.type==='network-unavailable'),false);
  const failure=session.events().find(event=>event.type==='failed');assert.equal(failure.retrySafe,false);
  assert.match(failure.message,/Mac network address.*Refresh network addresses/);assert.match(failure.message,/restart the console/);
  assert.match(failure.diagnostic,/EADDRNOTAVAIL/);assert.equal(session.events().some(event=>event.type==='verified'),false);
  assert.equal(fs.readFileSync(path.join(session.host,'host-invocations.txt'),'utf8'),'once\n');
});
test('choices stay deferred, inherited settings are fixed, status is read-only and choices run once',{timeout:10000},async t=>{
  const session=fixture(t);const ready=await session.wait('post-run-ready');
  assert.equal(fs.existsSync(path.join(session.root,'dump-invocations.txt')),false);
  assert.equal(session.events().some(event=>event.type==='verified'),false);
  const settings=JSON.parse(fs.readFileSync(path.join(session.host,'settings.json')));
  assert.deepEqual(settings.args,['--rpc','127.0.0.1']);assert.equal(settings.arity,'5');assert.equal(settings.rpc,'0');
  assert.equal(fs.realpathSync(settings.dump),settings.dump);assert.equal(fs.statSync(settings.dump).mode&0o077,0);
  assert.ok(ready.rpcCommand.includes('rpc.cjs'));
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});
  assert.equal((await session.wait('rpc-held')).rpcCommand,ready.rpcCommand);
  session.send({action:'rpc-status'});await session.wait('rpc-status-started');
  assert.equal((await session.wait('rpc-status')).ready,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.host,'status-calls.txt'),'utf8').trim()),{command:'status'});
  session.send({action:'post-run',keepRPC:true,dumpFirmware:true});await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root,'dump-invocations.txt')),false);
  session.send({action:'finish'});const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.ok(session.events().some(event=>event.type==='verified'));
  assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
  assert.equal(fs.existsSync(path.join(session.host,'runs/mac2jb-active-connect.txt')),false);
});
test('held host-ready exposes the current validated five-argument START and preserves normal cleanup',{timeout:10000},async t=>{
  const session=fixture(t,{pairingPrefix:['V=START(39380,127,0,0,1,0,0,0,0)',
    'V=START(39380,127,0,0,2)','V=START(39381,127,0,0,1)','V=START(39380,127,0,0,1);PRINT 1']});
  await session.wait('post-run-ready');
  const hostReady=session.events().filter(event=>event.type==='host-ready');assert.equal(hostReady.length,1);
  assert.equal(hostReady[0].startCommand,'V=START(39380,127,0,0,1)');
  const active=path.join(session.host,'runs/mac2jb-active-connect.txt');
  assert.equal(fs.readFileSync(active,'utf8'),session.pid()+'\n'+hostReady[0].startCommand+'\n');
  assert.equal(fs.statSync(active).mode&0o777,0o600);
  assert.equal(session.events().some(event=>['typing','command-start','transfer-complete'].includes(event.type)),false);
  session.send({action:'post-run',keepRPC:false,dumpFirmware:false});const result=await session.done;
  assert.equal(result.code,0,result.output+result.error);assert.ok(session.events().some(event=>event.type==='verified'));
  assert.equal(fs.existsSync(active),false);
});
test('Finish signals only the runner and allows cleanup longer than two seconds',{timeout:10000},async t=>{
  const session=fixture(t,{cleanupMs:2200});await session.wait('post-run-ready');
  const started=Date.now();session.send({action:'post-run',keepRPC:false,dumpFirmware:false});
  await session.wait('rpc-finishing');const result=await session.done;
  assert.equal(result.code,0,result.output+result.error);assert.ok(Date.now()-started>=2100);
  assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
  assert.equal(fs.readFileSync(path.join(session.host,'runner-signals.txt'),'utf8'),'TERM\n');
});
for(const action of ['finish','eof'])
  test('immediate '+action+' waits for the fork stop handler after the held sentinel',{timeout:10000},async t=>{
    const session=fixture(t,{signalDelayMs:350});await session.wait('post-run-ready');
    if(action==='finish')session.send({action:'finish'});else session.child.stdin.end();
    const result=await session.done;assert.equal(result.code,0,result.output+result.error);
    assert.ok(session.events().some(event=>event.type==='verified'));
    assert.equal(fs.readFileSync(path.join(session.host,'runner-signals.txt'),'utf8'),'TERM\n');
    assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
  });
for(const [name,options] of [['invalid held proof',{invalid:true}],['wrong session identity',{wrongSession:true}]])
  test(name+' never offers post-run options',{timeout:10000},async t=>{
    const session=fixture(t,options);const result=await session.done;assert.notEqual(result.code,0);
    assert.equal(session.events().some(event=>event.type==='post-run-ready'||event.type==='verified'),false);
    assert.ok(session.events().some(event=>event.type==='failed'));
  });
test('dump starts only after choice, ignores duplicates and preserves RPC afterward',{timeout:10000},async t=>{
  const session=fixture(t,{dumpMs:200});await session.wait('post-run-ready');
  session.send(null);session.send([]);await session.wait('action-rejected',2);
  session.send({action:'post-run',keepRPC:true,dumpFirmware:true});await session.wait('dump-started');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:true});
  session.send({action:'rpc-status'});session.send({action:'finish'});await session.wait('action-rejected',5);
  await session.wait('dump-complete');await session.wait('rpc-held');
  const records=fs.readFileSync(path.join(session.root,'dump-invocations.txt'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length,1);assert.equal(records[0].dump,records[0].env);
  const events=session.events();assert.ok(events.findIndex(event=>event.type==='dump-complete')<events.findIndex(event=>event.type==='rpc-held'));
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('held RPC can dump system code without another exploit and remain available for homebrew',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'dump-system-code'});await session.wait('dump-started');
  session.send({action:'dump-system-code'});await session.wait('action-rejected');
  await session.wait('dump-complete');await session.wait('rpc-held',2);
  const records=fs.readFileSync(path.join(session.root,'dump-invocations.txt'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length,1);
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  session.send({action:'finish'});assert.equal((await session.done).code,0);
  assert.equal(fs.readFileSync(path.join(session.host,'runner-signals.txt'),'utf8'),'TERM\n');
});
test('held RPC stops MintBrew before starting the system-code dump',{timeout:10000},async t=>{
  const session=fixture(t,{hblStopMs:70,hblCloseMs:60});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  session.send({action:'dump-system-code'});await session.wait('homebrew-stopped');
  await session.wait('dump-started');
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-stop-completed'),'utf8'),'yes');
  await session.wait('dump-complete');await session.wait('rpc-held',2);
  const invocations=fs.readFileSync(path.join(session.root,'dump-invocations.txt'),'utf8').trim().split('\n');
  assert.equal(invocations.length,1);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('held RPC never starts a dump if MintBrew native cleanup is unverified',{timeout:10000},async t=>{
  const session=fixture(t,{hblStopFail:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  session.send({action:'dump-system-code'});await session.wait('homebrew-failed');
  const outcome=await session.done;assert.notEqual(outcome.code,0);
  assert.equal(fs.existsSync(path.join(session.root,'dump-invocations.txt')),false);
  assert.equal(fs.existsSync(path.join(session.host,'runner-signals.txt')),false);
});
test('dump-only choice verifies inventory and finishes with full cleanup',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:false,dumpFirmware:true});await session.wait('dump-complete');
  assert.equal((await session.done).code,0);assert.ok(session.events().some(event=>event.type==='verified'));
});
for(const dumpFail of [false,true])
  test('automatic dump-only '+(dumpFail?'failure':'success')+' waits for delayed fork stop handler',{timeout:10000},async t=>{
    const session=fixture(t,{signalDelayMs:350,dumpMs:1,dumpFail});
    const ready=await session.wait('post-run-ready');
    assert.match(ready.message,/Preparing the selected session action/);
    session.send({action:'post-run',keepRPC:false,dumpFirmware:true});
    const result=await session.done;
    assert.equal(result.code,dumpFail?1:0,result.output+result.error);
    assert.equal(fs.readFileSync(path.join(session.host,'runner-signals.txt'),'utf8'),'TERM\n');
    assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
    assert.equal(session.events().some(event=>event.type==='verified'),!dumpFail);
    assert.equal(session.events().some(event=>event.type==='dump-complete'),!dumpFail);
    assert.equal(fs.readFileSync(path.join(session.root,'dump-invocations.txt'),'utf8').trim().split('\n').length,1);
  });
for(const [name,options] of [['helper failure',{dumpFail:true}],['incomplete manifest',{badManifest:true}]])
  test(name+' fails once without retry or false verification',{timeout:10000},async t=>{
    const session=fixture(t,options);await session.wait('post-run-ready');
    session.send({action:'post-run',keepRPC:true,dumpFirmware:true});assert.notEqual((await session.done).code,0);
    assert.equal(fs.readFileSync(path.join(session.root,'dump-invocations.txt'),'utf8').trim().split('\n').length,1);
    assert.equal(session.events().some(event=>event.type==='verified'||event.type==='dump-complete'),false);
    assert.ok(session.events().some(event=>event.type==='failed'));
  });
test('disconnect after held verification cannot become final success',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');process.kill(session.pid(),'SIGUSR1');
  assert.notEqual((await session.done).code,0);assert.ok(session.events().some(event=>event.type==='failed'));
  assert.equal(session.events().some(event=>event.type==='verified'),false);
});
test('network RPC loss while MintBrew is running stops the helper without claiming a recoverable session',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  process.kill(session.pid(),'SIGUSR1');
  const outcome=await session.done;
  assert.notEqual(outcome.code,0,outcome.output+outcome.error);
  assert.ok(session.events().some(event=>event.type==='failed'));
  assert.equal(session.events().some(event=>event.type==='verified'),false);
  assert.equal(fs.existsSync(path.join(session.host,'runner-signals.txt')),false);
});
test('EOF while held gracefully closes RPC and verifies cleanup',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');session.child.stdin.end();
  assert.equal((await session.done).code,0);assert.ok(session.events().some(event=>event.type==='verified'));
  assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
});
test('adapter SIGTERM while held gracefully closes the runner',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');session.child.kill('SIGTERM');
  assert.equal((await session.done).code,0);assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
});
test('closed output pipe cannot kill the adapter before held cleanup',{timeout:10000},async t=>{
  const session=fixture(t);await session.wait('post-run-ready');session.child.stdout.destroy();
  session.send({action:'rpc-status'});const result=await session.done;assert.notEqual(result.code,null,result.error);
  assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
  const final=JSON.parse(fs.readFileSync(path.join(session.host,'runs/switch2-test/result.json')));
  assert.equal(final.rpc.state,'closed');assert.equal(final.fs.cleanup.cleanedUp,true);
});
test('EOF during dump retains partial output and reports failure',{timeout:10000},async t=>{
  const session=fixture(t,{dumpMs:5000});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:true});await session.wait('dump-progress');
  session.child.stdin.end();assert.notEqual((await session.done).code,0);
  assert.ok(session.events().some(event=>event.type==='failed'));assert.equal(session.events().some(event=>event.type==='verified'),false);
});
test('status failure is nonterminal and Finish waits for an active status request',{timeout:10000},async t=>{
  const session=fixture(t,{statusFail:true,statusMs:150});await session.wait('post-run-ready');
  session.send({action:'rpc-status'});await session.wait('rpc-status-started');session.send({action:'finish'});
  await session.wait('action-rejected');assert.equal((await session.wait('rpc-status')).ready,false);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('zero exit without final cleanup cannot claim verification',{timeout:10000},async t=>{
  const session=fixture(t,{badCleanup:true});await session.wait('post-run-ready');session.send({action:'finish'});
  assert.notEqual((await session.done).code,0);assert.equal(session.events().some(event=>event.type==='verified'),false);
});
for(const application of ['mintbrew','izlauncher','custom-homebrew'])
test(application+' requires confirmed held RPC, runs once, and stops before base RPC cleanup',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblStopMs:150});await session.wait('post-run-ready');
  const launch={action:'launch-'+application,...(application==='custom-homebrew'?{customHomebrewPath:'/tmp/custom-gpu-app'}:{})};
  session.send(launch);await session.wait('action-rejected');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send(launch);await session.wait('homebrew-started');await session.wait('homebrew-running');
  session.send({action:'launch-mintbrew'});session.send({action:'rpc-status'});await session.wait('action-rejected',3);
  session.send({action:'finish'});const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.equal(fs.existsSync(path.join(session.root,{mintbrew:'mint-entry-used',izlauncher:'iz-entry-used','custom-homebrew':'custom-entry-used'}[application])),true);
  if(application==='izlauncher')assert.equal(fs.readFileSync(path.join(session.root,'iz-stream-host'),'utf8'),'127.0.0.1');
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,1);
  assert.match(session.events().find(event=>event.type==='verified').message,/retained graphics allocations/);
});
test('packaged runtime rejects unavailable launchers without consuming held RPC',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});await session.wait('post-run-ready');
  fs.writeFileSync(path.join(session.root,'packaging/runtime-homebrew.json'),JSON.stringify({allowed:['mintbrew','ouncecake']}));
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'list-izlauncher-modules'});
  assert.match((await session.wait('action-rejected')).message,/unavailable in this build/);
  session.send({action:'launch-izlauncher'});
  assert.match((await session.wait('action-rejected',2)).message,/unavailable in this build/);
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('held IZlauncher catalogs and forwards selected modules to its live package queue',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'list-izlauncher-modules'});
  assert.deepEqual((await session.wait('izlauncher-catalog')).modules,
    [{id:'blitbun',name:'BlitBun',version:'1.14.4',description:'Streaming'}]);
  session.send({action:'launch-izlauncher',moduleIds:['blitbun']});await session.wait('homebrew-running');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.root,'iz-args'),'utf8')),
    ['--modules','["iz-exchange","blitbun","vacootube"]']);
  session.send({action:'load-izlauncher-modules',ids:['blitbun']});
  const control=path.join(session.root,'iz-controls'),deadline=Date.now()+3000;
  while(!fs.existsSync(control)){assert.ok(Date.now()<deadline,'IZlauncher did not receive the selected module');
    await new Promise(resolve=>setTimeout(resolve,10));}
  assert.deepEqual(JSON.parse(fs.readFileSync(control,'utf8').trim()),{action:'load-modules',ids:['blitbun']});
  assert.equal((await session.wait('izlauncher-module-progress')).message,'Queued 1 IZlauncher module from this Mac.');
  assert.equal(session.events().some(event=>event.type==='homebrew-progress'&&event.message?.startsWith('Queued 1 IZlauncher module')),false);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('invalid custom app path does not consume the held RPC launch attempt',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/missing-app'});
  const rejected=await session.wait('action-rejected');
  assert.equal(rejected.action,'launch-custom-homebrew');
  assert.match(rejected.message,/incompatible app.json/);
  assert.equal(fs.existsSync(path.join(session.root,'custom-entry-used')),false);
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/custom-gpu-app'});
  assert.equal((await session.wait('homebrew-accepted')).action,'launch-custom-homebrew');
  await session.wait('homebrew-running');
  session.send({action:'finish'});
  const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.equal(fs.existsSync(path.join(session.root,'custom-entry-used')),true);
  assert.equal(fs.readFileSync(path.join(session.root,'custom-preflight-cleaned'),'utf8'),'yes');
});
test('custom launcher bundle uses the existing held RPC session',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,souljaLauncher:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/soulja-launcher'});
  assert.equal((await session.wait('homebrew-accepted')).action,'launch-custom-homebrew');
  await session.wait('homebrew-running');
  assert.equal(fs.existsSync(path.join(session.root,'custom-entry-used')),true);
  session.send({action:'finish'});
  const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.equal(fs.readFileSync(path.join(session.root,'custom-preflight-cleaned'),'utf8'),'yes');
});
test('a direct OunceCake-compatible fork uses held RPC and the game catalog',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,customRpcAdapter:'ouncecake'});
  await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/ouncecake-fork'});
  const rejected=await session.wait('action-rejected');
  assert.equal(rejected.action,'launch-custom-homebrew');
  assert.match(rejected.message,/IPv4|address/i);
  assert.equal(fs.existsSync(path.join(session.root,'custom-entry-used')),false);
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/ouncecake-fork',consoleAddress:'192.0.2.20'});
  const accepted=await session.wait('homebrew-accepted');
  assert.equal(accepted.customHomebrewKind,'rpc-app');
  assert.equal(accepted.adapter,'ouncecake');
  const catalog=await session.wait('homebrew-catalog');
  assert.deepEqual(catalog.games,[{titleId:'0100000000000001',name:'Fixture game',storages:[4]}]);
  session.send({action:'select-ouncecake-game',titleId:catalog.games[0].titleId});
  const running=await session.wait('homebrew-running');
  assert.equal(running.ftpURL,'ftp://192.0.2.20:2121');
  const config=JSON.parse(fs.readFileSync(path.join(session.root,'custom-config'),'utf8'));
  assert.equal(config.consoleAddress,'192.0.2.20');
  assert.equal(config.port,2121);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.root,'custom-selection'),'utf8')),
    {action:'select-game',titleId:catalog.games[0].titleId});
  session.send({action:'finish'});
  const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.equal(fs.readFileSync(path.join(session.root,'custom-preflight-cleaned'),'utf8'),'yes');
});
test('manifest-defined RPC app uses its own adapter with one launch attempt',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,customRpcAdapter:'script'});
  await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/custom-rpc-app'});
  const accepted=await session.wait('homebrew-accepted');
  assert.equal(accepted.customHomebrewKind,'rpc-app');
  assert.equal(accepted.adapter,'script');
  await session.wait('homebrew-running');
  session.send({action:'launch-mintbrew'});await session.wait('action-rejected');
  session.send({action:'finish'});
  const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.equal(fs.readFileSync(path.join(session.root,'custom-preflight-cleaned'),'utf8'),'yes');
});
test('invalid IZlauncher module can be corrected before claiming held RPC',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-izlauncher',moduleFolderPath:'/tmp/incompatible-izmodule'});
  const rejected=await session.wait('action-rejected');
  assert.equal(rejected.action,'launch-izlauncher');
  assert.match(rejected.message,/incompatible/);
  assert.equal(fs.existsSync(path.join(session.root,'iz-entry-used')),false);
  session.send({action:'launch-izlauncher',moduleFolderPath:'/tmp/compatible-izmodule'});
  assert.equal((await session.wait('homebrew-accepted')).action,'launch-izlauncher');
  await session.wait('homebrew-running');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.root,'iz-args'),'utf8')),
    ['--modules','["iz-exchange","blitbun","vacootube","my-module"]']);
  session.send({action:'finish'});
  const outcome=await session.done;assert.equal(outcome.code,0,outcome.output+outcome.error);
  assert.equal(fs.existsSync(path.join(session.root,'iz-entry-used')),true);
});
for(const terminal of ['failed','stopped'])
  test('Finish after homebrew-'+terminal+' waits for helper close without sending another signal',{timeout:10000},async t=>{
    const session=fixture(t,{expectHomebrew:true,hblTerminal:terminal,hblCloseMs:150});await session.wait('post-run-ready');
    session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
    session.send({action:'launch-mintbrew'});await session.wait('homebrew-'+terminal);
    session.send({action:'finish'});const outcome=await session.done;
    assert.equal(outcome.code,terminal==='failed'?1:0,outcome.output+outcome.error);
    assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
    assert.equal(fs.existsSync(path.join(session.root,'homebrew-extra-signal')),false);
  });
test('a failed MintBrew launch leaves Finish available and is never retried',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblFail:true,hblCloseMs:150});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-failed');
  assert.equal(session.child.exitCode,null);session.send({action:'launch-mintbrew'});await session.wait('action-rejected');
  session.send({action:'finish'});assert.equal((await session.done).code,1);
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,1);
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-extra-signal')),false);
});
test('read-only custom preparation failure keeps held RPC available for a different app',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblFailFirst:true,hblRetrySafe:true,souljaLauncher:true});
  await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-custom-homebrew',customHomebrewPath:'/tmp/soulja-launcher'});
  await session.wait('homebrew-accepted');
  const failure=await session.wait('homebrew-failed');
  assert.equal(failure.retrySafe,true,JSON.stringify(session.events()));
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,2);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('EOF during homebrew setup stops the helper before ending original RPC',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblLaunchMs:5000});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-started');session.child.stdin.end();
  assert.equal((await session.done).code,1);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});

test('MintBrew requires positive held proof, owns one app attempt, and finishes before its original host',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblLaunchMs:150,hblStopMs:100});
  await session.wait('post-run-ready');const originalHost=session.pid();
  session.send({action:'launch-mintbrew'});await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root,'mint-entry-used')),false);
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-started');
  session.send({action:'finish'});await session.wait('action-rejected',2);
  await session.wait('homebrew-running');
  for(const action of ['launch-mintbrew','launch-unavailable','launch-mintbrew','launch-ouncecake','rpc-status'])
    session.send({action,consoleAddress:'192.0.2.20'});
  await session.wait('action-rejected',7);
  assert.equal(session.pid(),originalHost);
  assert.equal(fs.readFileSync(path.join(session.root,'mint-entry-used'),'utf8'),path.join(session.host,'runs/switch2-test'));
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,1);
  session.send({action:'finish'});const result=await session.done;assert.equal(result.code,0,result.output+result.error);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
  assert.equal(fs.readFileSync(path.join(session.host,'runner-signals.txt'),'utf8'),'TERM\n');
  assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false);
});
test('another homebrew app prevents MintBrew in the same held session',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-izlauncher'});await session.wait('homebrew-running');
  session.send({action:'launch-mintbrew'});await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root,'mint-entry-used')),false);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('MintBrew startup failure consumes its attempt and leaves Finish available',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblFail:true});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-failed');
  session.send({action:'launch-mintbrew'});await session.wait('action-rejected');
  session.send({action:'finish'});const result=await session.done;assert.equal(result.code,1,result.output+result.error);
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,1);
  assert.equal(session.events().some(event=>event.type==='verified'),false);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});
for(const application of ['mintbrew','izlauncher'])test(application+' unexpected zero exit cannot claim shutdown or final verification',{timeout:10000},async t=>{
  const session=fixture(t);fs.writeFileSync(path.join(session.root,'scripts/gui-'+application+'.cjs'),
    "console.log('MAC2JB_HOMEBREW '+JSON.stringify({type:'started'}));process.exitCode=0;\n");
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-'+application});await session.wait('homebrew-failed');
  session.send({action:'launch-'+application});await session.wait('action-rejected');
  session.child.stdin.end();
  const result=await session.done;assert.equal(result.code,1,result.output+result.error);
  assert.equal(session.events().some(event=>event.type==='verified'),false);
});
for(const application of ['izlauncher','mintbrew'])test(application+' uncertain shutdown retains original native resources and blocks Finish',{timeout:10000},async t=>{
  const session=fixture(t);fs.writeFileSync(path.join(session.root,'scripts/gui-'+application+'.cjs'),
    "console.log('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',cleanupBlocked:true,message:'Native shutdown uncertain'}));process.exitCode=1;\n");
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-'+application});const failure=await session.wait('homebrew-failed');
  assert.equal(failure.cleanupBlocked,true);
  session.send({action:'finish'});await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.host,'runner-signals.txt')),false);
  session.child.stdin.end();assert.equal((await session.done).code,1);
  assert.equal(fs.existsSync(path.join(session.host,'runner-signals.txt')),false);
  assert.equal(session.events().some(row=>row.type==='verified'),false);
});
test('MintBrew short receive with confirmed native shutdown still permits normal held-session cleanup',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});fs.writeFileSync(path.join(session.root,'scripts/gui-mintbrew.cjs'),
    "process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync('homebrew-stop-completed','yes');console.log('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',cleanupBlocked:false,message:'Short receive; native workers joined'}));process.exitCode=1;});\n");
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});const failure=await session.wait('homebrew-failed');assert.equal(failure.cleanupBlocked,false);
  session.send({action:'finish'});assert.equal((await session.done).code,1);
  assert.equal(fs.readFileSync(path.join(session.host,'runner-signals.txt'),'utf8'),'TERM\n');
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
  assert.equal(session.events().some(row=>row.type==='action-rejected'),false);
});
test('EOF during MintBrew startup stops its helper before base RPC cleanup',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true,hblLaunchMs:5000});await session.wait('post-run-ready');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-started');session.child.stdin.end();
  assert.equal((await session.done).code,1);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});

test('MintBrew rejects invalid library configuration before consuming its one-app gate',{timeout:10000},async t=>{
  const session=fixture(t);
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-mintbrew',addonUrls:[],libraryItems:[null]});
  await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('invalid Stremio quality leaves the one-app gate available',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  let rejected=0;
  for(const quality of ['1080p','4k','720p --unsafe',720,null,{},['720p']]) {
    session.send({action:'launch-mintbrew',quality});await session.wait('action-rejected',++rejected);
  }
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});
test('unsupported homebrew actions leave the supported launcher available',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  session.send({action:'launch-unknown-launcher'});await session.wait('action-rejected');
  session.send({action:'launch-unavailable'});await session.wait('action-rejected',2);
  for(const action of ['launch-hblauncher','launch-gpubrewlauncher','launch-stremio'])session.send({action});
  await session.wait('action-rejected',5);
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  session.send({action:'launch-mintbrew'});await session.wait('homebrew-running');
  session.send({action:'finish'});assert.equal((await session.done).code,0);
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,1);
});

test('MintBrew launch keeps add-on configuration on helper stdin and retains the one-app session gate',{timeout:10000},async t=>{
  const session=fixture(t,{expectHomebrew:true});
  const helper=fs.readFileSync(path.join(session.root,'scripts/gui-homebrew.cjs'),'utf8');
  fs.writeFileSync(path.join(session.root,'scripts/gui-mintbrew.cjs'),
    "require('fs').writeFileSync('stremio-args.json',JSON.stringify(process.argv.slice(3)));let config='';process.stdin.on('data',b=>config+=b);process.stdin.on('end',()=>{require('fs').writeFileSync('stremio-config.json',config);console.log('MAC2JB_HOMEBREW '+JSON.stringify({type:'account-progress',watchProgress:{sequence:1,itemId:'PRIVATEWATCH',position:3,duration:30}}));});process.stdin.resume();\n"+helper);
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  const addonUrls=['https://example.invalid/private-provider/manifest.json'];
  const libraryItems=Array.from({length:200},(_,index)=>({_id:'fixture:'+index,name:'Private library '+ 'x'.repeat(512),state:{timeOffset:52000}}));
  session.send({action:'launch-mintbrew',addonUrls,libraryItems,quality:'720p'});
  await session.wait('homebrew-running');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.root,'stremio-config.json'),'utf8')),{addonUrls,libraryItems,quality:'720p'});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.root,'stremio-args.json'),'utf8')),[]);
  assert.equal((await session.wait('account-progress')).watchProgress.itemId,'PRIVATEWATCH');
  assert.equal(session.events().filter(event=>event.type==='log').some(event=>/PRIVATEWATCH|Private library/.test(event.message)),false);
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').includes('private-provider'),false);
  session.send({action:'launch-mintbrew'});await session.wait('action-rejected');
  session.send({action:'finish'});assert.equal((await session.done).code,0);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});

const ounceGame = {titleId:'0100000000000001',name:'Fixture game',storages:[4]};
function ounceFixture(t, options={}) {
  const session=fixture(t,{expectHomebrew:true});
  const source=String.raw`
    const fs=require('fs'); const options=OPTIONS;
    let config,selected=false,stopping=false,pending='';
    const emit=(type,fields={})=>console.log('MAC2JB_HOMEBREW '+JSON.stringify({type,path:process.argv[2],message:'fixture '+type,...fields}));
    const stopped=()=>{if(stopping)return;stopping=true;fs.appendFileSync('ounce-signals.txt','TERM\n');
      fs.writeFileSync('homebrew-stop-completed','yes');emit('stopped');setTimeout(()=>process.exit(0),20);};
    process.on('SIGTERM',stopped);
    fs.writeFileSync('homebrew-pid',String(process.pid));
    fs.appendFileSync('homebrew-invocations.txt',process.argv[2]+'\n');
    function running(){const host=options.wrongEndpoint?'192.0.2.50':config.consoleAddress;
      emit('running',{host,port:2121,ftpURL:'ftp://'+host+':2121'});
      if(options.exitAfterRunningZero)setTimeout(()=>process.exit(0),10);
      if(options.cleanupBlocked)setTimeout(()=>emit('failed',{cleanupBlocked:true}),20);
    }
    process.stdin.setEncoding('utf8');process.stdin.on('data',bytes=>{pending+=bytes;let at;
      while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);const value=JSON.parse(line);
        if(!config){config=value;fs.writeFileSync('ounce-config.json',JSON.stringify(config));emit('started');
          if(options.startupFail){fs.writeFileSync('homebrew-stop-completed','yes');emit('failed',{cleanupBlocked:false});setTimeout(()=>process.exit(1),20);continue;}
          if(options.prematureRunning){running();continue;}
          emit('catalog',{games:options.catalog||[{titleId:'0100000000000001',name:'Fixture game',storages:[4]}]});
          if(options.exitAfterCatalogZero)setTimeout(()=>process.exit(0),10);
          if(options.failedWhileChoosing)setTimeout(()=>emit('failed',{cleanupBlocked:true}),20);
        }else{
          fs.appendFileSync('ounce-selections.jsonl',JSON.stringify(value)+'\n');
          if(value.action!=='select-game'||selected)process.exit(8);
          selected=true;setTimeout(running,20);
        }
      }
    });process.stdin.resume();setInterval(()=>{},1000);
  `.replace('OPTIONS',JSON.stringify(options));
  fs.writeFileSync(path.join(session.root,'scripts/gui-ouncecake.cjs'),source);
  return session;
}
async function ounceHeld(session) {
  await session.wait('post-run-ready');session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
}
async function ounceLaunch(session) {
  await ounceHeld(session);session.send({action:'launch-ouncecake',consoleAddress:'192.0.2.20'});return session.wait('homebrew-catalog');
}
function noNativeCleanup(session,outcome) {
  assert.equal(outcome.code,1,outcome.output+outcome.error);
  assert.equal(session.events().some(event=>event.type==='verified'),false);
  assert.equal(fs.existsSync(path.join(session.host,'runner-signals.txt')),false,'Base runner must not receive native-cleanup SIGTERM');
  assert.equal(fs.existsSync(path.join(session.host,'group-signal.txt')),false,'Base descendants must not receive cleanup signals');
}

test('OunceCake requires confirmed held RPC, an explicit console IP and one tool per session',{timeout:10000},async t=>{
  const session=ounceFixture(t);
  await session.wait('post-run-ready');session.send({action:'launch-ouncecake',consoleAddress:'192.0.2.20'});await session.wait('action-rejected');
  session.send({action:'post-run',keepRPC:true,dumpFirmware:false});await session.wait('rpc-held');
  for(const consoleAddress of [undefined,'192.0.2.20:2121']){session.send({action:'launch-ouncecake',consoleAddress});await session.wait('action-rejected',consoleAddress===undefined?2:3);}
  assert.equal(fs.existsSync(path.join(session.root,'homebrew-invocations.txt')),false);
  session.send({action:'launch-ouncecake',consoleAddress:'192.0.2.20'});const catalog=await session.wait('homebrew-catalog');
  assert.deepEqual(catalog.games,[ounceGame]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session.root,'ounce-config.json'),'utf8')),{consoleAddress:'192.0.2.20',port:2121});
  session.send({action:'launch-mintbrew'});await session.wait('action-rejected',4);
  session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});const running=await session.wait('homebrew-running');
  assert.equal(running.host,'192.0.2.20');assert.equal(running.port,2121);assert.equal(running.ftpURL,'ftp://192.0.2.20:2121');
  session.send({action:'finish'});assert.equal((await session.done).code,0);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
  assert.equal(fs.readFileSync(path.join(session.root,'homebrew-invocations.txt'),'utf8').trim().split('\n').length,1);
});

test('OunceCake selection accepts one catalog member and rejects invalid, stale and repeated choices',{timeout:10000},async t=>{
  const session=ounceFixture(t);await ounceLaunch(session);
  for(const titleId of ['not-a-title','0100000000000002']){session.send({action:'select-ouncecake-game',titleId});await session.wait('action-rejected',titleId==='not-a-title'?1:2);}
  assert.equal(fs.existsSync(path.join(session.root,'ounce-selections.jsonl')),false);
  session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});await session.wait('homebrew-running');
  session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});await session.wait('action-rejected',3);
  assert.deepEqual(fs.readFileSync(path.join(session.root,'ounce-selections.jsonl'),'utf8').trim().split('\n').map(JSON.parse),[{action:'select-game',titleId:ounceGame.titleId}]);
  session.send({action:'finish'});assert.equal((await session.done).code,0);
});

test('Finish while OunceCake is choosing a game stops the helper before base cleanup',{timeout:10000},async t=>{
  const session=ounceFixture(t);await ounceLaunch(session);session.send({action:'finish'});
  assert.equal((await session.done).code,0);
  assert.equal(fs.existsSync(path.join(session.root,'ounce-selections.jsonl')),false);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});

test('closing OunceCake catalog controls stops its helper before base cleanup',{timeout:10000},async t=>{
  const session=ounceFixture(t);await ounceLaunch(session);session.child.stdin.end();
  assert.equal((await session.done).code,0);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
  assert.equal(fs.existsSync(path.join(session.root,'ounce-selections.jsonl')),false);
});

for(const option of ['prematureRunning','wrongEndpoint'])test(`OunceCake rejects ${option} before publishing FTP readiness`,{timeout:10000},async t=>{
  const session=ounceFixture(t,{[option]:true});
  if(option==='prematureRunning'){await ounceHeld(session);session.send({action:'launch-ouncecake',consoleAddress:'192.0.2.20'});}
  else{await ounceLaunch(session);session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});}
  await session.wait('homebrew-stopped');
  assert.equal(session.events().some(event=>event.type==='homebrew-running'),false);
  session.send({action:'finish'});const outcome=await session.done;
  assert.equal(outcome.code,1);assert.equal(session.events().some(event=>event.type==='verified'),false);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});

test('OunceCake startup failure is reported once, permits Finish and cannot verify workflow success',{timeout:10000},async t=>{
  const session=ounceFixture(t,{startupFail:true});await ounceHeld(session);session.send({action:'launch-ouncecake',consoleAddress:'192.0.2.20'});
  await session.wait('homebrew-failed');session.send({action:'finish'});const outcome=await session.done;
  assert.equal(outcome.code,1);assert.equal(session.events().some(event=>event.type==='verified'),false);
  assert.equal(session.events().filter(event=>event.type==='homebrew-failed').length,1);
  assert.equal(fs.readFileSync(path.join(session.host,'hbl-was-stopped.txt'),'utf8'),'true');
});

test('OunceCake cleanupBlocked rejects Finish and Stop kills only local processes without native cleanup',{timeout:10000},async t=>{
  const session=ounceFixture(t,{cleanupBlocked:true});await ounceLaunch(session);
  session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});await session.wait('homebrew-running');
  assert.equal((await session.wait('homebrew-failed')).cleanupBlocked,true);
  session.send({action:'finish'});await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.host,'runner-signals.txt')),false);
  session.child.kill('SIGTERM');noNativeCleanup(session,await session.done);
  assert.equal(fs.existsSync(path.join(session.root,'ounce-signals.txt')),false,'Uncertain helper must not execute another native shutdown');
});

test('OunceCake rejects a stale game choice after its helper reports failure',{timeout:10000},async t=>{
  const session=ounceFixture(t,{failedWhileChoosing:true});await ounceLaunch(session);await session.wait('homebrew-failed');
  session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});await session.wait('action-rejected');
  assert.equal(fs.existsSync(path.join(session.root,'ounce-selections.jsonl')),false);
  session.child.stdin.end();noNativeCleanup(session,await session.done);
});

for(const option of ['exitAfterCatalogZero','exitAfterRunningZero'])test(`OunceCake zero exit without stop confirmation blocks native cleanup (${option})`,{timeout:10000},async t=>{
  const session=ounceFixture(t,{[option]:true});await ounceLaunch(session);
  if(option==='exitAfterRunningZero'){session.send({action:'select-ouncecake-game',titleId:ounceGame.titleId});await session.wait('homebrew-running');}
  assert.equal((await session.wait('homebrew-failed')).cleanupBlocked,true);
  session.child.stdin.end();noNativeCleanup(session,await session.done);
});

test('OunceCake loses its original held endpoint without another native cleanup request',{timeout:10000},async t=>{
  const session=ounceFixture(t);await ounceLaunch(session);process.kill(session.pid(),'SIGUSR1');
  noNativeCleanup(session,await session.done);
  assert.equal(fs.existsSync(path.join(session.root,'ounce-signals.txt')),false);
});

test('OunceCake large catalog survives the helper output boundary',{timeout:10000},async t=>{
  const games=Array.from({length:500},(_,index)=>({titleId:(0x100000000000000n+BigInt(index)).toString(16).padStart(16,'0'),name:'x'.repeat(160),storages:[4]}));
  assert.ok(Buffer.byteLength(JSON.stringify(games))>65536);
  const session=ounceFixture(t,{catalog:games});const event=await ounceLaunch(session);
  assert.deepEqual(event.games,games);session.send({action:'finish'});assert.equal((await session.done).code,0);
});
