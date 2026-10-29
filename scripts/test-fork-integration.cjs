#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const repository = path.resolve(__dirname, '..');

function fixture(t, actualHost = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-fork-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['gui-host.cjs', 'host-wrapper.cjs', 'host-profiles.cjs'])
    fs.copyFileSync(path.join(__dirname, name), path.join(root, 'scripts', name));
  fs.mkdirSync(path.join(root, 'packaging'));
  fs.copyFileSync(path.join(repository, 'packaging/host-profiles.json'), path.join(root, 'packaging/host-profiles.json'));
  const host = path.join(root, 'vendor/ns2jb');
  fs.mkdirSync(host, {recursive: true});
  if (actualHost) fs.cpSync(path.join(repository, 'vendor/ns2jb'), host, {
    recursive: true, filter: file => !['runs', 'dumps'].includes(path.basename(file))
  });
  return {root, host, active: path.join(host, 'runs/mac2jb-active-connect.txt')};
}

function launch(t, fixture, adapter, args) {
  const child = spawn(process.execPath, [path.join(fixture.root, 'scripts', adapter), ...args], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, NS2_BASIC_ARITY: '9', NS2_RPC_MODE: '1'}
  });
  let output = '', error = '', hostPid;
  child.stdout.on('data', bytes => {output += bytes;});
  child.stderr.on('data', bytes => {error += bytes;});
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, output, error}));
  });
  t.after(async () => {
    // GUI host processes own a separate group; CLI children share the wrapper's.
    if (hostPid) {try {process.kill(-hostPid, 'SIGKILL');} catch {}}
    try {process.kill(-child.pid, 'SIGKILL');} catch {}
    await done;
  });
  return {child, done, output: () => output, error:()=>error, recordHost: pid => {hostPid = pid;}};
}

async function until(predicate, message, deadline = 5000) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < deadline, typeof message==='function'?message():message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

function forkStartLines(adapter, output) {
  // GUI events may include the same command in structured fields. Only raw
  // fork log messages establish which BASIC forms the unmodified fork printed.
  const complete=output.split('\n').slice(0,-1);
  const messages=adapter==='gui-host.cjs' ? complete.map(JSON.parse)
    .filter(event=>event.type==='log').map(event=>event.message) : complete;
  return messages.map(line=>line.trim()).filter(line=>/^V=START\(\d+(?:,\d+)+\)$/.test(line));
}

function greeting() {
  const bytes = Buffer.alloc(128);
  const main = 0x7100000000, sdk = 0x7200000000;
  const words = [0x31545344, 1, 2, 0x10000000, 0x80000,
    main, sdk, main + 0x9c92f0, sdk + 0x5872f0, 0x10001000, 0x10002000,
    0, 0, 0, 0, 3925528160];
  words.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), index * 8));
  return bytes;
}

test('transmitted bootstrap is the exact five-argument fork bootstrap', () => {
  const bundled = fs.readFileSync(path.join(repository, 'assets/bootstrap.bas'));
  assert.deepEqual(bundled, fs.readFileSync(path.join(repository, 'vendor/ns2jb/bootstrap.bas')));
  assert.match(bundled.toString(), /COMMON DEF START\(PORT,A,B,C,D\)/);
  const {parseHello} = require('../vendor/ns2jb/engine/lib/connection.cjs');
  assert.equal(parseHello(greeting()).platform, 2);
});

