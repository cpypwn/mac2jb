'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const {prepare, validateManifest, OWNER, ATTEMPT} = require('./rpc-attachment.cjs');
const {validateRun} = require('./gui-homebrew.cjs');
const {verifiedSession} = require('./gui-dump.cjs');
const {profileById} = require('./host-profiles.cjs');
const repository = path.resolve(__dirname, '..');
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
  await fs.writeFile(file, JSON.stringify(value), {mode:0o600});
};
const update = async (file, mutate) => {const value = JSON.parse(await fs.readFile(file)); mutate(value); await write(file, value);};
async function fixture(t, hostId = 'BermTheSequel') {
  const base = await fs.mkdtemp('/private/tmp/m2a-');
  const root = path.join(base, 'app'), directory = path.join(base, 'original/switch2-test');
  await fs.mkdir(root, {mode:0o700});
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  await fs.cp(path.join(repository, 'vendor/ns2jb'), path.join(root, 'vendor/ns2jb'), {recursive:true});
  const host = profileById(hostId), source = path.join(repository, host.sourceDirectory);
  if (hostId !== 'BermTheSequel') await fs.cp(source, path.join(root, host.sourceDirectory), {recursive:true});
  for (const name of ['shared','switch2'])
    await fs.cp(path.join(source, 'engine', name), path.join(directory, name), {recursive:true});
  const session = path.basename(directory), engine = path.join(directory, 'switch2');
  const proofFile = path.join(engine, 'process', session+'-fs-proof.json');
  const reportFile = path.join(engine, 'memory/report.json');
  const socketPath = path.join(base, 'memory.sock');
  const state = {ready:true, session, report:reportFile, calls:0, failHTTP:false, corruptInfo:false};
  const requests = [], retainedRequests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    if (state.holdHTTP) return;
    if (state.failHTTP) {res.destroy(); return;}
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ready:state.ready, calls:++state.calls}));
  });
  const retained = net.createServer(socket => {
    let text = ''; socket.setEncoding('utf8');
    socket.on('data', part => {
      text += part; if (!text.includes('\n')) return;
      retainedRequests.push(JSON.parse(text));
      if (state.retainedBusy) {socket.end('{"error":"Another memory request is active"}\n'); return;}
      socket.end(JSON.stringify({ready:true, steadyStateReliable:true, requiresCorruption:false,
        session:state.corruptInfo ? 'another-session' : session, report:reportFile, corruptionCount:1})+'\n');
    });
  });
  const contexts = [];
  t.after(async () => {
    for (const context of contexts) await context.close().catch(()=>{});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => retained.close(resolve));
    await fs.rm(base, {recursive:true, force:true});
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  await new Promise((resolve, reject) => {retained.once('error', reject); retained.listen(socketPath, resolve);});
  await fs.chmod(socketPath, 0o600);
  const summary = {session, file:proofFile, trials:2, verified:true, restored:true,
    cleanup:{deferred:true, donor:{cleanedUp:true}}, retainedEndpoint:{ready:true, session, socketPath}};
  const resultFile = path.join(directory, 'result.json');
  await write(resultFile, {platform:2, sourceSha256:host.sourceSha256, verified:true,
    rpc:{mode:'held', state:'listening'}, fs:summary});
  await write(path.join(engine, 'fs-execution-current.json'), summary);
  await write(proofFile, {session, report:reportFile, verified:true,
    trials:[{verified:true, restored:true},{verified:true, restored:true}]});
  await write(reportFile, {session, cases:[{}], retainedMemory:{ready:true, zeroCountVerified:true}, memoryControl:{socketPath}});
  await write(path.join(engine, 'current-acquisition.json'), {session, report:reportFile, socketPath});
  await write(path.join(engine, 'ro/current-execution.json'), {session, report:reportFile, verified:true});
  await write(path.join(engine, 'ro', session+'-loader-root-copy.json'),
    {session, report:reportFile, verified:true, restored:true, copy:{handle:42}});
  await write(path.join(directory, 'connection.json'), {port:server.address().port,
    addresses:{session, target:'switch2', platform:2, scratch:4096, main:8192, sdk:12288, backing:16384, controller:20480}});
  const attach = async (config = {kind:'local', runDirectory:directory}, options) => {
    const context = await prepare(root, config, options); contexts.push(context); return context;
  };
  return {base, root, directory, resultFile, reportFile, proofFile, socketPath, state, requests, retainedRequests, attach};
}

