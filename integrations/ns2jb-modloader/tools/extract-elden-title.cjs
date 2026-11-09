#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { verifiedRun } = require('../install.cjs');
const { attachGame, createGameFiles, readRomfs } = require('../lib/game-files/mount-api.cjs');
const { selection, openSelected } = require('../lib/content.cjs');

const title = '0400f5802371e000';
const names = [
  '/menu/hi/02_title.tpf.dcx',
  '/menu/low/02_title.tpf.dcx',
  '/menu/05_000_title.gfx',
  '/menu/05_001_title_logo.gfx',
];

async function main() {
  if (process.argv.length !== 4) {
    throw new Error('Usage: node extract-elden-title.cjs RUN_DIR OUTPUT_DIR');
  }
  const run = verifiedRun(path.resolve(process.argv[2]));
  const output = path.resolve(process.argv[3]);
  const attached = await attachGame(run);
  const files = createGameFiles(attached);
  let mount;
  try {
    mount = await openSelected(attached, files, await selection(attached, title));
    const entries = await readRomfs((offset, length) => files.read(mount, offset, length), mount.size);
    await fs.mkdir(output, { recursive: true, mode: 0o700 });
    for (const name of names) {
      const entry = entries.find(item => item.type === 'file' && item.path === name);
      if (!entry || entry.size < 16 || entry.size > 16 * 1024 * 1024) {
        throw new Error('Missing or unexpectedly sized title asset: ' + name);
      }
      const bytes = Buffer.alloc(entry.size);
      for (let offset = 0; offset < entry.size; offset += 0x40000) {
        const part = await files.read(mount, entry.offset + offset, Math.min(0x40000, entry.size - offset));
        if (part.length !== Math.min(0x40000, entry.size - offset)) {
          throw new Error('Short read for ' + name);
        }
        part.copy(bytes, offset);
      }
      const destination = path.join(output, name.slice(1));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      console.log(destination);
    }
  } finally {
    try {
      if (mount) await files.close(mount);
    } finally {
      await attached.close();
    }
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
