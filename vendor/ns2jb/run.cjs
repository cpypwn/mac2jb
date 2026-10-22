#!/usr/bin/env node
const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {pairingCode, listen} = require('./engine/lib/connection.cjs');
const {NativeClient} = require('./engine/lib/native.cjs');
const {qualify} = require('./engine/lib/qualify.cjs');
const {serve} = require('./engine/lib/bridge.cjs');

const port = 39380;
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});

function addresses(interfaces = os.networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(a =>
    a.family === 'IPv4' && !a.internal && a.netmask !== '255.255.255.255' &&
    !a.address.startsWith('169.254.')).map(a => a.address))];
}

async function chooseHost(args) {
  if (args.length > 1 || args.length === 1 && !net.isIPv4(args[0]))
    throw Error('Usage: node run.cjs [computer-IP]');
  if (args.length) return args[0];
  const choices = addresses();
  if (choices.length === 1) return choices[0];
  if (!choices.length) throw Error('Connect this computer to the console’s local network.');
  if (!process.stdin.isTTY)
    throw Error('Choose the address on the console’s network: node run.cjs IP\nAvailable: ' + choices.join(', '));
  choices.forEach((address, i) => console.log(`  ${i + 1}. ${address}`));
  const input = require('node:readline/promises').createInterface({input: process.stdin, output: process.stdout});
  try {
    const choice = await input.question('Which computer address can the Switch 2 reach? ');
    if (!/^[1-9][0-9]*$/.test(choice) || !choices[Number(choice) - 1]) throw Error('Choose one of the listed addresses.');
    return choices[Number(choice) - 1];
  } finally {input.close();}
}

function connectCommand(host, token) {
  return `V=START(${[port, ...host.split('.'), ...token].join(',')})`;
}

async function sourceDigest() {
  const names = ['run.cjs', 'bootstrap.bas'];
  async function walk(folder) {
    for (const entry of await fs.readdir(path.join(__dirname, folder), {withFileTypes: true})) {
      const name = folder + '/' + entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
      else throw Error('Unexpected runtime file: ' + name);
    }
  }
  await walk('engine');
  const entries = [];
  for (const name of names.sort()) entries.push([name,
    crypto.createHash('sha256').update(await fs.readFile(path.join(__dirname, name))).digest('hex')]);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function runEngine(directory) {
  const log = await fs.open(path.join(directory, 'run.log'), 'wx', 0o600);
  const output = createWriteStream(null, {fd: log.fd, autoClose: false});
  try {
    const child = spawn(process.execPath, [path.join(directory, 'switch2/pipeline.cjs')],
      {cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    child.stdout.pipe(output, {end: false});
    child.stderr.pipe(output, {end: false});
    const lines = readline.createInterface({input: child.stdout});
    lines.on('line', line => {
      if (/^[1-4]\/4 /.test(line)) console.log(line);
    });
    const code = await new Promise((resolve, reject) => {
      output.once('error', error => {child.kill('SIGTERM'); reject(error);});
      child.once('error', reject); child.once('close', resolve);
    });
    if (code !== 0) throw Error('The run stopped. Keep the runs folder and restart the console before trying again.');
  } finally {
    if (!output.destroyed)
      await new Promise((resolve, reject) => {output.once('error', reject); output.end(resolve);});
    await log.close();
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node run.cjs [computer-IP]\nSwitch 2 only. No npm install required. See README.md for the BASIC setup.');
    return;
  }
  const host = await chooseHost(args), token = pairingCode(), command = connectCommand(host, token);
  const workspace = path.join(__dirname, 'runs');
  await fs.mkdir(workspace, {recursive: true, mode: 0o700});
  const directory = await fs.mkdtemp(path.join(workspace, 'switch2-'));
  await fs.writeFile(path.join(directory, 'connect.txt'), command + '\n', {mode: 0o600});
  const result = {platform: 2, sourceSha256: await sourceDigest(), started: new Date().toISOString(), verified: false};
  let native, bridge, failure;
  try {
    const connected = await listen({host, port, token, onWaiting() {
      console.log(`Waiting for Switch 2 at ${host}:${port}.`);
      console.log('In a freshly opened SmileBASIC, load the saved bootstrap and enter:');
      console.log('  RUN\n  REMOVE NSR,&H60000000,&H3FFFFFFF');
      console.log('After the expected Out of memory message, enter:');
      console.log('  ' + command);
      console.log('Run folder: ' + directory);
    }});
    native = new NativeClient(connected.connection, connected.addresses);
    console.log('Connected. Checking the application...');
    result.bootstrap = await qualify(native);
    bridge = await serve(native);
    bridge.keepAwake(result.bootstrap.activity);
    await save(path.join(directory, 'connection.json'), {port: bridge.port, token: bridge.token,
      addresses: {...connected.addresses, session: path.basename(directory), target: 'switch2'}});
    for (const name of ['shared', 'switch2'])
      await fs.cp(path.join(__dirname, 'engine', name), path.join(directory, name), {recursive: true});
    await runEngine(directory);
    result.fs = JSON.parse(await fs.readFile(path.join(directory, 'switch2/fs-execution-current.json')));
    if (!result.fs.verified || !result.fs.restored || !result.fs.cleanup?.cleanedUp)
      throw Error('FS execution, restoration, or cleanup did not finish.');
    result.verified = true;
  } catch (error) {result.error = error.message; failure = error;}
  finally {
    for (const [name, close] of [['bridge', () => bridge?.close()], ['connection', () => native?.stop()]]) {
      try {await close();}
      catch (error) {(result.cleanupErrors ||= []).push({name, error: error.message}); failure ||= error;}
    }
    result.completed = new Date().toISOString();
    await save(path.join(directory, 'result.json'), result);
  }
  if (failure) throw Error(failure.message + '\nDetails: ' + directory);
  console.log('FS execution verified. Original instructions restored and scratch cleaned up.');
  console.log('Restart the console when finished.');
  return result;
}

module.exports = {main, addresses, chooseHost, connectCommand, sourceDigest};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
