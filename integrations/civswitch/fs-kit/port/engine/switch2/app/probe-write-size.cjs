const fs = require('node:fs/promises');
const path = require('node:path');
const {Session, live, check, u64} = require('./session.cjs');
const mounted = require('./mounted-save.cjs');
const filesystem = require('./filesystem.cjs');
const domain = require('./domain.cjs');
const {paths} = require('../memory/paths.cjs');
const {loadTarget} = require('../../shared/target.cjs');
const {GEOMETRY_SIZES, selectedGeometrySizes, removeEmptyScratch, probeGeometryFile} =
  require('./write-size-transaction.cjs');

const SIZES = [0x1000, 0x100000, 0x400000, 0x800000];
const geometryOnly = process.env.NS2_GEOMETRY_ONLY === '1';
const gravityGeometry = geometryOnly && loadTarget().name === 'gravcirc';
const writeSizeOnly = process.env.NS2_WRITE_SIZE_ONLY === '1';
const gravitySizes = gravityGeometry ? selectedGeometrySizes(process.env.NS2_WRITE_SIZE_MAX, true) :
  GEOMETRY_SIZES;
if (writeSizeOnly && !gravityGeometry) throw Error('Bounded write-size mode requires Gravity Circuit geometry');
if (gravityGeometry && (writeSizeOnly ? gravitySizes.at(-1) > 0x80000 : gravitySizes.at(-1) !== 0x80000))
  throw Error('Gravity Circuit geometry must stop at the 512 KiB candidate');

