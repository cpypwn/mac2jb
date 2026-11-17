const fs = require('node:fs');
const {args, ensureBridge, reserveAppArena, startHost} = require('./run-canary.cjs');
const {relay} = require('./relay.cjs');
const {loadTarget, assertFullSupported} =
  require('../civswitch/fs-kit/port/engine/shared/target.cjs');

function stopRequest(signals) {
  let requested = null, resolve;
  const promise = new Promise(done => {resolve = done;});
  const interrupt = () => request('SIGINT');
  const terminate = () => request('SIGTERM');
  function request(reason) {
    if (requested) return;
    requested = reason;
    resolve(reason);
  }
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  return {
    promise,
    get requested() {return requested;},
    close() {
      signals.removeListener('SIGINT', interrupt);
      signals.removeListener('SIGTERM', terminate);
    }
  };
}

async function runVerifiedSession({switchIp, macIp, profile}, dependencies = {}) {
  const stagedBridge = dependencies.ensureBridge || ensureBridge;
  const reserveArena = dependencies.reserveAppArena || reserveAppArena;
  const qualifyTiming = dependencies.qualifyTimingProof ||
    require('./timing-proof.cjs').qualifyTimingProof;
  const launchHost = dependencies.startHost || startHost;
  const runRelay = dependencies.relay || relay;
  const stop = stopRequest(dependencies.signals || process);
  const controller = new AbortController();
  let host, trafficPromise, relayStarted = false, held = false;
  const interrupted = () => {
    if (stop.requested) throw Error(`Gravity Circuit run stopped before native relay (${stop.requested})`);
  };
  try {
    const staged = await stagedBridge({switchIp, macIp, profile}, dependencies);
    interrupted();
    const arena = await reserveArena({switchIp, mode: 'full'}, dependencies);
    interrupted();
    const timingProof = await qualifyTiming({switchIp}, dependencies);
    interrupted();
    if (dependencies.beforeHostStart) await dependencies.beforeHostStart();
    interrupted();
    host = launchHost(macIp, undefined, {...dependencies, timingProof}, 'full');
    await Promise.race([host.ready, stop.promise.then(reason => {
      throw Error(`Gravity Circuit run stopped before native relay (${reason})`);
    })]);
    interrupted();
    trafficPromise = runRelay({switchIp, macIp, bridgePort: staged.bridge.port,
      signal: controller.signal});
    trafficPromise.catch(() => {});
    relayStarted = true;
    const relayEnded = trafficPromise.then(() => {
      throw Error('Gravity Circuit relay closed before held FS RPC was verified');
    });
    const hostEnded = host.finished.then(outcome => {
      throw Error(`Gravity Circuit FS host exited before held RPC was ready (${outcome.code ?? outcome.signal})`);
    });
    await Promise.race([host.heldReady, relayEnded, hostEnded]);
    held = true;
    process.stdout.write('4/4 verified. Gravity Circuit FS RPC is held; press Ctrl-C to release it.\n');
    const reason = await Promise.race([
      stop.promise,
      trafficPromise.then(() => {throw Error('Gravity Circuit relay closed while RPC was held');}),
      host.finished.then(outcome => {
        throw Error(`Gravity Circuit held FS host exited unexpectedly (${outcome.code ?? outcome.signal})`);
      })
    ]);
    host.stop();
    const outcome = await host.finished;
    if (outcome.code !== 0 || outcome.signal)
      throw Error(`Gravity Circuit FS host did not release cleanly (${outcome.code ?? outcome.signal})`);
    controller.abort();
    await trafficPromise.catch(error => {
      if (error.message !== 'Gravity Circuit relay stopped') throw error;
    });
    return {verified: true, held: false, releasedBy: reason, arena,
      bridge: staged.bridge, timingProof, outcome};
  } catch (error) {
    if (host && !relayStarted) {
      host.stop();
      await host.finished.catch(() => {});
    }
    if (host && relayStarted && !held) {
      process.stderr.write(`Gravity Circuit relay stopped before 4/4: ${error.message}. ` +
        'Native state is uncertain; press Ctrl-C to stop this session. Do not replay it.\n');
      await Promise.race([host.finished.catch(() => {}), stop.promise]);
      if (stop.requested) host.stop();
      await host.finished.catch(() => {});
    }
    if (host && held) {
      host.stop();
      await host.finished.catch(() => {});
    }
    throw error;
  } finally {
    controller.abort();
    stop.close();
  }
}

async function main(values = process.argv.slice(2), dependencies = {}) {
  assertFullSupported(loadTarget('gravcirc'));
  const {switchIp, macIp, profilePath} = args(values);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  return runVerifiedSession({switchIp, macIp, profile}, dependencies);
}

module.exports = {main, runVerifiedSession, stopRequest};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
