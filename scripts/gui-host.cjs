#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {selectedProfile, profileById, validStartCommand, incompatibleLegacyStartHint} = require('./host-profiles.cjs');
const root = path.resolve(__dirname, '..');
const timingDefaults = Object.freeze({delay: 10, enumerationTimeout: 4, loadWaitMs: 1000,
  runWaitMs: 0, removeWaitMs: 0, loadConfirmWaitMs: 0});
function hidSettings(args) {
  const settings = {...timingDefaults};
  const values = [...args];
  if (values.length && !values[0].startsWith('--')) settings.delay = Number(values.shift());
  const options = {'--enumeration-timeout': 'enumerationTimeout', '--load-wait-ms': 'loadWaitMs',
    '--run-wait-ms': 'runWaitMs', '--remove-wait-ms': 'removeWaitMs', '--load-confirm-wait-ms': 'loadConfirmWaitMs'};
  while (values.length) {
    const option = values.shift();
    if (option === "--demo") {
      if (settings.demo) throw Error("Duplicate --demo.");
      settings.demo = true; continue;
    }
    const text = values.shift();
    if(option==='--preferred-controller') {
      if(settings.preferredController!==undefined||!/^usb-drd(?:[0-9]|1[0-5])$/.test(text||''))throw Error('Invalid or duplicate preferred USB controller.');
      settings.preferredController=text;continue;
    }
    if (!options[option] || text === undefined || !/^\d+$/.test(text)) throw Error('Invalid HID timing option: ' + option);
    settings[options[option]] = Number(text);
  }
  for (const name of Object.keys(timingDefaults)) {
    const value = settings[name];
    const minimum = name === 'delay' || name === 'enumerationTimeout' ? 1 : 0;
    const maximum = name === 'delay' ? 2000 : name === 'enumerationTimeout' ? 120 : 120000;
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw Error(`Invalid ${name}: use ${minimum}..${maximum}.`);
  }
  return settings;
}
function commandsOnlySettings(args, profile = profileById('kurumuz')) {
  const timings=[];let csv,startCommand,startPrefix=false;
  for(let index=0;index<args.length;index++) {
    const option=args[index];
    if(option==='--commands'||option==='--start-command') {
      const value=args[++index];
      if(value===undefined||(option==='--commands'?csv!==undefined:startCommand!==undefined))throw Error('Missing or duplicate '+option+'.');
      if(option==='--commands')csv=value;else startCommand=value;
    } else if(option==='--start-prefix') {
      if(startPrefix)throw Error('Duplicate --start-prefix.');startPrefix=true;
    } else timings.push(option);
  }
  const names=['load','run','remove','start'],commands=typeof csv==='string'?csv.split(','):[];
  let previous=-1;
  if(!commands.length||commands.some(name=>{const index=names.indexOf(name);if(index<=previous)return true;previous=index;return false;}))
    throw Error('Choose a nonempty unique command subset in load,run,remove,start order.');
  const selectedStart=commands.includes('start');
  const validManual=validStartCommand(startCommand,profile);
  if((startPrefix&&startCommand!==undefined)||((startPrefix||startCommand!==undefined)&&!selectedStart)||
    (selectedStart&&!startPrefix&&!validManual))
    throw Error(`Selected START needs either --start-prefix or the exact ${profile.startArgumentCount}-argument host START command.`);
  return {...hidSettings(timings),commands,startPrefix,...(startCommand===undefined?{}:{startCommand})};
}
function emit(type, fields = {}) { process.stdout.write(JSON.stringify({type, ...fields}) + '\n'); }
function lines(stream, callback, limit = 65536) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', bytes => {
    pending += bytes.toString();
    let match;
    while ((match = pending.search(/[\r\n]/)) >= 0) {
      const line = pending.slice(0, match); pending = pending.slice(match + 1);
      if (line) callback(Buffer.byteLength(line) > limit ? '[Input line exceeded its size limit]' : line);
    }
    if (Buffer.byteLength(pending) > limit) {callback('[Input line exceeded its size limit]'); pending = '';}
  });
  stream.on('end', () => {if (pending) callback(pending);});
}
function validStart(line, address, profile = profileById('kurumuz')) {
  return validStartCommand(line,profile,address);
}
function verifiedResult(result) {
  return result?.verified === true && result?.fs?.verified === true &&
    result?.fs?.restored === true && result?.fs?.cleanup?.cleanedUp === true;
}
function networkBindFailure(line, address, port = 39380) {
  const match = /\blisten\s+EADDRNOTAVAIL\b.*?\s(\d+(?:\.\d+){3}):(\d+)\b/.exec(line);
  if (!match || match[1] !== address || match[2] !== String(port)) return null;
  return {address, diagnostic: line.trim().slice(0, 2048)};
}
function networkUnavailableMessage(address) {
  return `The Mac network address ${address} is no longer available. Refresh network addresses, choose the current Mac LAN address, and start again.`;
}
function signalGroup(child, signal) {
  if (!child?.pid) return;
  try {process.kill(-child.pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
}
let current, stopping = false, stopTimer;
function stop() {
  stopping = true;
  signalGroup(current, 'SIGTERM');
  stopTimer = setTimeout(() => signalGroup(current, 'SIGKILL'), 2000);
  stopTimer.unref();
}
async function host(address) {
  if (!net.isIPv4(address)) throw Error('Choose the Mac’s LAN IPv4 address.');
  const profile = selectedProfile(root);
  const folder = path.join(root, 'vendor/ns2jb');
  const runs = path.join(folder, 'runs');
  fs.mkdirSync(runs, {recursive: true, mode: 0o700}); fs.chmodSync(runs, 0o700);
  const active = path.join(runs, 'mac2jb-active-connect.txt');
  // A unique extracted workspace belongs to one GUI launch. Never overwrite an
  // existing record, including a symlink or a record from another host.
  if (fs.existsSync(active) || (() => {try {fs.lstatSync(active); return true;} catch {return false;}})())
    throw Error('This session already has a pairing record. Stop it and start a fresh session.');
  const izmysh = profile.engine === 'izmysh';
  const engineFolder = izmysh ? path.join(root, profile.sourceDirectory) : folder;
  current = spawn(process.execPath, izmysh ? [path.join(engineFolder, 'server/host.cjs'), address] : ['run.cjs', address], {
    cwd: engineFolder, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Use the selected host's matching bootstrap without changing its source.
    // GUI sessions finish after verification, regardless of inherited settings.
    env: {...process.env, NS2_BASIC_ARITY: String(profile.startArgumentCount), NS2_RPC_MODE: '0',
      ...(izmysh ? {IZ_SESSION_DIR: runs, HB_PORT: String(profile.startPort)} : {})}
  });
  const child = current;
  let published = false, directory, publicationError, networkFailure, networkTimer, progressed = false, qualified = false;
  function output(line) {
    try {
    const clean = line.trim();
    const bindFailure = networkBindFailure(clean, address, profile.startPort);
    if (bindFailure && !networkFailure) {
      networkFailure = bindFailure;
      signalGroup(child, 'SIGTERM');
      networkTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000); networkTimer.unref();
    }
    if (/^V=START\(\d+(?:,\d+)+\)$/.test(clean) && validStart(clean, address, profile) && !published && !stopping && !networkFailure) {
      const temporary = active + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, `${child.pid}\n${clean}\n`, {mode: 0o600, flag: 'wx'});
      // link provides no-replace publication, unlike rename on an existing file.
      try {fs.linkSync(temporary, active);} finally {fs.unlinkSync(temporary);}
      published = true;
      emit('host-ready', {startCommand: clean, message: 'Fresh host pairing is ready.'});
    }
    if (clean.startsWith('Run folder: ')) {
      const candidate = path.resolve(clean.slice('Run folder: '.length));
      if (candidate.startsWith(runs + path.sep)) {directory = candidate; progressed = true; emit('run-folder', {path: candidate});}
    }
    if (/^(?:Waiting for Switch 2 at |Console listener ready at |Connected\b|[1-4]\/4 |Sending: |MAC2JB_GUI |Keyboard enumerated\. Sending|Typing line |Sent line )/.test(clean)) progressed = true;
    if (clean.startsWith('Waiting for Switch 2 at ') || clean.startsWith('Console listener ready at '))
      emit('host-stage', {stage: 'waiting', message: 'Waiting for the Switch to connect over the local network'});
    else if (clean.startsWith('Connected. Checking the application'))
      emit('host-stage', {stage: 'connected', message: 'Switch connected — checking the application'});
    else if (/^[1-4]\/4 /.test(clean)) emit('host-stage', {
      stage: 'pipeline', completed: Number(clean[0])-1, total: 4, message: clean});
    if (izmysh && clean === 'Qualified native session ready.') {
      qualified = true;
      emit('host-stage', {stage: 'verified', message: 'IZMYSH native session qualified; closing its RPC connection.'});
      signalGroup(child, 'SIGTERM');
    }
    if (!incompatibleLegacyStartHint(clean, profile.startArgumentCount)) emit('log', {message: line});
    } catch (error) {
      publicationError ||= error;
      signalGroup(child, 'SIGTERM');
      emit('failed', {message: 'Could not safely publish host pairing: ' + error.message});
    }
  }
  lines(child.stdout, output); lines(child.stderr, output);
  const {code, signal} = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(stopTimer);
  clearTimeout(networkTimer);
  if (published) {
    try {if (fs.readFileSync(active, 'utf8').startsWith(`${child.pid}\n`)) fs.unlinkSync(active);} catch {}
  }
  // The run spawns a pipeline process. If run.cjs fails first, ensure no owned
  // descendant survives after its host has gone away.
  signalGroup(child, 'SIGTERM');
  let result;
  if (directory) {try {result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));} catch {}}
  if (networkFailure) {
    const retrySafe = !published && !progressed && !publicationError;
    const message = networkUnavailableMessage(address);
    emit(retrySafe ? 'network-unavailable' : 'failed', {...networkFailure, retrySafe,
      message: retrySafe ? message : message + ' Pairing or console activity may have started. Stop the session and restart the console before retrying.'});
    return 1;
  }
  if (stopping) {emit('cancelled', {message: 'Session stopped. Restart the console before another exploit attempt.'}); return 130;}
  const izmyshVerified = izmysh && qualified && result?.engine === 'izmysh' &&
    result.qualification?.verified === true && result.qualification?.scratchRestored === true &&
    result.qualification?.importRestored === true && typeof result.completed === 'string' && !result.error;
  if (code === 0 && !signal && !publicationError && (izmyshVerified || verifiedResult(result))) {
    if (izmyshVerified) {
      emit('verified', {message: 'IZMYSH verified the native session and restored its scratch memory and import.'});
      return 0;
    }
    emit('verified', {message: 'FS execution verified; original instructions restored and scratch cleaned up.'}); return 0;
  }
  emit('failed', {message: result?.error || 'The host ended without a verified result. Restart the console before retrying.'});
  return code || 1;
}
async function hid(kind, controller, settings = timingDefaults) {
  const profile = selectedProfile(root);
  if (settings.demo && !profile.supportsDemo) throw Error(`${profile.label} does not support the demo in this pinned build.`);
  if (!['bootstrap', 'commands', 'commands-only', 'save-bootstrap'].includes(kind)) throw Error('Invalid transfer kind.');
  if (controller !== 'auto' && !/^usb-drd(?:[0-9]|1[0-5])$/.test(controller)) throw Error('Choose a controller from 0 to 15.');
  if(controller!=='auto'&&settings.preferredController!==undefined)throw Error('A preferred controller is only available in Automatic mode.');
  const {delay, enumerationTimeout, loadWaitMs, runWaitMs, removeWaitMs, loadConfirmWaitMs} = settings;
  const candidates = controller === 'auto' ? [...new Set([...(settings.preferredController?[settings.preferredController]:[]),'usb-drd0','usb-drd1','usb-drd3'])] : [controller];
  let safeFailures=0;
  const saveBootstrap = kind === 'save-bootstrap';
  const textTransfer = kind === 'bootstrap';
  const commandNames=saveBootstrap?['SAVE']:kind==='commands-only'?settings.commands.map(name=>name.toUpperCase()):['LOAD','RUN','REMOVE','START'];
  const commandTotal=commandNames.length;
  const asset = 'assets/bootstrap.bas';
  const source = textTransfer ? fs.readFileSync(path.join(root, asset)) : Buffer.alloc(0);
  const text = source.toString('utf8');
  const totalLines = (text.match(/\n/g) || []).length + (text && !text.endsWith('\n') ? 1 : 0);
  const textName = 'bootstrap';
  for (const candidate of candidates) {
    if (stopping) break;
    emit('controller', {controller: candidate, message: `Waiting for ${candidate} to enumerate`});
    const executable = path.join(root, textTransfer ? 'mac2jb-send' : 'mac2jb-commands');
    const args = textTransfer ? [asset, '--delay-ms', String(delay)] : [
      '--auto', ...(kind !== 'bootstrap' && settings.demo ? ['--demo'] : []), '--delay-ms', String(delay), '--gui-events', '--enumeration-timeout', String(enumerationTimeout),
      ...(profile.startArgumentCount === 9 ? ['--start-arity','9'] : []), '--start-port', String(profile.startPort),
      '--save-name', profile.saveName || 'NS2', '--load-name', profile.saveName || 'NS2',
      '--load-wait-ms', String(loadWaitMs), '--run-wait-ms', String(runWaitMs),
      '--remove-wait-ms', String(removeWaitMs), '--load-confirm-wait-ms', String(loadConfirmWaitMs),
      ...(saveBootstrap ? ['--save-bootstrap'] : []),
      ...(kind === 'commands-only' ? ['--commands',settings.commands.join(','),
        ...(settings.startPrefix?['--start-prefix']:settings.startCommand?['--start-command',settings.startCommand]:[])] : [])];
    current = spawn(executable, args, {cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, MAC2JB_AUTO_WORKER: '1', MAC2JB_CONTROLLER: candidate,
        MAC2JB_ENUMERATION_TIMEOUT_SECONDS: String(enumerationTimeout)}});
    const child = current;
    let output = '', typing = false, timedOut = false, announced = false, commandStep = 0, nativeEvents = false, nativeLineEvents = false,prefixCompleted=false;
    const completedCommands=new Set();
    let saveStarted=false, saveProtocolInvalid=false;
    let timer, countdown;
    const started = performance.now();
    const enumerationProgress = () => {
      const elapsed = Math.min(enumerationTimeout * 1000, Math.max(0, performance.now() - started));
      emit('enumeration-progress', {controller: candidate, completed: elapsed, total: enumerationTimeout * 1000,
        remainingMs: Math.max(0, enumerationTimeout * 1000 - elapsed), durationMs: enumerationTimeout * 1000});
    };
    const markPossibleInput = () => {
      typing = true; clearTimeout(timer); clearInterval(countdown);
    };
    const markTyping = () => {
      markPossibleInput();
      if (!announced&&!timedOut&&!stopping) {
        announced = true;
        emit('typing', {kind, controller:candidate,completed: 0, total: textTransfer ? totalLines : commandTotal,
          message: saveBootstrap ? 'USB keyboard connected. Typing the SAVE command.' : kind==='commands' ? 'USB keyboard connected. Sending four commands.' : !textTransfer ? `USB keyboard connected. Sending ${commandTotal} selected command${commandTotal===1?'':'s'}.` : `USB keyboard connected. Typing the ${textName}.`});
      }
    };
    const observe = line => {
      output += line + '\n';
      if (line.startsWith('MAC2JB_GUI ')) {
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_GUI '.length));} catch {
          if (saveBootstrap) {markPossibleInput(); saveProtocolInvalid=true;} return;
        }
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          if (saveBootstrap) {markPossibleInput(); saveProtocolInvalid=true;} return;
        }
        if (saveBootstrap) {
          markPossibleInput();
          const validTyping=event.type==='typing'&&event.completed===0&&event.total===1&&!saveStarted&&completedCommands.size===0;
          const validCommand=['command-start','command-complete'].includes(event.type)&&event.step===1&&event.total===1&&event.label==='SAVE'&&
            event.completed===(event.type==='command-start'?0:1)&&completedCommands.size===0&&
            (event.type==='command-start'?!saveStarted:saveStarted);
          if ((!validTyping&&!validCommand)||saveProtocolInvalid) {saveProtocolInvalid=true; return;}
          if (event.type==='command-start') saveStarted=true;
        }
        if (event.type === 'line-start' || event.type === 'line-complete') {
          markPossibleInput();
          if (!textTransfer || !Number.isSafeInteger(event.line) ||
              !Number.isSafeInteger(event.completed) || event.total !== totalLines ||
              event.line < 1 || event.line > totalLines ||
              event.completed !== event.line - (event.type === 'line-start' ? 1 : 0)) return;
          nativeLineEvents = true;
          markTyping();
          emit(event.type, {kind, line: event.line, completed: event.completed, total: totalLines,
            message: `${event.type === 'line-start' ? 'Typing' : 'Sent'} line ${event.line} of ${totalLines}`,
            ...(Number.isFinite(event.remainingMs) && event.remainingMs >= 0 ? {remainingMs: event.remainingMs} : {})});
          return;
        }
        nativeEvents = true;
        if (['typing', 'command-start', 'command-complete','command-prefix-complete','wait'].includes(event.type)) markPossibleInput();
        if(event.type==='typing'&&!textTransfer&&event.completed===0&&event.total===commandTotal)markTyping();
        if(event.type==='command-prefix-complete') {
          if(kind!=='commands-only'||!settings.startPrefix||prefixCompleted||event.step!==commandTotal||
            event.completed!==commandTotal-1||event.total!==commandTotal||event.label!=='START'||
            event.prefix!==`V=START(${profile.startPort},`||event.startPending!==true||completedCommands.size!==commandTotal-1)return;
          prefixCompleted=true;
          markTyping();
          emit(event.type,{kind,step:event.step,completed:event.completed,total:commandTotal,label:'START',startPending:true});return;
        }
        if (event.type === 'command-start' || event.type === 'command-complete') {
          if(textTransfer||!Number.isSafeInteger(event.step)||event.step<1||event.step>commandTotal||
            event.total!==commandTotal||event.label!==commandNames[event.step-1]||
            event.completed!==event.step-(event.type==='command-start'?1:0))return;
          if(kind==='commands-only'&&(!Number.isSafeInteger(event.step)||event.step<1||event.step>commandTotal||
            event.total!==commandTotal||event.label!==commandNames[event.step-1]||
            event.completed!==event.step-(event.type==='command-start'?1:0)||
            event.step!==completedCommands.size+1||
            (event.type==='command-complete'&&settings.startPrefix&&event.label==='START')))return;
          if(event.type==='command-complete')completedCommands.add(event.step);
          markTyping();
          commandStep = event.step;
          emit(event.type, {kind, step: event.step, completed: event.completed, total: commandTotal, label: event.label});
        } else if (event.type === 'wait') {
          if(kind==='commands-only'&&(event.total!==commandTotal||!Number.isSafeInteger(event.completed)||
            event.completed<1||event.completed>commandTotal||
            !(commandNames.includes(event.label)||(event.label==='LOAD confirmation'&&commandNames.includes('LOAD')))))return;
          emit('wait', {kind, completed: event.completed, total: commandTotal, label: event.label,
            remainingMs: event.remainingMs, durationMs: event.durationMs});
        }
        return;
      }
      if (/Keyboard enumerated\. Sending|Sent line \d+|^Sending: /.test(line)) {
        markTyping();
      }
      const progress = /Sent line (\d+)/.exec(line);
      if (progress && textTransfer && !nativeLineEvents) {
        const completed = Number(progress[1]);
        if (Number.isSafeInteger(completed) && completed >= 1 && completed <= totalLines)
          emit('progress', {kind, line: Math.min(completed + 1, totalLines), completed, total: totalLines});
      }
      if (line.startsWith('Sending: ')) {
        if (!nativeEvents) {
          commandStep++;
          emit('command-start', {kind, step: commandStep, completed: commandStep-1, total: commandTotal,
            label: commandNames[commandStep-1] || 'command'});
        }
        emit('command', {message: line});
      }
      else emit('log', {message: line});
    };
    lines(child.stdout, observe); lines(child.stderr, observe);
    // Once terminated, wait for close (both output streams drained) before
    // deciding whether another controller is safe. Buffered typing evidence
    // must never be missed by a timeout race.
    enumerationProgress();
    countdown = setInterval(enumerationProgress, 100);
    timer = setTimeout(() => {
      if (!typing) {
        enumerationProgress(); clearInterval(countdown);
        timedOut = true; signalGroup(child, 'SIGTERM');
        stopTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000); stopTimer.unref();
      }
    }, enumerationTimeout * 1000);
    let code, signal;
    try {
      ({code, signal} = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
      }));
    } finally {
      // Spawn errors must also release timers; otherwise a 120-second selected
      // window would keep a failed adapter alive after ENOENT or EACCES.
      clearTimeout(timer); clearInterval(countdown); clearTimeout(stopTimer);
    }
    if (stopping) break;
    if (code === 0 && !signal&&!timedOut) {
      if (saveBootstrap && (saveProtocolInvalid || !saveStarted || completedCommands.size!==1)) {
        emit('failed',{partial:typing,message:'SAVE command completion was not confirmed. Inspect the Switch before trying again.'});return 1;
      }
      if(kind==='commands-only'&&(completedCommands.size!==commandTotal-(settings.startPrefix?1:0)||
        (settings.startPrefix&&!prefixCompleted))) {
        emit('failed',{partial:typing,message:'Selected command completion was not confirmed. Inspect the Switch before trying again.'});return 1;
      }
      emit('transfer-complete', {kind,...(saveBootstrap||kind==='commands-only'?{total:commandTotal,completed:completedCommands.size,...(settings.startPrefix?{startPending:true}:{})}:{}),message: saveBootstrap ? 'SAVE command submitted. Confirm any save or overwrite prompt on the Switch, then confirm saving in the app.' : kind === 'commands-only' ?
        (settings.startPrefix?'Selected commands typed. Finish START manually; Enter has not been sent.':'Selected commands typed. No host was started and no exploit result was checked.') : 'Keyboard transfer completed. Check the Switch screen.'}); return 0;
    }
    if (signal && !(timedOut&&['SIGTERM','SIGKILL'].includes(signal))) {
      const helper = path.basename(executable);
      emit('failed', {helper, signal, controller: candidate, partial: typing,
        message: `USB helper ${helper} terminated by ${signal} on ${candidate}. ` +
          'This does not establish that the USB driver is missing. Check macOS crash reports and the session logs. ' +
          'Automatic retry was stopped.' + (typing ? ' Input may be partial. Inspect and clear the Switch input before trying again.' : '')});
      return 1;
    }
    if (typing) {
      emit('failed', {partial: true, message: 'Input may be partial. Automatic retry was stopped. Inspect and clear the Switch input before trying again.'}); return 1;
    }
    const enumerationError = /^USB host did not enumerate a keyboard(?:\.| on selected controller\. Check data role, cable, and host USB descriptors\.)?$/m.test(output);
    const initializationError=/^(?:libusbd_init failed\b|USB configuration failed\b|USB interface setup failed\b|USB enumeration error(?::|\s)|USB keyboard enumeration failed\b)/m.test(output);
    const safeEnumerationFailure=!initializationError&&((timedOut&&(['SIGTERM','SIGKILL'].includes(signal)||[1,130].includes(code)))||(!signal&&code===1&&enumerationError));
    if (!safeEnumerationFailure) {
      emit('failed', {message: 'USB initialization failed. Check that the approved usbgadget driver is installed and loaded.'}); return code || 1;
    }
    safeFailures++;
    emit('log', {message: `${candidate} did not enumerate; no typing was detected.`});
  }
  if (stopping) {emit('cancelled', {message: 'Transfer stopped. Inspect the Switch for partial input.'}); return 130;}
  emit('failed', {...(safeFailures===candidates.length?{retrySafe:true}:{}),message: 'No controller connected. The Mac must NOT be supplying charging power to the Switch. Unplug the USB-C cable from the Switch, wait about one second, then plug it back into the Switch and verify that power is directed toward the Mac. Software cannot force the power role. You can also choose a controller manually.'}); return 1;
}
async function main(args = process.argv.slice(2)) {
  if (args[0] === 'host' && args.length === 3 && args[2] === '--post-run-options') {
    if (!selectedProfile(root).supportsHeldRPC) throw Error('The selected host does not provide held RPC.');
    return require('./gui-session.cjs').main({root, address: args[1], emit, lines, verifiedResult});
  }
  if (args.length === 1 && args[0] === '--self-test') {
    const address = '192.0.2.1';
    const profile = profileById('BermTheSequel');
    const value = 'V=START(' + [profile.startPort, ...address.split('.')].join(',') + ')';
    if (!validStart(value, address) || validStart(value, '192.0.2.2') ||
        validStart(value.slice(0, -1) + ',0,0,0,0)', address) ||
        verifiedResult({verified: true}) || !verifiedResult({verified: true,
          fs: {verified: true, restored: true, cleanup: {cleanedUp: true}}}))
      throw Error('GUI adapter self-test failed.');
    emit('self-test', {message: 'Pairing validation and result verification checks passed. No USB input sent.'});
    return 0;
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (args[0] === 'host' && args.length === 2) return host(args[1]);
  if (args[0] === 'hid' && args[1] === 'commands-only')
    return hid(args[1], args[2], commandsOnlySettings(args.slice(3),selectedProfile(root)));
  if (args[0] === 'hid' && args.length >= 3) return hid(args[1], args[2], hidSettings(args.slice(3)));
  throw Error('Usage: gui-host.cjs host IPv4 | hid bootstrap|commands|save-bootstrap auto|usb-drdN [delay-ms] | hid commands-only auto|usb-drdN [delay-ms] --commands CSV [--start-prefix|--start-command TEXT]');
}
module.exports = {validStart, verifiedResult, hidSettings,commandsOnlySettings, lines, main, networkBindFailure, networkUnavailableMessage};
if (require.main === module) main().then(code => {process.exitCode = code;}).catch(error => {
  signalGroup(current, 'SIGTERM'); emit('failed', {message: error.message}); process.exitCode = 1;
});
