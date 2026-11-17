// The parent runner owns the lifetime of an opt-in held FS endpoint.
//
// Besides the runner IPC channel, a held session may be released by dropping a
// sentinel file next to this module (inside the run's switch2 folder). The
// sentinel exists because a Windows harness that starts the runner inside a job
// object can have the runner killed without its finally block ever sending the
// IPC release; the pipeline child then dies with the job before it can run the
// 'Release FS resources' stage, leaving the console dirty. Two adapters use it:
// engine/rpc.cjs (status/stop) and lab tooling that has no IPC access.
const fs = require('node:fs');
const path = require('node:path');

const SENTINEL = 'hold-release';

function sentinelPath(directory = __dirname) {
  return path.join(directory, SENTINEL);
}

function waitForRelease(channel = process, sentinel = sentinelPath()) {
  if (typeof channel.send !== 'function')
    throw Error('Held FS mode requires the runner IPC channel');
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = reason => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      channel.removeListener('message', message);
      channel.removeListener('disconnect', disconnect);
      resolve(reason);
    };
    const message = value => {if (value?.type === 'release') finish('release');};
    const disconnect = () => finish('parent-disconnected');
    const poll = () => {
      try {if (fs.existsSync(sentinel)) finish('sentinel');} catch { /* keep waiting */ }
    };
    channel.on('message', message);
    channel.once('disconnect', disconnect);
    timer = setInterval(poll, 500);
    if (timer.unref) timer.unref();
    if (channel.connected === false) finish('parent-disconnected');
    poll();
  });
}

module.exports = {waitForRelease, sentinelPath, SENTINEL};
