// Bounded experiment: the largest single IFile Write this save session
// accepts. Sizes run ascending; the first failure stops the probe because a
// failed giant write appears to poison the cloned session on this build.
const fs = require('node:fs/promises');
const path = require('node:path');
const {Session, live, check, u64} = require('./session.cjs');
const mounted = require('./mounted-save.cjs');
const filesystem = require('./filesystem.cjs');
const domain = require('./domain.cjs');
const {paths} = require('../memory/paths.cjs');

const SIZES = [0x1000, 0x100000, 0x400000, 0x800000];

async function main() {
  const session = new Session('write-size-' + Date.now(), 0x2400000);
  const proof = {session: live.session, started: new Date().toISOString(), results: [], verified: false};
  const scratch = '/NS2_GAP_WSP_' + Date.now();
  try {
    await session.initialize();
    const {normal} = paths(session, domain);
    const saved = await mounted.cloneMountedFilesystem(session, 'save');
    // Earlier probe rounds may have died before deleting their scratch, and a
    // leaked multi-MiB file skews the results; reclaim it first.
    const leftovers = [];
    for (const item of await filesystem.listDirectory(session, saved, '/', 4096)) {
      if (!item.name.startsWith('NS2_GAP_WSP')) continue;
      const entry = await normal(saved, 7, '/' + item.name);
      if (entry.result) {leftovers.push({name: item.name, statResult: entry.result}); continue;}
      const command = entry.data.readUInt32LE() === 0 ? 4 : 1;
      leftovers.push({name: item.name, deleteResult: (await normal(saved, command, '/' + item.name)).result});
    }
    proof.leftovers = leftovers;
    check((await normal(saved, 7, scratch)).canonicalResult === 0x202, 'Scratch already exists');
    check(!(await normal(saved, 2, scratch)).result, 'Scratch creation failed');
    const filename = scratch + '/probe_data';
    const data = session.base + 0x1000000;
    for (const size of SIZES) {
      check(!(await normal(saved, 0, filename, Buffer.concat([u64(0), u64(size)]))).result,
        'File creation failed at 0x' + size.toString(16));
      const fileHandle = domain.oneHandle(await normal(saved, 8, filename, Buffer.from([3, 0, 0, 0])));
      await session.call('memset', data, 0x66, size);
      const reply = await session.ipc('Write 0x' + size.toString(16), fileHandle, 1,
        Buffer.concat([u64(0), u64(0), u64(size)]),
        {send: [{address: data, size, mode: 1}]});
      proof.results.push({size, result: reply.result, canonical: reply.canonicalResult});
      const closed = await session.call('close', fileHandle, 0, 0);
      session.handles.delete(fileHandle);
      proof.results[proof.results.length - 1].closed = closed;
      const deleted = await normal(saved, 1, filename);
      proof.results[proof.results.length - 1].deleteResult = deleted.result;
      if (reply.result !== 0 || deleted.result !== 0) break;
    }
    // Phase 2: one 16 MiB file written as two 8 MiB Writes with an IFile
    // Flush after each, with read-back. The failed giant-write experiments
    // showed the save's dirty capacity is cumulative (~8 MiB), so the flush
    // must release it before the second half.
    if (proof.results.every(entry => entry.result === 0 && entry.deleteResult === 0)) {
      const half = 0x800000, full = 0x1000000;
      const split = {size: full, writes: []};
      check(!(await normal(saved, 0, filename, Buffer.concat([u64(0), u64(full)]))).result,
        'Split file creation failed');
      const fileHandle = domain.oneHandle(await normal(saved, 8, filename, Buffer.from([3, 0, 0, 0])));
      for (const offset of [0, half]) {
        await session.call('memset', data + offset, 0x66, half);
        const reply = await session.ipc('Split write at 0x' + offset.toString(16), fileHandle, 1,
          Buffer.concat([u64(0), u64(offset), u64(half)]),
          {send: [{address: data + offset, size: half, mode: 1}]});
        split.writes.push({offset, result: reply.result, canonical: reply.canonicalResult});
        if (reply.result !== 0) break;
        const flushed = await session.ipc('Flush at 0x' + offset.toString(16), fileHandle, 2);
        split.writes.push({flushAt: offset, result: flushed.result, canonical: flushed.canonicalResult});
        if (flushed.result !== 0) break;
      }
      if (split.writes.every(write => write.result === 0)) {
        await session.call('memset', data + full, 0, 0x20);
        for (const [index, offset] of [0, half].entries()) {
          const reply = await session.ipc('Read back at 0x' + offset.toString(16), fileHandle, 0,
            Buffer.concat([u64(0), u64(offset), u64(0x10)]),
            {receive: [{address: data + full + index * 0x10, size: 0x10, mode: 0}]});
          const bytes = await session.readOwned(data + full + index * 0x10, 0x10);
          split.writes.push({readAt: offset, result: reply.result,
            bytes: bytes.toString('hex'), matches: bytes.every(byte => byte === 0x66)});
        }
      }
      const closed = await session.call('close', fileHandle, 0, 0);
      session.handles.delete(fileHandle);
      split.closed = closed;
      split.deleteResult = (await normal(saved, 1, filename)).result;
      proof.split = split;
    }
    const removed = await normal(saved, 4, scratch);
    proof.scratchDeleteResult = removed.result;
    proof.verified = true;
  } catch (error) {proof.error = error.stack; throw error;}
  finally {
    await session.cleanup();
    proof.cleanedUp = !session.base && !session.handles.size && !session.threads.size;
    proof.completed = new Date().toISOString();
    const file = path.join(__dirname, 'write-size-probe.json');
    await fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({file, ...proof}));
  }
}
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
