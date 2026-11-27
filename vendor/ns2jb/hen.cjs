#!/usr/bin/env node
// Acquire SmileBASIC RPC, then start RO and HEN from the supplied package.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const {validatePackage} = require('./engine/switch2/ro/validate-package.cjs');

const runScript = path.join(__dirname, 'run.cjs');
const usageText = [
  'Usage: node hen.cjs --dir PACKAGE_DIRECTORY [PC-LAN-IP]',
  'Start with SmileBASIC open at its Direct-mode prompt.',
].join('\n');

function usage(exitCode, output = process.stdout) {
  output.write(usageText + '\n');
  return exitCode;
}

function parseArgs(args) {
  if (args.includes('--help')) return {help: true};
  const dirOption = args.indexOf('--dir');
  if (dirOption < 0 || dirOption + 1 >= args.length) return {usage: true, exitCode: 1};
  const ship = path.resolve(args[dirOption + 1]);
  const rest = args.slice();
  rest.splice(dirOption, 2);
  if (rest.length > 1 || rest.some(arg => arg.startsWith('-'))) return {usage: true, exitCode: 1};
  return {ship, host: rest[0]};
}

function observe(child, output = process.stdout) {
  const seen = [];
  let exitCode;
  const lines = readline.createInterface({input: child.stdout});
  lines.on('line', line => seen.push(line));
  child.once('exit', code => { exitCode = code; });
  return {
    seen,
    waitFor(fragment, timeoutMs) {
      if (seen.some(line => line.includes(fragment))) return Promise.resolve();
      if (exitCode !== undefined) {
        return Promise.reject(Error(`Process exited before ${fragment}: ${exitCode}`));
      }
      return new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          if (timer) clearTimeout(timer);
          lines.off('line', onLine);
          child.off('exit', onExit);
          child.off('error', onError);
          error ? reject(error) : resolve();
        };
        const onLine = line => {
          if (line.includes(fragment)) finish();
        };
        const onExit = code => finish(Error(`Process exited before ${fragment}: ${code}`));
        const onError = error => finish(error);
        lines.on('line', onLine);
        child.once('exit', onExit);
        child.once('error', onError);
        if (timeoutMs) timer = setTimeout(() => finish(Error(`Timed out waiting for ${fragment}`)), timeoutMs);
      });
    },
  };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env || process.env;
  const output = dependencies.stdout || process.stdout;
  const spawnProcess = dependencies.spawn || spawn;
  const validate = dependencies.validatePackage || validatePackage;
  const startTimeoutMs = dependencies.startTimeoutMs ?? 0;
  const parsed = parseArgs(args);
  if (parsed.help) {
    usage(0, output);
    return {help: true};
  }
  if (parsed.usage) {
    usage(parsed.exitCode, output);
    return {usage: true, exitCode: parsed.exitCode};
  }

  const {ship, host} = parsed;
  const {programFiles} = validate(ship);
  if (!fs.statSync(dependencies.runScript || runScript, {throwIfNoEntry: false})?.isFile()) {
    throw Error(`Missing ns2jb run.cjs: ${dependencies.runScript || runScript}`);
  }

  let acquisition;
  const stopChildren = () => acquisition?.kill();
  const installSignals = dependencies.installSignals !== false;
  if (installSignals) {
    process.on('SIGINT', stopChildren);
    process.on('SIGTERM', stopChildren);
  }

  try {
    const launchEnv = {...env,
      NS2_BASIC_ARITY: env.NS2_BASIC_ARITY || '5',
      NS2_RO_IMAGE: path.join(ship, 'ro/main')};
    acquisition = spawnProcess(process.execPath,
      [dependencies.runScript || runScript, '--rpc', ...(host ? [host] : [])],
      {stdio: ['inherit', 'pipe', 'inherit'], env: launchEnv});
    acquisition.stdout.pipe(output);
    const rpcOutput = observe(acquisition, output);
    await rpcOutput.waitFor('RO frontend verified', startTimeoutMs);
    const folder = rpcOutput.seen.filter(line => line.startsWith('Run folder: ')).at(-1);
    if (!folder) throw Error('ns2jb did not print its run folder');
    const run = path.resolve(folder.slice('Run folder: '.length));
    const result = JSON.parse(fs.readFileSync(path.join(run, 'result.json')));
    if (!result.verified || result.rpc?.state !== 'listening') {
      throw Error('The held ns2jb RPC is not ready');
    }

    env.NS2_RUN_DIR = run;
    env.HBMENU_NRO = path.join(ship, 'hbmenu.nro');
    const startHen = dependencies.startHen ||
      require(path.join(run, 'switch2/ro/start-hen.cjs')).main;
    const started = await startHen(path.join(ship, 'hen/main'),
      path.join(ship, 'bootstrap.bin'), path.join(ship, 'game/main'), programFiles,
      dependencies.startHenAdapters);
    output.write(`HEN PID ${started.pid}; startup record: ${started.file}\n`);
    output.write('HEN launch completed! Please quit SmileBASIC and launch a Switch 2 game while holding the R button, on the second launch you will get hbmenu\n');
    output.write('Keep this process running until SmileBASIC closes.\n');
    if (acquisition.exitCode === null) {
      await new Promise(resolve => acquisition.once('exit', resolve));
    }
    return {started, run};
  } catch (error) {
    stopChildren();
    throw error;
  } finally {
    if (installSignals) {
      process.removeListener('SIGINT', stopChildren);
      process.removeListener('SIGTERM', stopChildren);
    }
  }
}

if (require.main === module) {
  main().then(result => {
    if (result?.exitCode) process.exitCode = result.exitCode;
  }).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {main, parseArgs, observe, usage, usageText};