test('local attachment validates real held proof and both live endpoints without starting a host', async t => {
  const f = await fixture(t), before = await fs.readFile(f.resultFile);
  const context = await f.attach();
  assert.equal(context.directory, f.directory); assert.equal(context.sourceSession, 'switch2-test');
  assert.match(context.description, /BermTheSequel/); assert.equal((await context.verify()).ready, true);
  assert.deepEqual(f.requests, [{command:'status'}, {command:'status'}]);
  assert.deepEqual(f.retainedRequests, [{command:'retained-info'}, {command:'retained-info'}]);
  assert.deepEqual(await fs.readFile(f.resultFile), before);
  assert.equal((await fs.stat(context.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(context.manifestPath))).mode & 0o777, 0o700);
  await context.close(); await context.close();
  await assert.rejects(fs.access(context.manifestPath), {code:'ENOENT'});
  await assert.rejects(context.verify(), /closed/);
  assert.equal(f.state.ready, true); assert.ok((await fs.stat(f.socketPath)).isSocket());
  assert.deepEqual(await fs.readFile(f.resultFile), before);
});

for (const application of ['hblauncher','mintbrew','izlauncher']) test(application+' external run needs exact claimed authorization; normal current-run validation stays strict', async t => {
  const f = await fixture(t), context = await f.attach();
  await assert.rejects(validateRun(f.root, f.directory, verifiedSession), /current held run|authorized/);
  await assert.rejects(validateManifest(f.root, f.directory, context.manifestPath), /authorization/);
  await context.claimApplication(application);
  const owner = JSON.parse(await fs.readFile(path.join(f.directory, OWNER)));
  assert.equal(owner.application, application);
  await assert.rejects(fs.access(path.join(f.directory, ATTEMPT)), {code:'ENOENT'});
  assert.equal((await validateManifest(f.root, f.directory, context.manifestPath)).session, 'switch2-test');
  const old = process.env.MAC2JB_ATTACHED_RUN_MANIFEST;
  process.env.MAC2JB_ATTACHED_RUN_MANIFEST = context.manifestPath;
  try {assert.equal((await validateRun(f.root, f.directory, verifiedSession)).directory, f.directory);}
  finally {if (old === undefined) delete process.env.MAC2JB_ATTACHED_RUN_MANIFEST; else process.env.MAC2JB_ATTACHED_RUN_MANIFEST = old;}
  await assert.rejects(validateManifest(f.root, f.directory, path.join(f.base, path.basename(context.manifestPath))), /current held run|authorized/);
  await context.close();
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, OWNER))).token, owner.token);
  await assert.rejects(f.attach(), /already has a homebrew attempt/);
});

test('a proven pre-transfer failure releases only its own claim and permits another app', async t => {
  const f = await fixture(t), context = await f.attach();
  await context.claimApplication('custom-homebrew');
  const attemptFile = path.join(f.directory, ATTEMPT);
  await write(attemptFile, {application:'custom-homebrew'});
  await assert.rejects(context.releaseApplication(), /did not prove a pre-transfer failure/);
  await fs.unlink(attemptFile);
  assert.equal((await context.releaseApplication()).ready, true);
  await assert.rejects(fs.access(path.join(f.directory, OWNER)), {code:'ENOENT'});
  await assert.rejects(validateManifest(f.root, f.directory, context.manifestPath), /authorization/);
  await context.claimApplication('ouncecake');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, OWNER))).application, 'ouncecake');
  assert.equal((await validateManifest(f.root, f.directory, context.manifestPath)).session, 'switch2-test');
  assert.equal(f.state.ready, true);
});

