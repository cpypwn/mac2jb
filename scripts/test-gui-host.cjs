#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {validStart, verifiedResult, hidSettings,commandsOnlySettings, networkBindFailure} = require('./gui-host.cjs');
function command(address = '192.0.2.1') {
  return 'V=START(' + [39380, ...address.split('.')].join(',') + ')';
}
function fixture(t, sender, host) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-gui-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'vendor/ns2jb'), {recursive: true});
  fs.copyFileSync(path.join(__dirname, 'gui-host.cjs'), path.join(root, 'scripts/gui-host.cjs'));
  fs.copyFileSync(path.join(__dirname, 'host-profiles.cjs'), path.join(root, 'scripts/host-profiles.cjs'));
  fs.mkdirSync(path.join(root, 'packaging'));
  fs.copyFileSync(path.join(__dirname, '../packaging/host-profiles.json'), path.join(root, 'packaging/host-profiles.json'));
  fs.writeFileSync(path.join(root, 'assets/bootstrap.bas'), 'PRINT 1\n');
  if (sender) for (const name of ['mac2jb-send', 'mac2jb-commands'])
    fs.writeFileSync(path.join(root, name), '#!' + process.execPath + '\n' + sender, {mode: 0o700});
  if (host) fs.writeFileSync(path.join(root, 'vendor/ns2jb/run.cjs'), host);
  return root;
}
function run(root, args, env = {}) {
  const child = spawn(process.execPath, [path.join(root, 'scripts/gui-host.cjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}
  });
  let output = '', error = '';
  child.stdout.on('data', bytes => {output += bytes;});
  child.stderr.on('data', bytes => {error += bytes;});
  const done = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', code => resolve({code, output, error, events: output.trim().split('\n').filter(Boolean).map(JSON.parse)}));
  });
  return {child, done, events: () => output.split('\n').slice(0, -1).filter(Boolean).map(JSON.parse)};
}
async function until(predicate, message) {
  const started = performance.now();
  while (!predicate()) {
    assert.ok(performance.now() - started < 2500, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('pairing validation requires the expected address and complete command', () => {
  const value = command();
  assert.equal(validStart(value, '192.0.2.1'), true);
  assert.equal(validStart(value, '192.0.2.2'), false);
  assert.equal(validStart(value + 'garbage', '192.0.2.1'), false);
  for (const invalid of ['V=START(39380,192,0,2,1,0,0,0,0)', 'V=START(39380,192,0,2)',
    'V=START(39381,192,0,2,1)', 'V=START(39380,256,0,2,1)', 'V=START(39380,-1,0,2,1)',
    'V=START(39380,192,0,2,1.5)', 'V=START(39380,192,0,2,1);PRINT 1'])
    assert.equal(validStart(invalid, '192.0.2.1'), false, invalid);
});
test('pepsipu selection accepts only its real token-bearing pairing and refuses unsupported operations',async t=>{
  const {profileById}=require('./host-profiles.cjs');
  const profile=profileById('pepsipu');
  const nine='V=START(39380,192,0,2,1,123,456,789,281474976710655)';
  assert.equal(validStart(nine,'192.0.2.1',profile),true);
  assert.equal(validStart(command(),'192.0.2.1',profile),false);
  assert.equal(commandsOnlySettings(['--commands','start','--start-command',nine],profile).startCommand,nine);
  assert.throws(()=>commandsOnlySettings(['--commands','start','--start-command',command()],profile));
  const root=fixture(t,`require('fs').writeFileSync('unexpected-sender.txt','started');`);
  fs.writeFileSync(path.join(root,'selected-host.json'),JSON.stringify(profile));
  for(const args of [['host','192.0.2.1','--post-run-options'],['hid','save-bootstrap','auto','--demo']]) {
    const result=await run(root,args).done;
    assert.equal(result.code,1);assert.equal(fs.existsSync(path.join(root,'unexpected-sender.txt')),false);
  }
});
test('success requires independent FS verification, restoration and cleanup', () => {
  assert.equal(verifiedResult({verified: true}), false);
  assert.equal(verifiedResult({verified: true, fs: {verified: true, restored: true, cleanup: {cleanedUp: false}}}), false);
  assert.equal(verifiedResult({verified: true, fs: {verified: true, restored: true, cleanup: {cleanedUp: true}}}), true);
});
test('Mac network diagnostics match only unavailable binding of the selected host endpoint', () => {
  const line='Error: listen EADDRNOTAVAIL: address not available 192.0.2.1:39380';
  assert.deepEqual(networkBindFailure(line,'192.0.2.1'),{address:'192.0.2.1',diagnostic:line});
  for(const bad of [line.replace('EADDRNOTAVAIL','EADDRINUSE'),line.replace(':39380',':393800'),line.replace(':39380',':12345'),line.replace('192.0.2.1','192.0.2.11')])
    assert.equal(networkBindFailure(bad,'192.0.2.1'),null,bad);
});
function bindFailureScript(prefix='',latePairing=false) {
  const original='Error: listen EADDRNOTAVAIL: address not available 192.0.2.1:39380';
  return `require('fs').appendFileSync('host-invocations.txt','once\\n');
    process.stdout.write(${JSON.stringify(prefix+original+'\n    at Server.setupListenHandle (node:net:1:1)\n'+(latePairing?command()+'\n':''))});setInterval(()=>{},1000);`;
}
test('ordinary host bind failure preserves the cause, never publishes pairing and never retries', {timeout:5000}, async t => {
  const root=fixture(t,undefined,bindFailureScript('',true));
  const result=await run(root,['host','192.0.2.1']).done;
  assert.equal(result.code,1,result.error);
  const events=result.events.filter(event=>event.type==='network-unavailable');assert.equal(events.length,1);
  assert.equal(events[0].retrySafe,true);assert.equal(events[0].address,'192.0.2.1');assert.match(events[0].message,/Refresh network addresses/);
  assert.match(events[0].diagnostic,/listen EADDRNOTAVAIL.*192\.0\.2\.1:39380/);
  assert.ok(result.events.some(event=>event.type==='log'&&event.message===events[0].diagnostic));
  assert.equal(result.events.some(event=>['host-ready','verified','failed','typing'].includes(event.type)),false);
  assert.equal(fs.existsSync(path.join(root,'vendor/ns2jb/runs/mac2jb-active-connect.txt')),false);
  assert.equal(fs.readFileSync(path.join(root,'vendor/ns2jb/host-invocations.txt'),'utf8'),'once\n');
});
for(const prefix of [command()+'\n','Connected. Checking the application\n','1/4 native work\n','Sending: LOAD\n'])
test('ordinary host cannot call a bind failure safe after '+prefix.trim(),{timeout:5000},async t=>{
  const root=fixture(t,undefined,bindFailureScript(prefix));const result=await run(root,['host','192.0.2.1']).done;
  assert.equal(result.code,1);assert.equal(result.events.some(event=>event.type==='network-unavailable'),false);
  const failure=result.events.find(event=>event.type==='failed');assert.equal(failure.retrySafe,false);
  assert.match(failure.message,/Mac network address.*Refresh network addresses/);assert.match(failure.message,/restart the console/);
  assert.match(failure.diagnostic,/EADDRNOTAVAIL/);
  assert.equal(fs.readFileSync(path.join(root,'vendor/ns2jb/host-invocations.txt'),'utf8'),'once\n');
});
test('timing defaults and independent range limits are validated', () => {
  assert.deepEqual(hidSettings([]), {delay: 10, enumerationTimeout: 4,
    loadWaitMs: 1000, runWaitMs: 0, removeWaitMs: 0, loadConfirmWaitMs: 0});
  assert.equal(hidSettings(['2000', '--enumeration-timeout', '120', '--load-wait-ms', '0']).loadWaitMs, 0);
  for (const args of [['0'], ['2001'], ['50', '--enumeration-timeout', '0'],
    ['50', '--enumeration-timeout', '121'], ['50', '--run-wait-ms', '120001'],
    ['50', '--load-confirm-wait-ms', '-1']]) assert.throws(() => hidSettings(args));
});
test('demo edition is accepted while malformed flags and removed helpers are rejected', async t => {
  assert.equal(hidSettings(['--demo']).demo, true);
  assert.equal(hidSettings(['50','--demo']).demo, true);
  for (const args of [['--demo=true'], ['--demo','--demo']]) assert.throws(() => hidSettings(args));
  const root=fixture(t, `require('fs').writeFileSync('unexpected-sender.txt','started');`);
  const result=await run(root,['hid','demo-save','auto']).done;
  assert.equal(result.code,1);assert.equal(fs.existsSync(path.join(root,'unexpected-sender.txt')),false);
  assert.equal(result.events.some(event => ['controller','typing','transfer-complete'].includes(event.type)),false);
});
test('commands-only validates frozen subsets and manual START or prefix without an IP setting',()=>{
  const selected=commandsOnlySettings(['77','--commands','load,remove','--load-wait-ms','22']);
  assert.deepEqual(selected.commands,['load','remove']);assert.equal(selected.startPrefix,false);assert.equal(selected.delay,77);
  assert.equal(commandsOnlySettings(['--commands','start','--start-command',command()]).startCommand,command());
  assert.equal(commandsOnlySettings(['--commands','start','--start-prefix']).startPrefix,true);
  for(const args of [[],['--commands',''],['--commands','run,load'],['--commands','load,load'],['--commands','LOAD'],
    ['--commands','run,'],['--commands','start'],['--commands','run','--start-command',command()],
    ['--commands','start','--start-prefix','--start-command',command()],['--commands','start','--start-prefix','--start-prefix'],
    ['--commands','run','--commands','load'],['--commands','start','--start-command','V=START(39380,192,0,2,1,0,0,0,0)'],
    ['--commands','start','--start-command','V=START(39380,192,0,2,01)'],['--start-address','192.0.2.1'],['192.0.2.1','--commands','run']])
    assert.throws(()=>commandsOnlySettings(args),undefined,JSON.stringify(args));
});
for (const demo of [false,true]) test(`save-bootstrap submits only the ${demo?'demo':'full'} SAVE operation without host access`,async t=>{
  const root=fixture(t,`
    const fs=require('fs');fs.appendFileSync('save-calls.jsonl',JSON.stringify({helper:require('path').basename(process.argv[1]),controller:process.env.MAC2JB_CONTROLLER,args:process.argv.slice(2)})+'\\n');
    if(process.env.MAC2JB_CONTROLLER==='usb-drd15'){console.error('USB host did not enumerate a keyboard');process.exitCode=1;}
    else{
      const event=value=>console.log('MAC2JB_GUI '+JSON.stringify(value));
      event({type:'typing',kind:'save-bootstrap',completed:0,total:1});
      event({type:'command-start',step:1,completed:0,total:1,label:'SAVE'});
      event({type:'command-complete',step:1,completed:1,total:1,label:'SAVE'});
    }
  `,`require('fs').writeFileSync('unexpected-host.txt','started');`);
  fs.rmSync(path.join(root,'assets'),{recursive:true,force:true});
  const result=await run(root,['hid','save-bootstrap','auto',...(demo?['37','--demo']:[]),'--preferred-controller','usb-drd15','--load-wait-ms','22']).done;
  assert.equal(result.code,0,result.error);
  const calls=fs.readFileSync(path.join(root,'save-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(row=>row.controller),['usb-drd15','usb-drd0']);
  for(const call of calls){
    assert.equal(call.helper,'mac2jb-commands');assert.equal(call.args.includes('--save-bootstrap'),true);
    assert.equal(call.args.includes('--demo'),demo);assert.equal(call.args[call.args.indexOf('--delay-ms')+1],demo?'37':'10');
    assert.equal(call.args[call.args.indexOf('--load-wait-ms')+1],'22');
    assert.equal(call.args[call.args.indexOf('--save-name')+1],'NS2');
    assert.equal(call.args[call.args.indexOf('--load-name')+1],'NS2');
    assert.equal(call.args[call.args.indexOf('--start-port')+1],'39380');
    assert.equal(call.args.some(value=>['--commands','--start-command','--start-prefix'].includes(value)),false);
  }
  assert.deepEqual(result.events.filter(row=>row.type==='typing').map(row=>[row.kind,row.total,row.controller]),[['save-bootstrap',1,'usb-drd0']]);
  assert.deepEqual(result.events.filter(row=>row.type==='command-start'||row.type==='command-complete').map(row=>[row.type,row.kind,row.step,row.completed,row.total,row.label]),
    [['command-start','save-bootstrap',1,0,1,'SAVE'],['command-complete','save-bootstrap',1,1,1,'SAVE']]);
  const done=result.events.find(row=>row.type==='transfer-complete');assert.equal(done.kind,'save-bootstrap');assert.equal(done.completed,1);assert.equal(done.total,1);
  assert.equal(result.events.some(row=>['host-ready','verified','post-run-ready','rpc-held','wait'].includes(row.type)),false);
  assert.equal(fs.existsSync(path.join(root,'unexpected-host.txt')),false);assert.equal(fs.existsSync(path.join(root,'vendor/ns2jb/runs')),false);
});
test('save-bootstrap rejects arbitrary commands and START options before starting a worker',async t=>{
  const root=fixture(t,`require('fs').writeFileSync('unexpected-sender.txt','started');`);
  for(const args of [['--commands','load'],['--start-command',command()],['--start-prefix'],['--save-bootstrap'],['SAVE "OTHER"'],['--demo','--demo']]) {
    const result=await run(root,['hid','save-bootstrap','auto',...args]).done;
    assert.equal(result.code,1);assert.equal(result.events.some(row=>row.type==='controller'),false);
    assert.equal(fs.existsSync(path.join(root,'unexpected-sender.txt')),false);
  }
});
for(const fault of ['missing','missingStart','wrongLabel','wrongTotal','duplicate','malformed','unexpectedWait','failedExit','partial'])
test('save-bootstrap requires exact ordered completion and zero exit without retry: '+fault,async t=>{
  const root=fixture(t,`
    const event=value=>console.log('MAC2JB_GUI '+JSON.stringify(value)),fault=${JSON.stringify(fault)};
    if(fault!=='missingStart')event({type:'command-start',step:1,completed:0,total:1,label:'SAVE'});
    if(fault==='partial'){console.log('Sending: SAVE');console.error('USB host did not enumerate a keyboard');process.exitCode=1;}
    else if(fault!=='missing'){
      event({type:'command-complete',step:1,completed:1,total:fault==='wrongTotal'?4:1,label:fault==='wrongLabel'?'LOAD':'SAVE'});
      if(fault==='duplicate')event({type:'command-complete',step:1,completed:1,total:1,label:'SAVE'});
      if(fault==='malformed')console.log('MAC2JB_GUI {');
      if(fault==='unexpectedWait')event({type:'wait',completed:1,total:1,label:'LOAD confirmation',remainingMs:0,durationMs:0});
      if(fault==='failedExit')process.exitCode=1;
    }
  `);
  const result=await run(root,['hid','save-bootstrap','auto']).done;
  assert.equal(result.code,1,result.error);assert.equal(result.events.some(row=>row.type==='transfer-complete'),false);
  assert.equal(result.events.filter(row=>row.type==='controller').length,1);assert.ok(result.events.some(row=>row.type==='failed'&&row.partial));
});
test('cancelled SAVE typing never retries or reports completion',async t=>{
  const root=fixture(t,`
    process.on('SIGTERM',()=>{console.log('MAC2JB_GUI '+JSON.stringify({type:'command-complete',step:1,completed:1,total:1,label:'SAVE'}));process.exit(0);});
    console.log('MAC2JB_GUI '+JSON.stringify({type:'command-start',step:1,completed:0,total:1,label:'SAVE'}));setInterval(()=>{},1000);
  `);
  const runner=run(root,['hid','save-bootstrap','auto']);
  t.after(()=>runner.child.kill('SIGKILL'));
  await until(()=>runner.events().some(row=>row.type==='command-start'),'SAVE did not start');runner.child.kill('SIGTERM');
  const result=await runner.done;assert.equal(result.code,130,result.error);
  assert.equal(result.events.filter(row=>row.type==='controller').length,1);assert.ok(result.events.some(row=>row.type==='cancelled'));
  assert.equal(result.events.some(row=>row.type==='transfer-complete'),false);
});
test('commands-only forwards its chosen subset and timings without starting or consulting a host',async t=>{
  const root=fixture(t,`
    const fs=require('fs');fs.appendFileSync('commands-only.jsonl',JSON.stringify({helper:require('path').basename(process.argv[1]),controller:process.env.MAC2JB_CONTROLLER,args:process.argv.slice(2)})+'\\n');
    if(process.env.MAC2JB_CONTROLLER==='usb-drd0'){console.error('USB host did not enumerate a keyboard');process.exitCode=1;}
    else{
      const event=value=>console.log('MAC2JB_GUI '+JSON.stringify(value));event({type:'typing',completed:0,total:2});
      for(let step=1;step<=2;step++){event({type:'command-start',step,completed:step-1,total:2,label:['LOAD','REMOVE'][step-1]});event({type:'command-complete',step,completed:step,total:2,label:['LOAD','REMOVE'][step-1]});}
    }
  `,`require('fs').writeFileSync('unexpected-host.txt','started');`);
  fs.rmSync(path.join(root,'assets'),{recursive:true,force:true});
  const result=await run(root,['hid','commands-only','auto','77','--commands','load,remove','--load-wait-ms','22']).done;
  assert.equal(result.code,0,result.error);
  const calls=fs.readFileSync(path.join(root,'commands-only.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(row=>row.controller),['usb-drd0','usb-drd1']);
  for(const call of calls){
    assert.equal(call.helper,'mac2jb-commands');assert.equal(call.args[call.args.indexOf('--commands')+1],'load,remove');
    assert.equal(call.args.some(value=>['--start-address','--start-command','--start-prefix'].includes(value)),false);
    assert.equal(call.args[call.args.indexOf('--delay-ms')+1],'77');assert.equal(call.args[call.args.indexOf('--load-wait-ms')+1],'22');
  }
  assert.deepEqual(result.events.filter(row=>row.type==='command-complete').map(row=>[row.completed,row.total,row.label]),[[1,2,'LOAD'],[2,2,'REMOVE']]);
  assert.equal(result.events.find(row=>row.type==='typing').total,2);
  const done=result.events.find(row=>row.type==='transfer-complete');assert.equal(done.total,2);assert.equal(done.completed,2);assert.equal(Object.hasOwn(done,'startPending'),false);
  assert.equal(result.events.some(row=>['host-ready','verified','post-run-ready','rpc-held'].includes(row.type)),false);
  assert.match(done.message,/No host was started/);assert.equal(fs.existsSync(path.join(root,'unexpected-host.txt')),false);
  assert.equal(fs.existsSync(path.join(root,'vendor/ns2jb/runs')),false);
});
test('commands-only passes the exact supplied START without reconstructing it',async t=>{
  const supplied=command('198.51.100.17'),root=fixture(t,`
    require('fs').writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));
    const event=value=>console.log('MAC2JB_GUI '+JSON.stringify(value));
    event({type:'command-start',step:1,completed:0,total:1,label:'START'});event({type:'command-complete',step:1,completed:1,total:1,label:'START'});
  `);
  const result=await run(root,['hid','commands-only','usb-drd0','--commands','start','--start-command',supplied]).done;
  assert.equal(result.code,0,result.error);const args=JSON.parse(fs.readFileSync(path.join(root,'args.json')));
  assert.equal(args[args.indexOf('--start-command')+1],supplied);assert.equal(args.includes('--start-address'),false);
  assert.equal(result.events.find(row=>row.type==='transfer-complete').completed,1);
  assert.equal(fs.existsSync(path.join(root,'vendor/ns2jb/runs')),false);
});
for(const selected of [['start'],['load','run','remove','start']])
test('commands-only prefix completion keeps START unsubmitted for '+selected.join(','),async t=>{
  const root=fixture(t,`
    require('fs').writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));
    const selected=${JSON.stringify(selected)},event=value=>console.log('MAC2JB_GUI '+JSON.stringify(value));
    for(let index=0;index<selected.length;index++){
      const step=index+1,total=selected.length,label=selected[index].toUpperCase();
      event({type:'command-start',step,completed:index,total,label});
      if(label==='START')event({type:'command-prefix-complete',step,completed:index,total,label,prefix:'V=START(39380,',startPending:true});
      else event({type:'command-complete',step,completed:step,total,label});
    }
  `);
  const result=await run(root,['hid','commands-only','usb-drd0','--commands',selected.join(','),'--start-prefix']).done;
  assert.equal(result.code,0,result.error);
  const args=JSON.parse(fs.readFileSync(path.join(root,'args.json')));assert.equal(args.includes('--start-prefix'),true);assert.equal(args.includes('--start-command'),false);
  assert.deepEqual(result.events.find(row=>row.type==='command-prefix-complete'),{type:'command-prefix-complete',kind:'commands-only',step:selected.length,completed:selected.length-1,total:selected.length,label:'START',startPending:true});
  assert.equal(result.events.some(row=>row.type==='command-complete'&&row.label==='START'),false);
  const done=result.events.find(row=>row.type==='transfer-complete');assert.equal(done.startPending,true);assert.equal(done.completed,selected.length-1);assert.equal(done.total,selected.length);
  assert.match(done.message,/Enter has not been sent/);
});
for(const fault of ['missing','wrongPrefix','submittedInstead','failedExit'])
test('commands-only never offers prefix handoff without exact proof and zero exit: '+fault,async t=>{
  const root=fixture(t,`
    const event=value=>console.log('MAC2JB_GUI '+JSON.stringify(value));event({type:'command-start',step:1,completed:0,total:1,label:'START'});
    const fault=${JSON.stringify(fault)};
    if(fault==='submittedInstead')event({type:'command-complete',step:1,completed:1,total:1,label:'START'});
    else if(fault!=='missing')event({type:'command-prefix-complete',step:1,completed:0,total:1,label:'START',prefix:fault==='wrongPrefix'?'V=START(39380,0':'V=START(39380,',startPending:true});
    if(fault==='failedExit')process.exitCode=1;
  `);
  const result=await run(root,['hid','commands-only','auto','--commands','start','--start-prefix']).done;
  assert.equal(result.code,1,result.error);assert.equal(result.events.some(row=>row.type==='transfer-complete'),false);
  assert.equal(result.events.filter(row=>row.type==='controller').length,1);assert.ok(result.events.some(row=>row.type==='failed'&&row.partial));
});
test('commands-only rejects empty selections or malformed START before any native worker starts',async t=>{
  for(const args of [[],['--commands',''],['--commands','start'],['--commands','start','--start-command','V=START(39380,1,2,3,256)'],
    ['--commands','start','--start-command','V=START(39380,1,2,3,4);PRINT 1'],['192.0.2.1','--commands','run']]) {
    const root=fixture(t,`require('fs').writeFileSync('unexpected-sender.txt','started');`);
    const result=await run(root,['hid','commands-only','auto',...args]).done;
    assert.equal(result.code,1,result.error);assert.ok(result.events.some(row=>row.type==='failed'));
    assert.equal(result.events.some(row=>row.type==='controller'),false);assert.equal(fs.existsSync(path.join(root,'unexpected-sender.txt')),false);
  }
});
test('commands-only never probes another controller after selected command input begins',async t=>{
  const root=fixture(t,`console.log('Keyboard enumerated. Sending...');console.log('Sending: RUN');console.error('USB host did not enumerate a keyboard');process.exitCode=1;`);
  const result=await run(root,['hid','commands-only','auto','--commands','run']).done;
  assert.equal(result.code,1,result.error);assert.equal(result.events.filter(row=>row.type==='controller').length,1);
  assert.ok(result.events.some(row=>row.type==='failed'&&row.partial));assert.equal(result.events.some(row=>row.type==='transfer-complete'),false);
});
test('preferred HID controller parsing is bounded and optional',()=>{
  for(let index=0;index<=15;index++)assert.equal(hidSettings(['--preferred-controller','usb-drd'+index]).preferredController,'usb-drd'+index);
  assert.equal(commandsOnlySettings(['--commands','run','--preferred-controller','usb-drd15']).preferredController,'usb-drd15');
  for(const args of [['--preferred-controller'],['--preferred-controller','auto'],['--preferred-controller','usb-drd16'],
    ['--preferred-controller','usb-drd01'],['--preferred-controller','usb-drd3','--preferred-controller','usb-drd3'],['--preferred-controller=usb-drd3']])
    assert.throws(()=>hidSettings(args));
});
for(const kind of ['bootstrap'])test('the last responding controller is preferred for '+kind,async t=>{
  const root=fixture(t,`console.log('Error matching IOUSBDeviceInterface (0)...');console.log('Keyboard enumerated. Sending...');console.log('Sent line 1');`);
  const result=await run(root,['hid',kind,'auto','--preferred-controller','usb-drd13']).done;
  assert.equal(result.code,0,result.error);
  assert.deepEqual(result.events.filter(event=>event.type==='controller').map(event=>event.controller),['usb-drd13']);
  assert.equal(result.events.find(event=>event.type==='typing').controller,'usb-drd13');
});
for(const [preferred,expected] of [['usb-drd1',['usb-drd1','usb-drd0','usb-drd3']],['usb-drd15',['usb-drd15','usb-drd0','usb-drd1','usb-drd3']]])
test('exhausted non-enumerated HID candidates are deduplicated and conclusively safe: '+preferred,async t=>{
  const root=fixture(t,`console.error('USB host did not enumerate a keyboard on selected controller. Check data role, cable, and host USB descriptors.');process.exitCode=1;`);
  const result=await run(root,['hid','bootstrap','auto','--preferred-controller',preferred]).done;
  assert.equal(result.code,1,result.error);assert.deepEqual(result.events.filter(event=>event.type==='controller').map(event=>event.controller),expected);
  assert.equal(result.events.some(event=>event.type==='typing'),false);assert.equal(result.events.findLast(event=>event.type==='failed').retrySafe,true);
});
test('only a successful fallback controller is reported as HID enumeration proof',async t=>{
  const root=fixture(t,`if(process.env.MAC2JB_CONTROLLER==='usb-drd15'){console.error('USB host did not enumerate a keyboard');process.exitCode=1;}else{console.log('Keyboard enumerated. Sending...');console.log('Sent line 1');}`);
  const result=await run(root,['hid','bootstrap','auto','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,0,result.error);assert.deepEqual(result.events.filter(event=>event.type==='controller').map(event=>event.controller),['usb-drd15','usb-drd0']);
  assert.deepEqual(result.events.filter(event=>event.type==='typing').map(event=>event.controller),['usb-drd0']);
});
test('manual HID controller never falls back or accepts a preferred-controller override',async t=>{
  const root=fixture(t,`console.error('USB host did not enumerate a keyboard');process.exitCode=1;`);
  const manual=await run(root,['hid','bootstrap','usb-drd7']).done;assert.equal(manual.code,1);
  assert.deepEqual(manual.events.filter(event=>event.type==='controller').map(event=>event.controller),['usb-drd7']);assert.equal(manual.events.findLast(event=>event.type==='failed').retrySafe,true);
  const bad=await run(root,['hid','bootstrap','usb-drd7','--preferred-controller','usb-drd3']).done;
  assert.equal(bad.code,1);assert.equal(bad.events.some(event=>event.type==='controller'),false);assert.equal(bad.events.some(event=>event.retrySafe===true),false);
});
for(const diagnostic of ['USB configuration failed on selected controller','USB interface setup failed',
  'libusbd_init failed; check usbgadget.kext.','USB enumeration error: 0xdeadbeef\nUSB host did not enumerate a keyboard',
  'Waiting for USB host enumeration...'])
test('HID initialization/error text never authorizes probing or safe Skip: '+diagnostic.split('\n')[0],async t=>{
  const root=fixture(t,`console.error(${JSON.stringify(diagnostic)});process.exitCode=1;`);
  const result=await run(root,['hid','bootstrap','auto','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,1);assert.equal(result.events.filter(event=>event.type==='controller').length,1);
  assert.equal(result.events.some(event=>event.type==='typing'||event.retrySafe===true),false);
});
test('a bounded unresponsive HID worker can fail safely after its only attempt',{timeout:5000},async t=>{
  const root=fixture(t,`console.log('Waiting for USB host enumeration...');setInterval(()=>{},1000);`);
  const result=await run(root,['hid','bootstrap','usb-drd7','--enumeration-timeout','1']).done;
  assert.equal(result.code,1);assert.equal(result.events.findLast(event=>event.type==='failed').retrySafe,true);assert.equal(result.events.some(event=>event.type==='typing'),false);
});
test('late HID readiness after timeout cannot be cached, retried, or called a completed transfer',{timeout:5000},async t=>{
  const root=fixture(t,`const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{console.log('Keyboard enumerated. Sending...');process.exitCode=0;clearInterval(timer);});`);
  const result=await run(root,['hid','bootstrap','auto','--preferred-controller','usb-drd15','--enumeration-timeout','1']).done;
  assert.equal(result.code,1);assert.equal(result.events.filter(event=>event.type==='controller').length,1);
  assert.equal(result.events.some(event=>event.type==='typing'||event.type==='transfer-complete'||event.retrySafe===true),false);
  assert.ok(result.events.some(event=>event.type==='failed'&&event.partial));
});
test('malformed native progress prevents replay without becoming controller proof',async t=>{
  const root=fixture(t,`console.log('MAC2JB_GUI '+JSON.stringify({type:'line-start',line:0,completed:0,total:1}));console.error('USB host did not enumerate a keyboard');process.exitCode=1;`);
  const result=await run(root,['hid','bootstrap','auto','--preferred-controller','usb-drd15']).done;
  assert.equal(result.code,1);assert.equal(result.events.filter(event=>event.type==='controller').length,1);
  assert.equal(result.events.some(event=>event.type==='typing'||event.retrySafe===true),false);assert.ok(result.events.some(event=>event.type==='failed'&&event.partial));
});
test('only pre-enumeration failures probe another controller', async t => {
  const root = fixture(t, `
    if (process.env.MAC2JB_CONTROLLER === 'usb-drd0') {
      console.error('USB host did not enumerate a keyboard'); process.exitCode = 1;
    } else {console.log('Keyboard enumerated. Sending...'); process.stdout.write('\\rSent line 1');}
  `);
  const result = await run(root, ['hid', 'bootstrap', 'auto']).done;
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(result.events.filter(e => e.type === 'controller').map(e => e.controller), ['usb-drd0', 'usb-drd1']);
  assert.ok(result.events.some(e => e.type === 'progress' && e.completed === 1));
});
test('a partial transfer never probes another controller', async t => {
  const root = fixture(t, `console.log('Keyboard enumerated. Sending...'); console.error('Transfer stopped'); process.exitCode = 1;`);
  const result = await run(root, ['hid', 'bootstrap', 'auto']).done;
  assert.equal(result.code, 1);
  assert.equal(result.events.filter(e => e.type === 'controller').length, 1);
  assert.ok(result.events.some(e => e.type === 'failed' && e.partial === true));
});
for (const kind of ['bootstrap', 'commands']) for (const typing of [false, true]) {
  test(`${kind} helper signal termination reports the actual failure and never probes again (${typing ? 'partial typing' : 'before typing'})`, async t => {
    const root = fixture(t, `
      console.log(${JSON.stringify(typing ? 'Keyboard enumerated. Sending...' : 'Waiting for USB host enumeration...')});
      process.kill(process.pid, 'SIGTERM');
    `);
    const result = await run(root, ['hid', kind, 'auto']).done;
    assert.equal(result.code, 1, result.error);
    assert.deepEqual(result.events.filter(event => event.type === 'controller').map(event => event.controller), ['usb-drd0']);
    const failed = result.events.filter(event => event.type === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].helper, kind === 'bootstrap' ? 'mac2jb-send' : 'mac2jb-commands');
    assert.equal(failed[0].signal, 'SIGTERM');
    assert.equal(failed[0].controller, 'usb-drd0');
    assert.equal(failed[0].partial, typing);
    assert.match(failed[0].message, new RegExp(`${failed[0].helper} terminated by SIGTERM on usb-drd0`));
    assert.match(failed[0].message, /does not establish that the USB driver is missing/);
    assert.match(failed[0].message, /macOS crash reports and the session logs/);
    assert.match(failed[0].message, /Automatic retry was stopped/);
    assert.equal(result.events.some(event => event.type === 'transfer-complete'), false);
  assert.equal(result.events.some(event=>event.retrySafe===true),false);
  });
}
test('expected enumeration timeout signals still allow the next safe controller probe', {timeout: 5000}, async t => {
  const root = fixture(t, `
    if (process.env.MAC2JB_CONTROLLER === 'usb-drd0') {
      console.log('Waiting for USB host enumeration...'); setInterval(() => {}, 1000);
    } else {console.log('Keyboard enumerated. Sending...'); console.log('Sent line 1');}
  `);
  const result = await run(root, ['hid', 'bootstrap', 'auto', '50', '--enumeration-timeout', '1']).done;
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(result.events.filter(event => event.type === 'controller').map(event => event.controller), ['usb-drd0', 'usb-drd1']);
  assert.equal(result.events.some(event => event.type === 'failed'), false);
  assert.ok(result.events.some(event => event.type === 'transfer-complete'));
});
test('fragmented native line events show the current line before its completion', {timeout: 8000}, async t => {
  const root = fixture(t, `
    const fs = require('fs');
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const event = value => console.log('MAC2JB_GUI ' + JSON.stringify(value));
    (async () => {
      event({type:'line-start',line:0,completed:0,total:3});
      event({type:'line-start',line:1,completed:1,total:3});
      process.stdout.write('MAC2JB_GUI {"type":"line-');
      await pause(25);
      process.stdout.write('start","line":1,"completed":0,"total":3}\\n');
      console.log('Sent line 3'); // Legacy output must not override native state.
      while (!fs.existsSync('complete-first')) await pause(10);
      event({type:'line-complete',line:1,completed:1,total:3});
      event({type:'line-start',line:2,completed:1,total:3});
      while (!fs.existsSync('stop-second')) await pause(10);
      console.error('Transfer stopped midway through line 2'); process.exitCode = 1;
    })();
  `);
  fs.writeFileSync(path.join(root, 'assets/bootstrap.bas'), 'PRINT 1\nPRINT 2\nPRINT 3\n');
  const runner = run(root, ['hid', 'bootstrap', 'auto', '50', '--enumeration-timeout', '1']);
  t.after(async () => {runner.child.kill('SIGTERM'); await runner.done;});
  await until(() => runner.events().some(e => e.type === 'line-start'), 'Current line was not published while the sender paused');
  const first = runner.events().find(e => e.type === 'line-start');
  assert.deepEqual(first, {type: 'line-start', kind: 'bootstrap', line: 1, completed: 0, total: 3,
    message: 'Typing line 1 of 3'});
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(runner.events().filter(e => e.type === 'controller').length, 1);
  assert.equal(runner.events().some(e => e.type === 'line-complete' || e.type === 'progress'), false);
  assert.equal(runner.events().some(e => e.type === 'transfer-complete'), false);
  const typing = runner.events().findIndex(e => e.type === 'typing');
  assert.ok(typing >= 0);
  assert.equal(runner.events().slice(typing + 1).some(e => e.type === 'enumeration-progress'), false);
  fs.writeFileSync(path.join(root, 'complete-first'), '');
  await until(() => runner.events().some(e => e.type === 'line-start' && e.line === 2), 'Second current line was not published');
  assert.deepEqual(runner.events().filter(e => e.type === 'line-complete').map(e => e.completed), [1]);
  fs.writeFileSync(path.join(root, 'stop-second'), '');
  const result = await runner.done;
  assert.equal(result.code, 1, result.error);
  assert.equal(result.events.filter(e => e.type === 'line-start').length, 2);
  assert.deepEqual(result.events.filter(e => e.type === 'line-complete').map(e => e.completed), [1]);
  assert.equal(result.events.find(e => e.type === 'line-complete').message, 'Sent line 1 of 3');
  assert.equal(result.events.some(e => e.type === 'progress'), false);
  assert.ok(result.events.some(e => e.type === 'failed' && e.partial));
});
test('legacy line progress stays within source bounds and includes the final unterminated line', async t => {
  const root = fixture(t, `console.log('Sent line 1'); console.log('Sent line 2'); console.log('Sent line 99');`);
  fs.writeFileSync(path.join(root, 'assets/bootstrap.bas'), 'PRINT 1\r\nPRINT 2');
  const result = await run(root, ['hid', 'bootstrap', 'usb-drd0']).done;
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(result.events.filter(e => e.type === 'progress'), [
    {type: 'progress', kind: 'bootstrap', line: 2, completed: 1, total: 2},
    {type: 'progress', kind: 'bootstrap', line: 2, completed: 2, total: 2}
  ]);
});
for (const kind of ['bootstrap'])
test(`${kind} forwards valid native ETA and omits invalid estimates`, async t => {
  const total = 1;
  const root = fixture(t, `
    const event = value => console.log('MAC2JB_GUI ' + JSON.stringify(value));
    for (const remainingMs of [1250.75,0,-1,'200',null])
      event({type:'line-start',line:1,completed:0,total:${total},remainingMs});
    console.log('MAC2JB_GUI {"type":"line-start","line":1,"completed":0,"total":${total},"remainingMs":1e999}');
    event({type:'line-complete',line:1,completed:1,total:${total},remainingMs:0});
  `);
  const result = await run(root, ['hid', kind, 'usb-drd0']).done;
  assert.equal(result.code, 0, result.error);
  const starts = result.events.filter(event => event.type === 'line-start');
  assert.equal(starts.length, 6);
  assert.deepEqual(starts.slice(0,2).map(event => event.remainingMs), [1250.75,0]);
  assert.ok(starts.slice(2).every(event => !Object.hasOwn(event,'remainingMs')));
  assert.ok(starts.every(event => event.kind === kind && event.total === total));
  assert.equal(result.events.find(event => event.type === 'line-complete').remainingMs, 0);
});
test('typing evidence arriving during timeout shutdown prevents retry', {timeout: 10000}, async t => {
  const root = fixture(t, `
    process.on('SIGTERM', () => {console.log('Keyboard enumerated. Sending...'); process.exitCode = 1; clearInterval(timer);});
    console.log('Waiting for USB host enumeration...'); const timer = setInterval(() => {}, 1000);
  `);
  const result = await run(root, ['hid', 'bootstrap', 'auto']).done;
  assert.equal(result.code, 1);
  assert.equal(result.events.filter(e => e.type === 'controller').length, 1);
  assert.ok(result.events.some(e => e.partial === true));
});
test('host preserves the full pairing output and accepts verified result', async t => {
  const pairing = command();
  const root = fixture(t, undefined, `
    const fs = require('fs'); const path = require('path'); process.umask(0o077);
    const directory = path.join(__dirname, 'runs', 'test-session'); fs.mkdirSync(directory, {recursive: true});
    console.log(${JSON.stringify('  ' + pairing)}); console.log('Run folder: ' + directory);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({verified:true,fs:{verified:true,restored:true,cleanup:{cleanedUp:true}}}));
    setTimeout(() => {}, 150);
  `);
  const result = await run(root, ['host', '192.0.2.1']).done;
  assert.equal(result.code, 0, result.error);
  assert.ok(result.events.some(e => e.type === 'log' && e.message.trim() === pairing));
  assert.deepEqual(result.events.find(e => e.type === 'host-ready'),
    {type:'host-ready',startCommand:pairing,message:'Fresh host pairing is ready.'});
  assert.ok(result.events.some(e => e.type === 'verified'));
  assert.equal(fs.existsSync(path.join(root, 'vendor/ns2jb/runs/mac2jb-active-connect.txt')), false);
  assert.equal(fs.statSync(path.join(root, 'vendor/ns2jb/runs')).mode & 0o777, 0o700);
});
test('host-ready exposes only the current validated START after private pairing publication',async t=>{
  const pairing=command(),root=fixture(t,undefined,`
    for(const line of ['V=START(39380,192,0,2,1,0,0,0,0)','V=START(39380,192,0,2,2)',
      'V=START(39381,192,0,2,1)','V=START(39380,192,0,2,1);PRINT 1'])console.log(line);
    console.log('  '+${JSON.stringify(pairing)}+'  ');console.log(${JSON.stringify(pairing)});
    setInterval(()=>{},1000);
  `);
  const runner=run(root,['host','192.0.2.1']);
  t.after(async()=>{runner.child.kill('SIGTERM');await runner.done;});
  await until(()=>runner.events().some(event=>event.type==='host-ready'));
  const event=runner.events().find(event=>event.type==='host-ready');assert.equal(event.startCommand,pairing);
  const active=path.join(root,'vendor/ns2jb/runs/mac2jb-active-connect.txt');
  assert.equal(fs.statSync(active).mode&0o777,0o600);assert.equal(fs.readFileSync(active,'utf8').split('\n')[1],pairing);
  runner.child.kill('SIGTERM');const result=await runner.done;
  assert.equal(result.events.filter(event=>Object.hasOwn(event,'startCommand')).length,1);
  assert.equal(result.events.some(event=>['typing','command-start','transfer-complete'].includes(event.type)),false);
  assert.equal(fs.existsSync(active),false);
});
test('GUI host fixes bootstrap arity and disables inherited held RPC mode', async t => {
  const pairing = 'V=START(39380,192,0,2,1)';
  const root = fixture(t, undefined, `
    const fs = require('fs'); const path = require('path');
    fs.writeFileSync(path.join(__dirname, 'host-settings.json'), JSON.stringify({
      arity: process.env.NS2_BASIC_ARITY, rpc: process.env.NS2_RPC_MODE,
      args: process.argv.slice(2)
    }));
    console.log(${JSON.stringify(pairing)});
  `);
  const result = await run(root, ['host', '192.0.2.1'], {NS2_BASIC_ARITY: '9', NS2_RPC_MODE: '1'}).done;
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'vendor/ns2jb/host-settings.json')));
  assert.deepEqual(settings, {arity: '5', rpc: '0', args: ['192.0.2.1']});
  assert.ok(result.events.some(e => e.type === 'host-ready'));
});
test('USB command and failure output preserve the full pairing command', async t => {
  const pairing = command();
  const root = fixture(t, `
    console.log('Sending: ' + ${JSON.stringify(pairing)});
    console.error('Transfer stopped after ' + ${JSON.stringify(pairing)});
    process.exitCode = 1;
  `);
  const result = await run(root, ['hid', 'commands', 'usb-drd0']).done;
  assert.equal(result.code, 1);
  assert.ok(result.events.some(e => e.type === 'command' && e.message === 'Sending: ' + pairing));
  assert.ok(result.events.some(e => e.type === 'log' && e.message === 'Transfer stopped after ' + pairing));
  assert.ok(result.events.some(e => e.type === 'failed' && e.partial === true));
});
test('host rejects a claimed success without restoration', async t => {
  const root = fixture(t, undefined, `
    const fs = require('fs'); const path = require('path'); process.umask(0o077);
    const directory = path.join(__dirname, 'runs', 'test-session'); fs.mkdirSync(directory, {recursive: true});
    console.log('Run folder: ' + directory);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({verified:true,fs:{verified:true,restored:false,cleanup:{cleanedUp:true}}}));
  `);
  const result = await run(root, ['host', '192.0.2.1']).done;
  assert.equal(result.code, 1);
  assert.equal(result.events.some(e => e.type === 'verified'), false);
});
test('cancellation stops the owned native worker', async t => {
  const root = fixture(t, `console.log('Keyboard enumerated. Sending...'); setInterval(() => {}, 1000);`);
  const {child, done} = run(root, ['hid', 'bootstrap', 'auto']);
  await new Promise(resolve => child.stdout.once('data', resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  child.kill('SIGTERM');
  const result = await done;
  assert.equal(result.code, 130);
  assert.ok(result.events.some(e => e.type === 'cancelled'));
});
test('selected enumeration window is counted down and bounded', {timeout: 5000}, async t => {
  const root = fixture(t, `
    console.log('Waiting for USB host enumeration...');
    process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000);
  `);
  const started = performance.now();
  const result = await run(root, ['hid', 'bootstrap', 'usb-drd0', '60', '--enumeration-timeout', '1']).done;
  const elapsed = performance.now() - started;
  assert.equal(result.code, 1);
  assert.ok(elapsed >= 900 && elapsed < 2500, `Elapsed ${elapsed}ms`);
  const countdown = result.events.filter(e => e.type === 'enumeration-progress');
  assert.ok(countdown.length >= 2);
  assert.ok(countdown.every(e => e.total === 1000 && e.remainingMs >= 0 && e.completed <= 1000));
  assert.ok(countdown.at(-1).remainingMs <= 10);
});
test('post-command typing, waits and progress replace enumeration and preserve tuning', {timeout: 5000}, async t => {
  const root = fixture(t, `
    const fs = require('fs'); fs.writeFileSync('timing-args.json', JSON.stringify({args:process.argv.slice(2), timeout:process.env.MAC2JB_ENUMERATION_TIMEOUT_SECONDS}));
    const event = value => console.log('MAC2JB_GUI ' + JSON.stringify(value));
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      await pause(150); event({type:'typing',completed:0,total:4});
      for (let step=1;step<=4;step++) {
        event({type:'command-start',step,completed:step-1,total:4,label:['LOAD','RUN','REMOVE','START'][step-1]});
        console.log('Sending: ' + ['LOAD','RUN','REMOVE','START'][step-1]); await pause(20);
        event({type:'command-complete',step,completed:step,total:4,label:['LOAD','RUN','REMOVE','START'][step-1]});
        if(step<4) {event({type:'wait',completed:step,total:4,label:'after command',remainingMs:25,durationMs:25});await pause(25);}
      }
      await pause(1100);
    })();
  `);
  const result = await run(root, ['hid', 'commands', 'usb-drd1', '77', '--enumeration-timeout', '1',
    '--load-confirm-wait-ms', '11', '--load-wait-ms', '22', '--run-wait-ms', '33', '--remove-wait-ms', '44']).done;
  assert.equal(result.code, 0, result.error);
  const forwarded = JSON.parse(fs.readFileSync(path.join(root, 'timing-args.json')));
  assert.equal(forwarded.timeout, '1');
  assert.equal(forwarded.args.includes('--demo'), false);
  for (const [flag, value] of [['--delay-ms','77'], ['--enumeration-timeout','1'], ['--load-confirm-wait-ms','11'],
    ['--load-wait-ms','22'], ['--run-wait-ms','33'], ['--remove-wait-ms','44']])
    assert.equal(forwarded.args[forwarded.args.indexOf(flag)+1], value);
  const typing = result.events.findIndex(e => e.type === 'typing');
  assert.ok(typing >= 0);
  assert.equal(result.events.slice(typing+1).some(e => e.type === 'enumeration-progress'), false);
  assert.deepEqual(result.events.filter(e => e.type === 'command-complete').map(e => e.completed), [1,2,3,4]);
  assert.equal(result.events.filter(e => e.type === 'wait').length, 3);
  assert.ok(result.events.some(e => e.type === 'transfer-complete'));
});
test('a launch error clears even a long enumeration countdown immediately', {timeout: 2000}, async t => {
  const root = fixture(t);
  const result = await run(root, ['hid', 'bootstrap', 'usb-drd0', '50', '--enumeration-timeout', '120']).done;
  assert.equal(result.code, 1);
  assert.ok(result.events.some(e => e.type === 'failed' && /ENOENT/.test(e.message)));
});

for (const kind of ['commands', 'commands-only']) for (const demo of [false, true]) {
  test(`${kind} forwards ${demo ? 'demo' : 'full'} edition to the native sender`, async t => {
    const root=fixture(t, `
      require('fs').writeFileSync('edition-args.json', JSON.stringify(process.argv.slice(2)));
      for(let step=1;step<=4;step++) console.log('MAC2JB_GUI '+JSON.stringify({type:'command-complete',step,completed:step,total:4,label:['LOAD','RUN','REMOVE','START'][step-1]}));
    `);
    const args=['hid',kind,'usb-drd1','50',...(demo?['--demo']:[]),
      ...(kind==='commands-only'?['--commands','load,run,remove,start','--start-command',command()]:[])];
    const result=await run(root,args).done;
    assert.equal(result.code,0,result.error);
    const forwarded=JSON.parse(fs.readFileSync(path.join(root,'edition-args.json')));
    assert.equal(forwarded.includes('--demo'),demo);
  });
}
