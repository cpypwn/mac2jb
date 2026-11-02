#!/usr/bin/env node
// Pull the save data of the title that is HOSTING the exploit.
//
//   node tools/pull-host-save.cjs <run-directory> <output-directory>
//
// Why this exists: fsp-srv's OpenSaveDataFileSystem (cmd 53) answers 0xe02, not
// 0x7d402, for the host title's own save - the save exists and the running
// application holds it (docs/RESULTS.md, 2026-10-29). So the title you exploit is
// the one title whose save you cannot open through the promoted root, which is
// exactly the save the metadata work needs (SmileBASIC 4 keeps its PLAYMENU
// project name and 40x69 icon there).
//
// The way around it is the application's own mounted save filesystem: the session
// already borrows it (that is how the acquisition creates its scratch), so cloning
// it gives a handle to the same files without going through the fsp-srv save open
// that refuses.
//
// Read-only by construction: it lists, opens for reading and closes. Nothing is
// written to the console.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

async function main() {
  const [runDirectory, outputDirectory] = process.argv.slice(2);
  if (!runDirectory || !outputDirectory) {
    console.error('usage: node pull-host-save.cjs <run-directory> <output-directory>');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const { Session } = require(path.join(engine, 'app/session.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const mounted = require(path.join(engine, 'app/mounted-save.cjs'));

  // Bind the session to the retained memory endpoint before issuing IPC.
  await request(current.socketPath, { command: 'root-native-info' });

  const s = new Session('pull-host-save-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  let save = null;
  try {
    save = await mounted.cloneMountedSave(s);
    console.error('cloned the host application\'s mounted save filesystem');
    await fs.mkdir(outputDirectory, { recursive: true });

    const manifest = [];
    async function walk(directory, disk, depth = 0) {
      if (depth > 12) throw Error('directory nesting exceeds 12 levels at ' + directory);
      const entries = await filesystem.listDirectory(s, save, directory, 2048);
      await fs.mkdir(disk, { recursive: true });
      for (const entry of entries) {
        const full = (directory.endsWith('/') ? directory : directory + '/') + entry.name;
        const target = path.join(disk, entry.name);
        if (!entry.name || entry.name.includes('/') || entry.name === '.' || entry.name === '..')
          throw Error('unexpected directory entry ' + JSON.stringify(entry.name));
        const opened = await filesystem.openFile(s, save, full);
        if (opened.result) {
          await walk(full, target, depth + 1);
          continue;
        }
        const size = Number(await filesystem.fileSize(s, opened.handle));
        const handle = await fs.open(target, 'w');
        const hash = crypto.createHash('sha256');
        let offset = 0;
        while (offset < size) {
          const chunk = Math.min(0x40000, size - offset);
          const data = await filesystem.readFile(s, opened.handle, offset, chunk);
          if (!data.length) throw Error('short read at ' + full + ' +' + offset);
          await handle.write(data);
          hash.update(data);
          offset += data.length;
        }
        await handle.close();
        await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
        manifest.push({ path: full, size, sha256: hash.digest('hex') });
        console.error(`  ${full} (${size} bytes)`);
      }
    }
    await walk('/', outputDirectory);

    manifest.sort((a, b) => a.path.localeCompare(b.path));
    await fs.writeFile(path.join(outputDirectory, 'manifest.json'),
      JSON.stringify({ source: 'mounted save of the host application', run: path.basename(run),
        files: manifest.length, bytes: manifest.reduce((n, f) => n + f.size, 0),
        entries: manifest }, null, 2) + '\n');
    console.log(`${manifest.length} files, ${manifest.reduce((n, f) => n + f.size, 0)} bytes ` +
      `-> ${outputDirectory}`);
  } finally {
    if (save !== null) await s.close(save).catch(() => {});
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