test('exclusive source reservation allows only one attachment and never duplicates helper attempt marker', async t => {
  const f = await fixture(t), first = await f.attach(), second = await f.attach();
  const settled = await Promise.allSettled([first.claimApplication('stremio'), second.claimApplication('ouncecake')]);
  assert.equal(settled.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(row => row.status === 'rejected').length, 1);
  const owner = JSON.parse(await fs.readFile(path.join(f.directory, OWNER)));
  assert.ok(['stremio','ouncecake'].includes(owner.application));
  await assert.rejects(fs.access(path.join(f.directory, ATTEMPT)), {code:'ENOENT'});
  const winner = owner.application === 'stremio' ? first : second;
  await write(path.join(f.directory, ATTEMPT), {application:owner.application});
  assert.equal((await winner.verify()).ready, true);
  await assert.rejects(winner.claimApplication(owner.application), /already used/);
});

test('source attempt already consumed or claimed after preparation cannot launch another helper', async t => {
  const f = await fixture(t), context = await f.attach();
  await write(path.join(f.directory, ATTEMPT), {application:'stremio'});
  await assert.rejects(context.claimApplication('ouncecake'), /Another homebrew attempt/);
  await assert.rejects(fs.access(path.join(f.directory, OWNER)), {code:'ENOENT'});
  await assert.rejects(f.attach(), /already has a homebrew attempt/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, ATTEMPT))).application, 'stremio');
});

test('wrong source, changed copied code and added executable code are rejected before live requests', async t => {
  const f = await fixture(t);
  const source = JSON.parse(await fs.readFile(f.resultFile)).sourceSha256;
  await update(f.resultFile, value => {value.sourceSha256 = '0'.repeat(64);});
  await assert.rejects(f.attach(), /supported pinned RPC host/);
  await update(f.resultFile, value => {value.sourceSha256 = source;});
  const code = path.join(f.directory, 'shared/rpc.cjs'), original = await fs.readFile(code);
  await fs.appendFile(code, '\nthrow Error("run-owned code must never execute");\n');
  await assert.rejects(f.attach(), /changed host code/);
  await fs.writeFile(code, original);
  await fs.writeFile(path.join(f.directory, 'switch2/unrecognized.cjs'), 'throw Error("never execute")', {mode:0o600});
  await assert.rejects(f.attach(), /unrecognized executable/);
  assert.equal(f.requests.length, 0); assert.equal(f.retainedRequests.length, 0);
});

test('a supported held source attaches across the current host picker using its own pinned code', async t => {
  const f = await fixture(t, 'kurumuz'), context = await f.attach();
  assert.match(context.description, /kurumuz/);
  await context.claimApplication('ouncecake');
  assert.equal((await validateManifest(f.root, f.directory, context.manifestPath)).profileId, 'kurumuz');
});

