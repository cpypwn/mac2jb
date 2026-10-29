const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const root = require('./module-home.cjs');
const electron = require('./electron.json');
const version = require('../../app/package.json').version;
const folder = path.join(require('node:os').homedir(), 'Library/Caches/mac2jb/VacooTube',
  `electron-${electron.version}-${electron.sha256['darwin-arm64'].slice(0, 16)}`);
const bundle = path.join(folder, 'Electron.app');
const binary = path.join(bundle, 'Contents/MacOS/Electron');
const entry = path.join(bundle, 'Contents/Resources/app/main.cjs');
const audio = path.join(root, 'server/local-package/vacootube-audio');
const archiveName = `electron-v${electron.version}-darwin-arm64.zip`;
const bundledArchive = path.join(root, 'runtime', archiveName);

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function locate() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw Error('The VacooTube Mac runtime requires an Apple Silicon Mac.');
  }
  if (!await exists(binary) && await exists(bundledArchive)) return install();
  for (const file of [binary, entry, audio]) {
    if (!await exists(file)) throw Error('Prepare the VacooTube Mac runtime first: ' + file);
  }
  const app = await require('./fork-source.cjs').locate(root, {
    packagedSource: path.resolve(__dirname, '../../app')
  });
  if (!app) throw Error('Prepare the current VacooTube source dependencies first.');
  await fs.chmod(audio, 0o700);
  await run('codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000 });
  return { binary, app, fromSource: true, sourceAvailable: true, version, electron: electron.version };
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  const stream = require('node:fs').createReadStream(file);
  for await (const bytes of stream) hash.update(bytes);
  return hash.digest('hex');
}

async function writeEntry() {
  const app = path.dirname(entry);
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({
    name: 'vacootube', version, main: 'main.cjs'
  }));
  await fs.writeFile(entry,
    "const path=require('node:path'),bridge=process.env.IZ_YOUTUBE_MODULE_ROOT;" +
    "if(!bridge)throw Error('Missing VacooTube module root');" +
    "process.env.IZ_YOUTUBE_PROFILE_DIRECTORY??=path.join(path.resolve(bridge,'../..'),'data/profile');" +
    "if(process.env.IZ_YOUTUBE_PROFILE_MAINTENANCE==='1')" +
    "require(path.join(bridge,'profile-maintenance.cjs')).main(require('electron')).catch(e=>{console.error(e.message);require('electron').app.exit(1);});" +
    "else require(path.join(bridge,'bootstrap.cjs'));\n");
  const plist = path.join(bundle, 'Contents/Info.plist');
  const key = 'NSAudioCaptureUsageDescription';
  const value = 'VacooTube captures its own playback audio to send it to the Switch.';
  try { await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]); }
  catch { await run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]); }
  await run('codesign', ['--force', '--deep', '--sign', '-', bundle], { timeout: 120000 });
  await run('codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 30000 });
}

async function install() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw Error('The VacooTube Mac runtime requires an Apple Silicon Mac.');
  }
  if (!await exists(audio)) throw Error('Build the VacooTube audio helper before preparing the runtime.');
  if (!await exists(binary)) {
    const name = archiveName;
    const expected = electron.sha256['darwin-arm64'];
    const url = `https://github.com/electron/electron/releases/download/v${electron.version}/${name}`;
    const temporary = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'vacootube-electron-'));
    try {
      const archive = path.join(temporary, name);
      const supplied = process.env.IZ_VACOOTUBE_ELECTRON_ARCHIVE || (await exists(bundledArchive) ? bundledArchive : null);
      if (supplied) await fs.copyFile(supplied, archive);
      else {
        const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw Error('Official Electron download failed: ' + response.status);
        const handle = await fs.open(archive, 'w', 0o600);
        try { for await (const bytes of response.body) await handle.write(bytes); }
        finally { await handle.close(); }
      }
      if (await digest(archive) !== expected) throw Error('Official Electron archive checksum mismatch.');
      const content = path.join(temporary, 'content');
      await fs.mkdir(content);
      await run('ditto', ['-x', '-k', archive, content], { timeout: 120000 });
      const extracted = path.join(content, 'Electron.app');
      if (!await exists(path.join(extracted, 'Contents/MacOS/Electron'))) {
        throw Error('Official Electron archive does not contain its app.');
      }
      await fs.mkdir(folder, { recursive: true });
      await fs.rename(extracted, bundle);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  await writeEntry();
  await require('./fork-source.cjs').prepare({
    home: root, packagedSource: path.resolve(__dirname, '../../app'), execute: run
  });
  return locate();
}

module.exports = { locate, install, writeEntry };
