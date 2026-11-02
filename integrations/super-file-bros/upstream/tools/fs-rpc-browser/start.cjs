#!/usr/bin/env node
const fs = require('node:fs/promises'), path = require('node:path'), net = require('node:net');
const {spawn} = require('node:child_process');
process.env.NS2_FS_BROWSER = '1';
async function main(args = process.argv.slice(2)) {
  require('./requirements.cjs').check();
  const brand = require('./brand.cjs');
  let run, host, noOpen = false, resumeWindow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run') run = args[++i];
    else if (args[i] === '--host') host = args[++i];
    else if (args[i] === '--resume-window') resumeWindow = true;
    else if (args[i] === '--no-open') noOpen = true;
    else if (args[i] === '--help') {console.log(brand.name + ' ' + brand.version + '\nUsage: node start.cjs [--run /absolute/held-fs-run --host CONSOLE_IP] [--no-open]\nKeep the original ns2jb2/ns2jb --rpc process running. Read README.md before changing console files.'); return;}
    else throw Error('Unknown option: ' + args[i]);
  }
  const {saveJson, readJson} = require('../../core/session/ledger.cjs');
  const {create, configFile} = require('./server.cjs');
  if (run || host) {
    if (!path.isAbsolute(run || '') || !net.isIPv4(host || '')) throw Error('Provide both --run and --host');
    await saveJson(configFile, {...await readJson(configFile, {}), run: await fs.realpath(run), host});
  }
  const previous = resumeWindow ? await readJson(path.join(__dirname, '../../data/state/fs-rpc-browser/window.json'), {}) : {};
  const previousUrl = previous.url ? new URL(previous.url) : null;
  if (previousUrl && (previousUrl.hostname !== '127.0.0.1' || previousUrl.protocol !== 'http:')) throw Error('Invalid saved tool address');
  const app = await create(previousUrl ? {port: Number(previousUrl.port), token: previousUrl.hash.slice(1)} : {});
  await saveJson(path.join(__dirname, '../../data/state/fs-rpc-browser/window.json'), {pid: process.pid, url: app.url});
  console.log(brand.name + ' ' + brand.version + '\nUse caution: changing, corrupting or deleting files can have unexpected consequences. Back up important data.\n' + app.url);
  if (!noOpen) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', app.url] : [app.url];
    const child = spawn(command, args, {detached: true, stdio: 'ignore', shell: false});
    child.on('error', error => process.stderr.write('Open the local tool link manually: ' + error.message + '\n')); child.unref();
  }
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await require('../dolphin-fs-rpc/control.cjs').request('stop', {cancelDownloads: true}).catch(() => {});
    app.server.closeAllConnections(); await app.close();
  };
  process.once('SIGINT', () => close().catch(console.error)); process.once('SIGTERM', () => close().catch(console.error));
  return app;
}
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {main};
