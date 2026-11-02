const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const maxArchiveBytes = 1024 * 1024;
const maxOutputBytes = 2 * 1024 * 1024;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function check(condition, message) {
  if (!condition) throw Error(message);
}

async function manifestFor(root) {
  const data = await fs.readFile(path.join(root, 'packaging/NUP-source.json'));
  check(data.length < 16 * 1024, 'NUP source manifest is too large');
  const manifest = JSON.parse(data);
  check(manifest.repository === 'https://github.com/a55uka/nup' &&
    /^[0-9a-f]{40}$/.test(manifest.commit) &&
    manifest.archive === `https://codeload.github.com/a55uka/nup/zip/${manifest.commit}` &&
    /^[0-9a-f]{64}$/.test(manifest.archiveSha256) &&
    Object.keys(manifest.modules).sort().join(',') ===
      '__init__.py,cli.py,format.py,pack.py,read.py,verify.py' &&
    Object.values(manifest.modules).every(value => /^[0-9a-f]{64}$/.test(value)) &&
    manifest.zstandard.version === '0.25.0', 'The pinned NUP manifest is invalid');
  return manifest;
}

function cacheFor(manifest) {
  const parent = process.env.MAC2JB_NUP_TEST_CACHE ||
    path.join(os.homedir(), 'Library/Application Support/mac2jb/Tools/NUP');
  return path.join(parent, manifest.commit);
}

async function verifySource(folder, manifest) {
  const moduleDir = path.join(folder, 'nup');
  for (const [name, digest] of Object.entries(manifest.modules)) {
    const file = path.join(moduleDir, name);
    const stat = await fs.lstat(file);
    check(stat.isFile() && !stat.isSymbolicLink() &&
      sha256(await fs.readFile(file)) === digest,
    `The stored NUP source changed: ${name}`);
  }
  return moduleDir;
}

function download(url, limit = maxArchiveBytes, redirects = 0) {
  check(redirects <= 3, 'NUP source redirected too many times');
  const parsed = new URL(url);
  check(parsed.protocol === 'https:' &&
    ['codeload.github.com', 'github.com'].includes(parsed.hostname),
  'NUP source redirected outside GitHub');
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, {headers: {'User-Agent': 'mac2jb'}}, response => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        response.resume();
        resolve(download(new URL(response.headers.location, parsed).href, limit, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(Error(`Could not fetch NUP source (HTTP ${response.statusCode})`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', data => {
        size += data.length;
        if (size > limit) response.destroy(Error('NUP source archive is too large'));
        else chunks.push(data);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(Error('NUP source download timed out')));
    request.on('error', reject);
  });
}

function run(program, args, env = process.env, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let stopped = false;
    const forwardStop = () => child.kill('SIGTERM');
    process.once('SIGTERM', forwardStop);
    const timer = setTimeout(() => {
      stopped = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', data => {
        output += data.toString();
        if (output.length > maxOutputBytes && !stopped) {
          stopped = true;
          child.kill('SIGTERM');
        }
      });
    }
    child.on('error', error => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', forwardStop);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      process.removeListener('SIGTERM', forwardStop);
      if (stopped) reject(Error('NUP operation timed out or produced too much output'));
      else if (code !== 0) reject(Error(output.trim() || `NUP exited with status ${code}`));
      else resolve(output.trim());
    });
  });
}

