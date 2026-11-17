const fs = require('node:fs');
const net = require('node:net');
const {NativeClient} = require('../civswitch/fs-kit/port/engine/lib/native.cjs');
const {probeDomainLive} = require('./probe-domain-live.cjs');
const {matchingBoot, runCloneControl, validateEvidence} = require('./clone-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const {openConnection} = require('./native-readonly-smoke.cjs');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const bridge = require('./transport-probe.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

function balatroTarget() {
  return {name: 'balatro', sdkBytes: profile.sdkCode.size,
    nativeFunctions: {memcpy: profile.symbols.memcpy.offset,
      memmove: profile.symbols.memmove.offset,
      queryMemory: profile.symbols.svcQueryMemory.offset}};
}

async function runCloneLive({host, macIp, arenaNonce, evidence, probe = probeDomainLive,
  stage = stageNativeBridge, connect = openConnection, execute = executeLua,
  makeNative = (connection, addresses) => new NativeClient(connection, addresses, balatroTarget()),
  port = bridge.PORT, preflightOnly = false, onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4) {
    throw new TypeError('Balatro clone control requires Switch and Mac IPv4 addresses');
  }
  if (!/^[0-9a-f]{16}$/.test(arenaNonce || '')) {
    throw new TypeError('Balatro clone control requires the retained arena owner nonce');
  }
  if (typeof onPhase !== 'function' || typeof preflightOnly !== 'boolean') {
    throw new TypeError('Balatro clone control phase handler or mode is invalid');
  }
  validateEvidence(evidence);
  const nonceBytes = () => Buffer.from(evidence.nonce, 'hex');
  const inspect = () => probe({host, nonceBytes});
  onPhase('read-only mounted-domain preflight');
  matchingBoot(evidence, await inspect());
  const staged = await stage({host, macIp, nonce: arenaNonce, port, execute, onPhase});
  let connection;
  let native;
  let result;
  let operationError;
  const cleanupErrors = [];
  try {
    if (staged.nonce !== arenaNonce || staged.port !== port ||
        !/^0x[0-9a-f]+$/.test(staged.arenaBase || '')) {
      throw new Error('Balatro bridge stage returned a different owner');
    }
    if (preflightOnly) {
      onPhase('read-only mounted-domain post-stage check');
      matchingBoot(evidence, await inspect());
      result = {gameProfile: profile.gameProfile, sdkBase: evidence.sdkBase,
        arenaNonce, status: 'preflight verified; no native TCP or marker write attempted'};
    } else {
      onPhase('connect native bridge');
      connection = await connect(host, port);
      onPhase('verify native bridge SDK');
      const hello = bridge.parseHello(await connection.read(128),
        {arenaBase: staged.arenaBase});
      if (hello.sdkBase !== evidence.sdkBase ||
          hello.sdkCrc32 !== Number.parseInt(evidence.sdkCrc32, 16)) {
        throw new Error('Balatro bridge SDK changed since read-only domain evidence');
      }
      onPhase('read-only mounted-domain check after pinned greeting');
      matchingBoot(evidence, await inspect());
      native = makeNative(connection, {sdk: Number(BigInt(hello.sdkBase)),
        scratch: Number(BigInt(hello.scratch))});
      const transport = new BalatroCloneTransport({native, evidence,
        inspectLive: inspect});
      onPhase('verify native functions');
      await transport.initialize();
      result = await runCloneControl({evidence, transport, onPhase});
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (native) {
      onPhase('stop native bridge');
      try {await native.stop();}
      catch (error) {cleanupErrors.push(error);}
    } else connection?.close();
    try {
      onPhase('close transport listener');
      bridge.parseCloseReply(await execute({host, port: 9026,
        source: bridge.makeCloseSource({nonce: arenaNonce, hostIp: macIp, port}),
        timeoutMs: 15000}), {port});
    } catch (error) {cleanupErrors.push(error);}
  }
  if (operationError && cleanupErrors.length) {
    throw new AggregateError([operationError, ...cleanupErrors],
      'Balatro clone control failed and transport cleanup was not verified');
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors,
      'Balatro cloned marker passed but transport cleanup was not verified');
  }
  return {...result, sdkBase: evidence.sdkBase, arenaNonce,
    nativeTransport: 'closed', borrowedSession: 'preserved'};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 5 || !['--live', '--preflight-only'].includes(argv[4]) ||
      net.isIP(argv[0]) !== 4 || net.isIP(argv[1]) !== 4) {
    process.stderr.write('usage: node clone-control-live.cjs <switch-ipv4> <mac-ipv4> <arena-owner-nonce> <same-boot-evidence.json> <--preflight-only|--live>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const evidence = validateEvidence(JSON.parse(fs.readFileSync(argv[3], 'utf8')));
    process.stdout.write(`${JSON.stringify(await runCloneLive({host: argv[0],
      macIp: argv[1], arenaNonce: argv[2], evidence,
      preflightOnly: argv[4] === '--preflight-only',
      onPhase: phase => process.stderr.write(`phase: ${phase}\n`)}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {balatroTarget, runCloneLive, main};
if (require.main === module) main();
