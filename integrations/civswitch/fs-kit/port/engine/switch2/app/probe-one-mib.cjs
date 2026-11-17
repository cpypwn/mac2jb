const fs = require('node:fs/promises');
const path = require('node:path');
const {Session, live, check, u64} = require('./session.cjs');
const mounted = require('./mounted-save.cjs');
const filesystem = require('./filesystem.cjs');
const domain = require('./domain.cjs');
const {paths} = require('../memory/paths.cjs');
const {loadTarget} = require('../../shared/target.cjs');
const {parseOneShotSize, clearOwnedScratch, attemptOneMiB} = require('./one-mib-transaction.cjs');
const {SIZE, attemptSplitMiB} = require('./split-mib-transaction.cjs');
const {fileReadOptions} = require('./file-read-options.cjs');

async function main() {
  const args = process.argv.slice(2);
  check(args.length === 0 || args.length === 1 && args[0] === '--split',
    'Usage: probe-one-mib.cjs [--split]');
  const split = args.length === 1;
  check(loadTarget().name === 'gravcirc', 'One MiB retry requires Gravity Circuit');
  const selectedSize = split ? SIZE : parseOneShotSize(process.env.NS2_ONE_SHOT_SIZE);
  const session = new Session('one-mib-' + Date.now(), 0x2400000);
  const proof = {session: live.session, target: 'gravcirc',
    mode: split ? 'split-mib' : 'one-mib-retry',
    selectedSize,
    started: new Date().toISOString(), leftovers: [], verified: false};
  const scratch = '/NS2_GAP_WSP_' + Date.now();
  const filename = scratch + '/probe_data';
  proof.scratchPath = scratch;
  let saved, normal, openFileHandle = null;
  try {
    await session.initialize();
    ({normal} = paths(session, domain));
    saved = await mounted.cloneMountedFilesystem(session, 'save');
    for (const item of await filesystem.listDirectory(session, saved, '/', 4096)) {
      if (!item.name.startsWith('NS2_GAP_WSP')) continue;
      const oldPath = '/' + item.name;
      try {
        proof.leftovers.push(await clearOwnedScratch(item.name, {
          statType: async () => {
            const reply = await normal(saved, 7, oldPath);
            check(!reply.result, 'Could not inspect old probe scratch');
            return reply.data.readUInt32LE();
          },
          listContents: () => filesystem.listDirectory(session, saved, oldPath, 2),
          deleteFile: async () => (await normal(saved, 1, oldPath + '/probe_data')).result,
          commitFileDelete: async () =>
            (await session.ipc('Commit old probe file removal', saved, 10)).result,
          verifyFileAbsent: async () =>
            (await normal(saved, 7, oldPath + '/probe_data')).canonicalResult === 0x202,
          deleteDirectory: async () => (await normal(saved, 3, oldPath)).result,
          commitDirectoryDelete: async () =>
            (await session.ipc('Commit old probe directory removal', saved, 10)).result,
          verifyDirectoryAbsent: async () =>
            (await normal(saved, 7, oldPath)).canonicalResult === 0x202,
        }));
      } catch (error) {
        proof.leftovers.push(error.scratchRow || {name: item.name, error: error.message});
        throw error;
      }
    }
    check((await normal(saved, 7, scratch)).canonicalResult === 0x202,
      'New scratch path already exists');
    const data = session.base + 0x1000000;
    try {
      const actions = {
        freeBytes: async () => {
          const reply = await normal(saved, 11, '/');
          check(!reply.result && reply.data.length >= 8, 'Save free space could not be read');
          return reply.data.readBigUInt64LE();
        },
        createDirectory: async () => (await normal(saved, 2, scratch)).result,
        commitDirectoryCreate: async () =>
          (await session.ipc('Commit one MiB scratch creation', saved, 10)).result,
        createFile: async size => (await normal(saved, 0, filename,
          Buffer.concat([u64(0), u64(size)]))).result,
        commitFileCreate: async () =>
          (await session.ipc('Commit one MiB probe file creation', saved, 10)).result,
        openWrite: async () => {
          openFileHandle = domain.oneHandle(await normal(saved, 8, filename,
            Buffer.from([3, 0, 0, 0])));
        },
        write: async size => {
          await session.call('memset', data, 0x66, size);
          const reply = await session.ipc('Write one MiB probe file', openFileHandle, 1,
            Buffer.concat([u64(0), u64(0), u64(size)]),
            {send: [{address: data, size, mode: 1}]});
          return reply.result;
        },
        writeChunk: async (offset, size, fill) => {
          await session.call('memset', data, fill, size);
          const reply = await session.ipc('Write split one MiB probe chunk', openFileHandle, 1,
            Buffer.concat([u64(0), u64(offset), u64(size)]),
            {send: [{address: data, size, mode: 1}]});
          return reply.result;
        },
        close: async () => {
          await session.close(openFileHandle);
          openFileHandle = null;
        },
        commitWrite: async () =>
          (await session.ipc('Commit one MiB probe file', saved, 10)).result,
        readBackChunk: async (offset, size, fill) => {
          openFileHandle = domain.oneHandle(await normal(saved, 8, filename,
            Buffer.from([1, 0, 0, 0])));
          const samples = [];
          try {
            const buffer = data + selectedSize;
            for (const at of [offset, offset + size - 0x10]) {
              await session.call('memset', buffer, 0, 0x10);
              const reply = await session.ipc('Read committed one MiB sample', openFileHandle, 0,
                Buffer.concat([u64(0), u64(at), u64(0x10)]),
                fileReadOptions(buffer, 0x10));
              if (reply.result) return {result: reply.result, matches: false, samples};
              const bytes = await session.readOwned(buffer, 0x10);
              samples.push({offset: at, matches: bytes.every(byte => byte === fill)});
            }
            return {result: 0, matches: samples.every(sample => sample.matches), samples};
          } finally {
            await session.close(openFileHandle);
            openFileHandle = null;
          }
        },
        readBack: async () => {
          openFileHandle = domain.oneHandle(await normal(saved, 8, filename,
            Buffer.from([1, 0, 0, 0])));
          try {
            const tail = data + selectedSize;
            await session.call('memset', tail, 0, 0x10);
            const reply = await session.ipc('Read committed one MiB tail', openFileHandle, 0,
              Buffer.concat([u64(0), u64(selectedSize - 0x10), u64(0x10)]),
              fileReadOptions(tail, 0x10));
            const bytes = await session.readOwned(tail, 0x10);
            return {result: reply.result, matches: bytes.every(byte => byte === 0x66)};
          } finally {
            await session.close(openFileHandle);
            openFileHandle = null;
          }
        },
        deleteFile: async () => (await normal(saved, 1, filename)).result,
        commitFileDelete: async () =>
          (await session.ipc('Commit one MiB probe file removal', saved, 10)).result,
        verifyFileAbsent: async () =>
          (await normal(saved, 7, filename)).canonicalResult === 0x202,
        deleteDirectory: async () => (await normal(saved, 3, scratch)).result,
        commitDirectoryDelete: async () =>
          (await session.ipc('Commit one MiB scratch removal', saved, 10)).result,
        verifyDirectoryAbsent: async () =>
          (await normal(saved, 7, scratch)).canonicalResult === 0x202,
      };
      proof.attempt = split ? await attemptSplitMiB(actions) :
        await attemptOneMiB(actions, selectedSize);
      proof.verified = true;
    } catch (error) {
      if (error.retryRow) proof.attempt = error.retryRow;
      if (error.splitRow) proof.attempt = error.splitRow;
      throw error;
    }
  } catch (error) {
    proof.error = error.stack;
    proof.cleanupDeferred = 'No save cleanup follows an uncertain native result';
    throw error;
  } finally {
    await session.cleanup();
    proof.cleanedUp = !session.base && !session.handles.size && !session.threads.size &&
      proof.attempt?.verifiedAbsent === true;
    proof.completed = new Date().toISOString();
    const file = path.join(__dirname, split ? 'split-mib-probe.json' : 'one-mib-probe.json');
    await fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({file, ...proof}));
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