test('real upstream archived source copies are accepted only with pinned bytes and socket aliases retain live identity', async t => {
  const f = await fixture(t), stamp = 'reserved-gap-1792967392773';
  const mapping = {
    'source':'probe-reserved-gap','address-plan-source':'cache-address-plan','signed-plan-source':'signed-cache-plan',
    'mounted-rom-source':'mounted-rom','memory-control-source':'fs-memory-control',
    'active-fs-memory-control':'fs-memory-control','active-fs-root-control':'fs-root-control',
    'cache-address-plan':'cache-address-plan','fs-memory-control':'fs-memory-control','session-tools':'session-tools',
    'run-control':'run-control','capture-workers':'capture-workers','native-links':'native-links'
  };
  for (const [copy, original] of Object.entries(mapping))
    await fs.copyFile(path.join(f.directory, 'switch2/memory', original+'.cjs'),
      path.join(f.directory, 'switch2/memory', stamp+'-'+copy+'.cjs'));
  for (const name of ['native-worker','affinity'])
    await fs.copyFile(path.join(f.directory, 'switch2/app', name+'.cjs'), path.join(f.directory, 'switch2/memory', stamp+'-'+name+'.cjs'));
  for (const [original, prefix] of [['memory/fs-root-control',stamp+'-root-control-'],
    ['retained/retained-memory',stamp+'-implementation-'], ['ro/control','control-']]) {
    const bytes = await fs.readFile(path.join(f.directory, 'switch2', original+'.cjs'));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(f.directory, 'switch2', path.dirname(original), prefix+digest.slice(0,12)+'.cjs'), bytes, {mode:0o600});
  }
  // /tmp is macOS's system alias of /private/tmp; the socket itself is not a link.
  const socketAlias = f.socketPath.replace(/^\/private\/tmp\//, '/tmp/');
  await update(f.resultFile, value => {value.fs.retainedEndpoint.socketPath = socketAlias;});
  await update(path.join(f.directory, 'switch2/fs-execution-current.json'), value => {value.retainedEndpoint.socketPath = socketAlias;});
  await update(path.join(f.directory, 'switch2/current-acquisition.json'), value => {value.socketPath = socketAlias;});
  await update(f.reportFile, value => {value.memoryControl.socketPath = socketAlias;});
  const context = await f.attach(); assert.equal((await context.verify()).ready, true);
  await fs.appendFile(path.join(f.directory, 'switch2/memory', stamp+'-source.cjs'), '\n// altered archive\n');
  await assert.rejects(context.verify(), /unrecognized executable/);
});

test('canonical owned private paths and bounded in-run proof links are required', async t => {
  const f = await fixture(t);
  const link = path.join(f.base, 'alias'); await fs.symlink(f.directory, link);
  await assert.rejects(f.attach({kind:'local', runDirectory:link}), /without symlinks/);
  await fs.chmod(f.resultFile, 0o666);
  await assert.rejects(f.attach(), /owned private/); await fs.chmod(f.resultFile, 0o600);
  await update(path.join(f.directory, 'switch2/fs-execution-current.json'), value => {value.file = path.join(f.base, 'outside.json');});
  await write(path.join(f.base, 'outside.json'), {report:f.reportFile});
  await assert.rejects(f.attach(), /outside its run folder/);
  await assert.rejects(f.attach({kind:'ssh', runDirectory:f.directory, host:'ignored'}), /existing local/);
  await assert.rejects(f.attach({kind:'local', runDirectory:'../relative'}), /existing local/);
});

test('wrong live endpoint identity and unready native status cannot authorize attachment', async t => {
  const f = await fixture(t);
  f.state.ready = false; await assert.rejects(f.attach(), /not ready/);
  assert.equal(f.retainedRequests.length, 0);
  f.state.ready = true; f.state.corruptInfo = true;
  await assert.rejects(f.attach(), /exact held session/);
});

test('lost proof invalidates authorization permanently without touching source host or proof', async t => {
  const f = await fixture(t), context = await f.attach();
  await context.claimApplication('stremio');
  await update(f.resultFile, value => {value.rpc.state = 'stopped';});
  const stopped = await fs.readFile(f.resultFile);
  await assert.rejects(context.verify(), /no longer available/);
  await assert.rejects(fs.access(context.manifestPath), {code:'ENOENT'});
  await update(f.resultFile, value => {value.rpc.state = 'listening';});
  await assert.rejects(context.verify(), /no longer available/);
  await context.close();
  assert.equal(f.state.ready, true); assert.ok((await fs.stat(f.socketPath)).isSocket());
  assert.equal(JSON.parse(stopped).rpc.state, 'stopped');
  assert.equal(JSON.parse(await fs.readFile(f.resultFile)).rpc.state, 'listening');
});