test('fork log assertions ignore structured START fields and an unfinished GUI event',()=>{
  const five='V=START(39380,127,0,0,1)',nine='V=START(39380,127,0,0,1,0,0,0,0)';
  const output=[{type:'host-ready',startCommand:five},{type:'log',message:'  '+five},
    {type:'log',message:'  '+nine}].map(JSON.stringify).join('\n')+'\n';
  assert.equal((output.match(/V=START\(/g)||[]).length,3);
  assert.deepEqual(forkStartLines('gui-host.cjs',output+'{"type":"log","message":"V=START('),[five,nine]);
  assert.deepEqual(forkStartLines('host-wrapper.cjs',five+'\n'+nine+'\n'),[five,nine]);
});

test('GUI hides only the incompatible legacy START hint for five-argument hosts',()=>{
  const {incompatibleLegacyStartHint}=require('./host-profiles.cjs');
  const fallback='V=START(39380,192,168,1,119,0,0,0,0)';
  const current='V=START(39380,192,168,1,119)';
  assert.equal(incompatibleLegacyStartHint('If BASIC says Wrong number of arguments, use the older nine-argument form instead:',5),true);
  assert.equal(incompatibleLegacyStartHint(fallback,5),true);
  assert.equal(incompatibleLegacyStartHint(current,5),false);
  assert.equal(incompatibleLegacyStartHint(fallback,9),false);
});

test('CLI host settings override inherited modes while preserving explicit --rpc', async t => {
  const source = fixture(t, false);
  fs.writeFileSync(path.join(source.host, 'run.cjs'), `
    require('fs').writeFileSync('settings.json', JSON.stringify({
      arity: process.env.NS2_BASIC_ARITY, rpc: process.env.NS2_RPC_MODE,
      args: process.argv.slice(2)
    }));
  `);
  const runner = launch(t, source, 'host-wrapper.cjs', ['--rpc', '127.0.0.1']);
  assert.equal((await runner.done).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source.host, 'settings.json'))),
    {arity: '5', rpc: '0', args: ['--rpc', '127.0.0.1']});
});

for(const id of ['pepsipu','kurumuz']) test(`GUI pairs with the actual pinned ${id} host and its unchanged bootstrap protocol`,
  {timeout:10000},async t=>{
    const {profileById,validStartCommand}=require('./host-profiles.cjs');
    const profile=profileById(id),source=fixture(t,false);
    fs.cpSync(path.join(repository,profile.sourceDirectory),source.host,{recursive:true});
    fs.writeFileSync(path.join(source.root,'selected-host.json'),JSON.stringify(profile));
    const runner=launch(t,source,'gui-host.cjs',['host','127.0.0.1']);
    await until(()=>fs.existsSync(source.active),()=>`No ${id} pairing: `+runner.output()+runner.error());
    const record=fs.readFileSync(source.active,'utf8').trim().split('\n');
    runner.recordHost(Number(record[0]));
    assert.equal(validStartCommand(record[1],profile,'127.0.0.1'),true);
    const hello=greeting();
    if(profile.startArgumentCount===9) {
      const fields=record[1].slice(8,-1).split(',');
      assert.equal(fields.length,9);
      for(let index=0;index<4;index++)hello.writeBigUInt64LE(BigInt(fields[index+5]),(index+11)*8);
    }
    // Authenticate only the initial protocol greeting, then disconnect before
    // executing a native request. No USB or console is involved.
    const socket=net.connect(39380,'127.0.0.1');t.after(()=>socket.destroy());
    await new Promise((resolve,reject)=>{
      socket.once('error',reject);
      socket.once('data',()=>{socket.destroy();resolve();});
      socket.once('connect',()=>socket.write(hello));
    });
    const result=await runner.done;
    assert.equal(result.code,1,result.output+result.error);
    assert.match(result.output,/Connected\. Checking the application/);
    assert.equal(fs.existsSync(source.active),false);
  });

