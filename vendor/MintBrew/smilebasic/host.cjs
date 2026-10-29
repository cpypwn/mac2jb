#!/usr/bin/env node
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {chooseHost, connectCommand} = require('./connection.cjs');
const {pairingCode, listen} = require('./engine/lib/connection.cjs');
const {NativeClient} = require('./engine/lib/native.cjs');
const {qualify} = require('./engine/lib/qualify.cjs');
const {serve} = require('./engine/lib/bridge.cjs');

const BRIDGE_PORT = 39380;
const KEEP_SESSION = process.env.HB_KEEP_SESSION === '1';

// start-launcher.cjs owns the session directory during normal use and deletes
// it when the program exits. Running this host directly gets its own temporary
// directory instead. HB_KEEP_SESSION=1 retains a session under runs/.
async function createSessionDirectory() {
  const external = process.env.HB_SESSION_DIR;
  if (external) {
    const directory = path.resolve(external);
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    return {directory, owned:false};
  }
  const parent = KEEP_SESSION ? path.join(__dirname, '../runs') : os.tmpdir();
  if (KEEP_SESSION) await fs.mkdir(parent, {recursive:true, mode:0o700});
  return {directory: await fs.mkdtemp(path.join(parent, KEEP_SESSION ? 'launcher-' : 'gpubrewlauncher-')), owned:true};
}

async function main() {
  const host = await chooseHost(process.argv.slice(2)), token = pairingCode();
  const command = connectCommand(host, token);
  const session = await createSessionDirectory();
  const directory = session.directory;
  if (KEEP_SESSION && session.owned) console.log('Keeping this session in: ' + directory);
  const record = {started: new Date().toISOString(), purpose: 'MintBrew SmileBASIC session'};
  let native, bridge;
  try {
    const connected = await listen({host, port: BRIDGE_PORT, token, onRejected: console.error,
      onWaiting() {
        console.log('Graphics listener ready on ' + host + ':' + BRIDGE_PORT + '.');
        console.log('In fresh SmileBASIC Direct mode, enter:');
        console.log('  LOAD "TXT:NS2"');
        console.log('  RUN');
        console.log('  REMOVE NSR,&H60000000,&H3FFFFFFF');
        console.log('Then enter this session command:');
        console.log('  ' + command);
      }});
    native = new NativeClient(connected.connection, connected.addresses);
    record.qualification = await qualify(native);
    bridge = await serve(native);
    bridge.keepAwake(record.qualification.activity);
    await fs.mkdir(path.join(directory, 'shared'));
    await fs.copyFile(path.join(__dirname, 'engine/shared/rpc.cjs'), path.join(directory, 'shared/rpc.cjs'));
    await fs.writeFile(path.join(directory, 'connection.json'), JSON.stringify({port: bridge.port, token: bridge.token,
      addresses: {...native.addresses, session: path.basename(directory), target: 'switch2'}}), {mode: 0o600});
    console.log('Qualified native session ready for graphics inspection.');
    await new Promise(resolve => {
      const done = () => {process.removeListener('SIGINT', done); process.removeListener('SIGTERM', done); resolve();};
      connected.connection.socket.once('close', done);
      process.once('SIGINT', done); process.once('SIGTERM', done);
    });
    if (native.connection.error) record.disconnect = native.connection.error.message;
  } catch (error) {record.error = error.stack; throw error;}
  finally {
    await bridge?.close();
    await native?.stop();
    record.completed = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2), {mode: 0o600});
    if (session.owned && !KEEP_SESSION) await fs.rm(directory, {recursive:true, force:true});
  }
}
main().catch(error => {console.error(error.stack); process.exitCode = 1;});