async function main() {
  const session = new Session('write-size-' + Date.now(), 0x2400000);
  const proof = {session: live.session, started: new Date().toISOString(), results: [], verified: false};
  if (gravityGeometry) proof.maxSize = gravitySizes.at(-1);
  const scratch = '/NS2_GAP_WSP_' + Date.now();
  if (gravityGeometry) proof.scratchPath = scratch;
  let saved, normal, filename, openFileHandle = null, scratchCreated = false;
  let geometryAbort = false;
  try {
    await session.initialize();
    ({normal} = paths(session, domain));
    saved = await mounted.cloneMountedFilesystem(session, 'save');
    if (gravityGeometry) {
      proof.space = {};
      for (const [name, command] of [['free', 11], ['total', 12]]) {
        const reply = await normal(saved, command, '/');
        proof.space[name] = {result: reply.result,
          bytes: !reply.result && reply.data.length >= 8 ? reply.data.readBigUInt64LE().toString() : null};
      }
    }
    const leftovers = [];
    proof.leftovers = leftovers;
    for (const item of await filesystem.listDirectory(session, saved, '/', 4096)) {
      if (!item.name.startsWith('NS2_GAP_WSP')) continue;
      const ownPath = '/' + item.name;
      const entry = await normal(saved, 7, ownPath);
      if (entry.result) {leftovers.push({name: item.name, statResult: entry.result}); continue;}
      if (gravityGeometry) {
        try {
          leftovers.push(await removeEmptyScratch(item.name, {
            statType: async () => entry.data.readUInt32LE(),
            listContents: async () =>
              (await filesystem.listDirectory(session, saved, ownPath, 2)).map(child => child.name),
            deleteDir: async () => (await normal(saved, 3, ownPath)).result,
            commitDelete: async () =>
              (await session.ipc('Commit empty write-size scratch removal', saved, 10)).result,
            verifyAbsent: async () => (await normal(saved, 7, ownPath)).canonicalResult === 0x202,
          }));
        } catch (error) {
          leftovers.push(error.scratchRow || {name: item.name, error: error.message});
          throw error;
        }
        continue;
      }
      const command = entry.data.readUInt32LE() === 0 ? 4 : 1;
      leftovers.push({name: item.name, deleteResult: (await normal(saved, command, '/' + item.name)).result});
    }
    if (geometryOnly) {
      check(gravityGeometry ? leftovers.every(item => item.verifiedAbsent === true) :
        leftovers.every(item => item.deleteResult === 0),
      gravityGeometry ? 'Previous write-size scratch needs manual inspection' :
        'Previous write-size scratch could not be removed');
      if (leftovers.length && !gravityGeometry)
        check(!(await session.ipc('Commit old write-size scratch removal', saved, 10)).result,
          'Previous write-size scratch removal did not commit');
    }
    check((await normal(saved, 7, scratch)).canonicalResult === 0x202, 'Scratch already exists');
    check(!(await normal(saved, 2, scratch)).result, 'Scratch creation failed');
    scratchCreated = true;
    if (gravityGeometry) {
      proof.scratchCreateCommitResult =
        (await session.ipc('Commit write-size scratch creation', saved, 10)).result;
      check(proof.scratchCreateCommitResult === 0, 'Write-size scratch creation did not commit');
    }
    filename = scratch + '/probe_data';
    const data = session.base + 0x1000000;
    if (gravityGeometry) {
      for (const size of gravitySizes) {
        try {
          const row = await probeGeometryFile(size, {
            create: async count => (await normal(saved, 0, filename,
              Buffer.concat([u64(0), u64(count)]))).result,
            openWrite: async () => {
              openFileHandle = domain.oneHandle(await normal(saved, 8, filename,
                Buffer.from([3, 0, 0, 0])));
            },
            write: async count => {
              await session.call('memset', data, 0x66, count);
              return session.ipc('Write 0x' + count.toString(16), openFileHandle, 1,
                Buffer.concat([u64(0), u64(0), u64(count)]),
                {send: [{address: data, size: count, mode: 1}]});
            },
            close: async () => {
              await session.close(openFileHandle);
              openFileHandle = null;
            },
            commitWrite: async () =>
              (await session.ipc('Commit write-size probe file', saved, 10)).result,
            readBack: async () => {
              openFileHandle = domain.oneHandle(await normal(saved, 8, filename,
                Buffer.from([1, 0, 0, 0])));
              try {
                const tail = data + size;
                await session.call('memset', tail, 0, 0x10);
                const reply = await session.ipc('Read committed write-size tail', openFileHandle, 0,
                  Buffer.concat([u64(0), u64(size - 0x10), u64(0x10)]),
                  {receive: [{address: tail, size: 0x10, mode: 1}]});
                const bytes = await session.readOwned(tail, 0x10);
                return {result: reply.result, matches: bytes.every(byte => byte === 0x66)};
              } finally {
                await session.close(openFileHandle);
                openFileHandle = null;
              }
            },
            delete: async () => (await normal(saved, 1, filename)).result,
            commitDelete: async () =>
              (await session.ipc('Commit write-size probe file removal', saved, 10)).result,
          });
          proof.results.push(row);
        } catch (error) {
          if (error.probeRow) proof.results.push(error.probeRow);
          geometryAbort = true;
          throw error;
        }
      }
    } else {
      for (const size of SIZES) {
        check(!(await normal(saved, 0, filename, Buffer.concat([u64(0), u64(size)]))).result,
          'File creation failed at 0x' + size.toString(16));
        openFileHandle = domain.oneHandle(await normal(saved, 8, filename, Buffer.from([3, 0, 0, 0])));
        await session.call('memset', data, 0x66, size);
        const reply = await session.ipc('Write 0x' + size.toString(16), openFileHandle, 1,
          Buffer.concat([u64(0), u64(0), u64(size)]),
          {send: [{address: data, size, mode: 1}]});
        proof.results.push({size, result: reply.result, canonical: reply.canonicalResult});
        if (geometryOnly && size === 0x800000 && reply.result === 0) {
          const tail = data + size;
          await session.call('memset', tail, 0, 0x10);
          const readBack = await session.ipc('Read write-size tail', openFileHandle, 0,
            Buffer.concat([u64(0), u64(size - 0x10), u64(0x10)]),
            {receive: [{address: tail, size: 0x10, mode: 1}]});
          const bytes = await session.readOwned(tail, 0x10);
          proof.results[proof.results.length - 1].readBack = {
            result: readBack.result, matches: bytes.every(byte => byte === 0x66)};
        }
        await session.close(openFileHandle);
        openFileHandle = null;
        proof.results[proof.results.length - 1].closed = 0;
        const deleted = await normal(saved, 1, filename);
        proof.results[proof.results.length - 1].deleteResult = deleted.result;
        if (geometryOnly && !deleted.result)
          proof.results[proof.results.length - 1].commitResult =
            (await session.ipc('Commit write-size probe file removal', saved, 10)).result;
        if (reply.result !== 0 || deleted.result !== 0) break;
        if (geometryOnly) check(proof.results.at(-1).commitResult === 0,
          'Write-size probe file removal did not commit');
      }
    }
    // the extended probe checks a split write; geometry mode needs only one 8 MiB write.
    if (!geometryOnly && proof.results.every(entry => entry.result === 0 && entry.deleteResult === 0)) {
      const half = 0x800000, full = 0x1000000;
      const split = {size: full, writes: []};
      check(!(await normal(saved, 0, filename, Buffer.concat([u64(0), u64(full)]))).result,
        'Split file creation failed');
      openFileHandle = domain.oneHandle(await normal(saved, 8, filename, Buffer.from([3, 0, 0, 0])));
      for (const offset of [0, half]) {
        await session.call('memset', data + offset, 0x66, half);
        const reply = await session.ipc('Split write at 0x' + offset.toString(16), openFileHandle, 1,
          Buffer.concat([u64(0), u64(offset), u64(half)]),
          {send: [{address: data + offset, size: half, mode: 1}]});
        split.writes.push({offset, result: reply.result, canonical: reply.canonicalResult});
        if (reply.result !== 0) break;
        const flushed = await session.ipc('Flush at 0x' + offset.toString(16), openFileHandle, 2);
        split.writes.push({flushAt: offset, result: flushed.result, canonical: flushed.canonicalResult});
        if (flushed.result !== 0) break;
      }
      if (split.writes.every(write => write.result === 0)) {
        await session.call('memset', data + full, 0, 0x20);
        for (const [index, offset] of [0, half].entries()) {
          const reply = await session.ipc('Read back at 0x' + offset.toString(16), openFileHandle, 0,
            Buffer.concat([u64(0), u64(offset), u64(0x10)]),
            {receive: [{address: data + full + index * 0x10, size: 0x10, mode: 1}]});
          const bytes = await session.readOwned(data + full + index * 0x10, 0x10);
          split.writes.push({readAt: offset, result: reply.result,
            bytes: bytes.toString('hex'), matches: bytes.every(byte => byte === 0x66)});
        }
      }
      await session.close(openFileHandle);
      openFileHandle = null;
      split.closed = 0;
      split.deleteResult = (await normal(saved, 1, filename)).result;
      proof.split = split;
    }
    const removed = await normal(saved, 4, scratch);
    proof.scratchDeleteResult = removed.result;
    check(!removed.result && (await normal(saved, 7, scratch)).canonicalResult === 0x202,
      'Write-size scratch remains');
    const commit = await session.ipc('Commit write-size scratch removal', saved, 10);
    proof.scratchCommitResult = commit.result;
    check(!commit.result, 'Write-size scratch removal did not commit');
    scratchCreated = false;
    proof.verified = true;
  } catch (error) {
    if (gravityGeometry) geometryAbort = true;
    proof.error = error.stack;
    throw error;
  }
  finally {
    if (scratchCreated && saved && normal && !geometryAbort) {
      try {
        if (await session.ready()) {
          if (openFileHandle && session.handles.has(openFileHandle)) await session.close(openFileHandle);
          if (filename && (await normal(saved, 7, filename)).canonicalResult !== 0x202)
            await normal(saved, 1, filename);
          const removed = await normal(saved, 4, scratch);
          proof.failureScratchDeleteResult = removed.result;
          const commit = removed.result ? null :
            await session.ipc('Commit failed write-size scratch removal', saved, 10);
          proof.failureScratchCommitResult = commit?.result;
          scratchCreated = removed.result !== 0 || commit?.result !== 0 ||
            (await normal(saved, 7, scratch)).canonicalResult !== 0x202;
        }
      } catch (error) {proof.cleanupError = error.stack;}
    }
    await session.cleanup();
    proof.cleanedUp = !session.base && !session.handles.size && !session.threads.size && !scratchCreated;
    if (geometryAbort) proof.cleanupDeferred = 'The game must restart before inspecting the scratch path';
    proof.completed = new Date().toISOString();
    const file = path.join(__dirname, 'write-size-probe.json');
    await fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({file, ...proof}));
  }
}
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