for (const adapter of ['gui-host.cjs', 'host-wrapper.cjs']) {
  test(`${adapter} ignores wrong arity and malformed values and publishes only the five-argument command`, async t => {
    const source = fixture(t, false);
    const values = ['V=START(39380,127,0,0,1,0,0,0,0)', 'V=START(39380,127,0,0)',
      'V=START(39381,127,0,0,1)', 'V=START(39380,999,0,0,1)',
      'V=START(39380,-1,0,0,1)', 'V=START(39380,127,0,0,1.5)',
      'V=START(39380,127,0,0,1);PRINT 1', 'V=START(39380,127,0,0,1)',
      'V=START(39380,127,0,0,1,0,0,0,0)'];
    fs.writeFileSync(path.join(source.host, 'run.cjs'), `
      const fs = require('fs'); const path = require('path');
      const directory = path.join(__dirname, 'runs/test-session'); fs.mkdirSync(directory, {recursive:true});
      for (const command of ${JSON.stringify(values)}) console.log(command);
      console.log('Run folder: ' + directory);
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({
        verified: true, fs: {verified: true, restored: true, cleanup: {cleanedUp:true}}
      }));
      setTimeout(() => {}, 300);
    `);
    const args = adapter === 'gui-host.cjs' ? ['host', '127.0.0.1'] : ['127.0.0.1'];
    const runner = launch(t, source, adapter, args);
    await until(() => fs.existsSync(source.active), 'No valid START command was published');
    const record = fs.readFileSync(source.active, 'utf8').trim().split('\n');
    runner.recordHost(Number(record[0]));
    assert.equal(record[1], 'V=START(39380,127,0,0,1)');
    assert.equal((await runner.done).code, 0);
    assert.equal(fs.existsSync(source.active), false);
  });

  test(`${adapter} publishes the actual fork's five-argument command and cleans up after disconnect`,
    {timeout: 10000}, async t => {
      const source = fixture(t);
      const args = adapter === 'gui-host.cjs' ? ['host', '127.0.0.1'] : ['127.0.0.1'];
      const runner = launch(t, source, adapter, args);
      await until(() => fs.existsSync(source.active), ()=>'Host did not publish its command:\n'+runner.output()+runner.error());
      const record = fs.readFileSync(source.active, 'utf8').trim().split('\n');
      runner.recordHost(Number(record[0]));
      assert.equal(record[1], 'V=START(39380,127,0,0,1)');
      assert.equal(fs.statSync(source.active).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(source.active)).mode & 0o777, 0o700);
      // The fork also logs a compatibility fallback. It must not replace the
      // five-argument record that the bundled bootstrap and C sender require.
      const expectedForms=adapter==='gui-host.cjs' ? [record[1]] :
        [record[1],'V=START(39380,127,0,0,1,0,0,0,0)'];
      await until(() => runner.output().includes('Run folder: ') &&
        forkStartLines(adapter,runner.output()).length>=expectedForms.length,
        ()=>'The actual host did not log its START form:\n'+runner.output());
      assert.deepEqual(forkStartLines(adapter,runner.output()),expectedForms);
      if(adapter==='gui-host.cjs') {
        const events=runner.output().split('\n').slice(0,-1).map(JSON.parse);
        assert.equal(events.find(event=>event.type==='host-ready').startCommand,record[1]);
        assert.equal(events.some(event=>event.type==='log' && event.message.includes('older nine-argument form')),false);
      }
      assert.equal(fs.readFileSync(source.active, 'utf8').trim().split('\n')[1], record[1]);

      // A valid greeting verifies the preserved BASIC wire format. Close on the
      // first qualification read: no native command is executed by this fixture.
      const socket = net.connect(39380, '127.0.0.1');
      t.after(() => socket.destroy());
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => {socket.write(greeting()); resolve();});
      });
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('data', () => {socket.destroy(); resolve();});
      });
      const result = await runner.done;
      assert.equal(result.code, 1, result.output + result.error);
      assert.match(result.output, /Connected\. Checking the application/);
      assert.equal(fs.existsSync(source.active), false);
      const sessions = fs.readdirSync(path.join(source.host, 'runs')).filter(name => name.startsWith('switch2-'));
      assert.equal(sessions.length, 1);
      const report = JSON.parse(fs.readFileSync(path.join(source.host, 'runs', sessions[0], 'result.json')));
      assert.equal(report.verified, false);
      // A peer close may surface as a reset on macOS rather than an EOF.
      assert.match(report.error, /disconnected|closed|ECONNRESET/i);
      if (adapter === 'gui-host.cjs') {
        const events = result.output.trim().split('\n').map(JSON.parse);
        assert.ok(events.some(event => event.type === 'host-ready'));
        assert.ok(events.some(event => event.type === 'host-stage' && event.stage === 'connected'));
        assert.ok(events.some(event => event.type === 'failed'));
        assert.equal(events.some(event => event.type === 'verified'), false);
      }
      await until(() => {
        try {process.kill(Number(record[0]), 0); return false;} catch (error) {return error.code === 'ESRCH';}
      }, 'The completed host process remained alive');
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(39380, '127.0.0.1', () => server.close(resolve));
      });
    });
}