test('uncertain live probe is never replayed and changed connection invalidates the selected run', async t => {
  const f = await fixture(t), context = await f.attach();
  const prior = f.requests.length; f.state.failHTTP = true;
  await assert.rejects(context.verify(), /socket hang up|reset/i);
  assert.equal(f.requests.length, prior+1);
  f.state.failHTTP = false;
  await assert.rejects(context.verify(), /socket hang up|reset/i);
  assert.equal(f.requests.length, prior+1);
  const another = await f.attach();
  await update(path.join(f.directory, 'connection.json'), value => {value.addresses.main += 8;});
  await assert.rejects(another.verify(), /session changed/);
});

test('closing during a claim cannot recreate authorization or stop the original host', async t => {
  const f = await fixture(t), context = await f.attach();
  const claiming = context.claimApplication('gpubrewlauncher');
  const closed = context.close();
  await assert.rejects(claiming, /closed|abort/i); await closed;
  await assert.rejects(fs.access(context.manifestPath), {code:'ENOENT'});
  assert.equal(f.state.ready, true); assert.ok((await fs.stat(f.socketPath)).isSocket());
  assert.ok(f.requests.every(row => row.command === 'status'));
  assert.ok(f.retainedRequests.every(row => row.command === 'retained-info'));
});

test('an owned pending status probe can be aborted without declaring the original session lost', async t => {
  const f = await fixture(t), context = await f.attach();
  f.state.holdHTTP = true;
  const before = f.requests.length, checking = context.verify();
  checking.catch(()=>{});
  const deadline = Date.now()+2000;
  while (f.requests.length === before && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve, 5));
  assert.equal(f.requests.length, before+1);
  context.abortVerification();
  await assert.rejects(checking, /abort/i);
  await fs.access(context.manifestPath);
  f.state.holdHTTP = false;
  assert.equal((await context.verify()).ready, true);
  assert.ok(f.requests.every(row=>row.command==='status'));
});

test('a retained operation busy reply is not replayed or mistaken for source loss by monitoring', async t => {
  const f = await fixture(t), context = await f.attach();
  f.state.retainedBusy = true;
  const count = f.retainedRequests.length;
  assert.equal((await context.verify()).retainedBusy, true);
  assert.equal(f.retainedRequests.length, count+1);
  await fs.access(context.manifestPath);
  await assert.rejects(context.claimApplication('stremio'), /Another memory request is active/);
  await assert.rejects(fs.access(path.join(f.directory, OWNER)), {code:'ENOENT'});
});

test('a generated report temporary file may disappear during code scanning without losing the held session', async t => {
  const f = await fixture(t), folder = path.join(f.directory, 'switch2/memory');
  const temporary = path.join(folder, 'report.json.123.1792967392773.fixture.tmp');
  await fs.writeFile(temporary, '{}', {mode:0o600});
  const original = fs.readdir; let removed = false;
  fs.readdir = async function (directory, ...args) {
    const entries = await original.call(this, directory, ...args);
    if (directory === folder && !removed) {await fs.unlink(temporary); removed = true;}
    return entries;
  };
  try {
    const context = await f.attach();
    assert.equal(removed, true); assert.equal((await context.verify()).ready, true);
  } finally {fs.readdir = original;}
});

test('post-claim monitoring never competes with active retained operations or reads mutable proof state', async t => {
  const f = await fixture(t), context = await f.attach();
  await context.claimApplication('ouncecake');
  const count = f.retainedRequests.length;
  f.state.retainedBusy = true;
  await update(f.reportFile, value => {value.retainedMemory.pending = {operation:'legitimate app operation'};});
  assert.equal((await context.verify()).ready, true);
  assert.equal(f.retainedRequests.length, count);
  await fs.access(context.manifestPath);
  await update(path.join(f.directory, 'switch2/fs-execution-current.json'), value => {value.cleanup.deferred = false;});
  await assert.rejects(context.verify(), /no longer available/);
  assert.equal(f.retainedRequests.length, count);
});