async function prepare(root, manifest) {
  const target = cacheFor(manifest);
  try {
    await verifySource(target, manifest);
    return target;
  } catch (error) {
    if (await fs.stat(target).catch(() => null)) {
      throw Error('The stored NUP source has changed. Move its Tools/NUP folder aside and try again');
    }
  }
  const archive = await download(manifest.archive);
  check(sha256(archive) === manifest.archiveSha256,
    'The NUP source failed its pinned integrity check');
  await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  const temporary = await fs.mkdtemp(path.join(path.dirname(target), '.nup-'));
  try {
    const zip = path.join(temporary, 'source.zip');
    await fs.writeFile(zip, archive, {mode: 0o600});
    const extracted = path.join(temporary, 'extracted');
    await fs.mkdir(extracted, {mode: 0o700});
    await run('/usr/bin/ditto', ['-x', '-k', zip, extracted], process.env, 30000);
    const upstream = path.join(extracted, `nup-${manifest.commit}`, 'tools/nup/nup');
    const staged = path.join(temporary, 'stage');
    await fs.mkdir(path.join(staged, 'nup'), {recursive: true, mode: 0o700});
    for (const name of Object.keys(manifest.modules)) {
      const source = path.join(upstream, name);
      const stat = await fs.lstat(source);
      check(stat.isFile() && !stat.isSymbolicLink(), `NUP archive has an unsafe file: ${name}`);
      await fs.copyFile(source, path.join(staged, 'nup', name));
    }
    await verifySource(staged, manifest);
    await fs.rename(staged, target);
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
  return target;
}

async function pythonEnvironment(root, source) {
  const python = path.join(root, 'homebrew/python/bin/python3');
  const extra = path.join(root, 'integrations/nup-support/site-packages');
  const stat = await fs.stat(python);
  check(stat.isFile(), 'The bundled Python runtime is missing');
  const env = {...process.env, PYTHONPATH: [source, extra].join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1'};
  return {python, env};
}

async function operation(root, name, first, second) {
  const manifest = await manifestFor(root);
  const source = cacheFor(manifest);
  await verifySource(source, manifest).catch(() => {
    throw Error('Get the pinned NUP source before running this tool');
  });
  const {python, env} = await pythonEnvironment(root, source);
  const command = ['-m', 'nup.cli'];
  if (name === 'pack') {
    check(first && second && path.isAbsolute(first) && path.isAbsolute(second) &&
      second.toLowerCase().endsWith('.nup'), 'Choose a dump folder and a new .nup destination');
    check((await fs.stat(first)).isDirectory(), 'The selected dump folder is missing');
    check((await fs.stat(path.dirname(second))).isDirectory(), 'The destination folder is missing');
    check(!(await fs.stat(second).catch(() => null)), 'The NUP destination already exists');
    const partial = `${second}.mac2jb-${crypto.randomBytes(5).toString('hex')}.partial`;
    try {
      const output = await run(python, [...command, 'pack', first, partial, '--quiet'], env);
      const verified = await run(python, [...command, 'verify', partial], env);
      await fs.link(partial, second);
      return `${output}\n${verified}\nSaved ${second}`;
    } finally {
      await fs.unlink(partial).catch(() => {});
    }
  }
  check(first && path.isAbsolute(first) && first.toLowerCase().endsWith('.nup') &&
    (await fs.stat(first)).isFile(), 'Choose an existing .nup file');
  if (name === 'info' || name === 'list' || name === 'verify') {
    return run(python, [...command, name, first], env);
  }
  if (name === 'extract') {
    check(second && path.isAbsolute(second) &&
      !(await fs.stat(second).catch(() => null)), 'Choose a new extraction folder');
    const temporary = `${second}.mac2jb-${crypto.randomBytes(5).toString('hex')}.partial`;
    try {
      const output = await run(python, [...command, 'extract', first, temporary], env);
      check(!(await fs.stat(second).catch(() => null)), 'The extraction folder already exists');
      await fs.rename(temporary, second);
      return `${output}\nExtracted to ${second}`;
    } finally {
      await fs.rm(temporary, {recursive: true, force: true});
    }
  }
  throw Error('Unknown NUP operation');
}

async function main(args) {
  const [name, root, first, second] = args;
  check(name && root && path.isAbsolute(root), 'Usage: gui-nup.cjs ACTION RUNTIME [INPUT] [OUTPUT]');
  const manifest = await manifestFor(root);
  if (name === 'prepare') {
    const source = await prepare(root, manifest);
    console.log(`Pinned NUP source ready in ${source}`);
  } else if (name === 'status') {
    await verifySource(cacheFor(manifest), manifest);
    console.log('Pinned NUP source is ready');
  } else if (name === '--self-test') {
    const {python, env} = await pythonEnvironment(root, path.join(root, 'integrations/nup-support'));
    console.log(await run(python, ['-c', 'import zstandard; print(zstandard.__version__)'], env, 30000));
  } else {
    console.log(await operation(root, name, first, second));
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {manifestFor, verifySource, prepare, operation, cacheFor};
