const fs = require('node:fs/promises');
const path = require('node:path');
const { cleanup, resultError } = require('./protocol.cjs');
const { OUTPUT_BYTES } = require('./tar.cjs');
const {
  align,
  encodeConfiguration,
  readCiv7Image,
  resolveSdkFunctions,
  wanted,
} = require('./civ7-runtime.cjs');

const CONFIG_OFFSET = 0x4000;
const FUNCTIONS_OFFSET = 0x5000;
const IMAGE_OFFSET = 0x10000;
const INDEX_OFFSET = 0x20000;
const DATA_BYTES = 0x400000;
const CIV7_MAX_CLIENTS = 8;
const CIV7_SLOT_BYTES = 4096;

const diagnosticNames = new Map([
  [0, 'none'],
  [1, 'unexpected reply handles'],
  [2, 'invalid domain reply header'],
  [3, 'missing SFCO reply'],
  [4, 'CMIF command failed'],
  [5, 'invalid reply extent'],
  [6, 'invalid child object'],
  [7, 'unexpected read child object'],
  [8, 'short file read'],
  [9, 'open returned no child object'],
  [10, 'open transport failed'],
  [11, 'read transport failed'],
  [12, 'close transport failed'],
]);

function check(value, message) {
  if (!value) throw new Error(message);
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error('Cannot read ' + label + ' at ' + file + ': ' + error.message);
  }
}

function codeEntry(entry, label, sdkBytes) {
  check(entry && Number.isInteger(entry.offset) && entry.offset >= 0 && entry.offset < sdkBytes &&
    entry.offset % 4 === 0 && typeof entry.bytes === 'string' && /^(?:[0-9a-f]{2}){4,256}$/i.test(entry.bytes),
  'Civ7 connector has no verified ' + label);
  return entry;
}

async function loadCiv7Artifacts(run) {
  const [connection, target, sdkFunctions] = await Promise.all([
    readJson(path.join(run, 'connection.json'), 'connector connection'),
    readJson(path.join(run, 'shared/target.civ7.json'), 'Civ7 target'),
    readJson(path.join(run, 'shared/sdk-functions.json'), 'Civ7 SDK functions'),
  ]);
  check(connection.addresses?.target === 'civ7',
    'This run targets ' + JSON.stringify(connection.addresses?.target) + ', not Civ7');
  check(target.name === 'civ7' && Number.isInteger(target.sdkBytes) && target.sdkBytes > 0,
    'The connector does not describe a supported Civ7 SDK');
  for (const name of ['send', 'close', 'free']) {
    codeEntry(sdkFunctions[name], 'SDK function ' + name, target.sdkBytes);
  }
  return { connection, target, sdkFunctions };
}

function validAddress(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 2 ** 39 && value % 8 === 0;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KiB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MiB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GiB';
}

function transferSummary(current) {
  const files = Number(current.files);
  return files + ' ' + (files === 1 ? 'file' : 'files') +
    ' (' + formatBytes(current.sent) + ' total)';
}

async function deployCiv7Ftp({ attachment: a, image, index, sources, port }) {
  const { target, sdkFunctions } = await loadCiv7Artifacts(a.run);
  const codeBytes = align(image.length);
  check(codeBytes <= INDEX_OFFSET - IMAGE_OFFSET, 'Civ7 FTP image exceeds its staging region');

  const sourceOffset = align(INDEX_OFFSET + index.length);
  const dataOffset = align(sourceOffset + sources.length * 24);
  const outputBytes = index.readUInt32LE(8) === 2 ? OUTPUT_BYTES : 0;
  const ipcOffset = align(dataOffset + DATA_BYTES);
  const slotsOffset = align(ipcOffset + 8192 + outputBytes);
  const workBytes = slotsOffset + CIV7_MAX_CLIENTS * CIV7_SLOT_BYTES;
  const work = new a.Session('ftp-civ7-' + Date.now(), align(workBytes));
  work.record = async () => {};

  let ro;
  let pid;
  let mappings = [];
  let currentPromise;
  let loopPromise;
  let loopOutcome;
  let lastStatus;
  let uncertainFailure;
  let stopping = false;
  let ready = false;
  let closed = false;

  async function roRequest(command, values) {
    const input = Buffer.alloc(32);
    values.forEach((value, i) => input.writeBigUInt64LE(BigInt(value), i * 8));
    const reply = await work.ipc('Civ7 FTP owned code mapping', ro, command, input, {
      pid: true,
      copies: [0xffff8001],
    });
    if (reply.result) throw resultError('Civ7 FTP owned code mapping', reply.result);
    return reply.data;
  }

  async function status() {
    const data = await work.readOwned(work.base + CONFIG_OFFSET, 200);
    return {
      state: data.readUInt32LE(16),
      result: data.readUInt32LE(20),
      sent: data.readBigUInt64LE(32),
      files: data.readBigUInt64LE(40),
      nativeResult: data.readBigUInt64LE(48),
      phase: data.readUInt32LE(60),
      diagnostic: data.readUInt32LE(136),
      packet0: data.readUInt32LE(140),
      packet1: data.readUInt32LE(144),
      packetAt: data.readUInt32LE(148),
      packetWord: data.readUInt32LE(152),
      expected: data.readBigUInt64LE(160),
      actual: data.readBigUInt64LE(168),
      sessions: data.readBigUInt64LE(176),
      listenerFd: data.readInt32LE(184),
      closedSessions: data.readBigUInt64LE(192),
    };
  }

  function describeStatus(current) {
    const hex = (value) => '0x' + value.toString(16);
    return 'state=' + current.state + ', result=' + hex(current.result) +
      ', nativeResult=' + hex(current.nativeResult) + ', phase=' + hex(current.phase) +
      ', diagnostic=' + current.diagnostic + ' (' +
      (diagnosticNames.get(current.diagnostic) || 'unknown') + ')' +
      ', packet=[' + hex(current.packet0) + ', ' + hex(current.packet1) +
      '], at=' + hex(current.packetAt) + ', word=' + hex(current.packetWord) +
      ', expected=' + current.expected + ', actual=' + current.actual +
      ', sessions=' + current.sessions + ', files=' + current.files +
      ', sent=' + current.sent + ', listenerFd=' + current.listenerFd +
      ', closedSessions=' + current.closedSessions +
      ', activeSessions=' + (current.sessions - current.closedSessions);
  }

  function cleanupStep(label, operation) {
    return async () => {
      try {
        await operation();
      } catch (error) {
        throw new Error(label + ': ' + error.message);
      }
    };
  }

  async function releaseStoppedResources() {
    await cleanup([
      ...mappings.slice().reverse().map((mapping, index) => cleanupStep(
        'unmap executable page ' + (mappings.length - index),
        () => roRequest(0x524f0013, [pid, mapping.source, mapping.destination, 4096]),
      )),
      cleanupStep('release Civ7 FTP allocation', () => work.cleanup()),
    ]);
    mappings = [];
  }

  async function invoke(destination) {
    work.threads.add('civ7-ftp:registered-call');
    try {
      let result;
      try {
        result = await work.rpc.call3(destination, work.base + CONFIG_OFFSET, 0, 0);
      } catch (error) {
        uncertainFailure = error;
        throw error;
      }
      const current = await status();
      lastStatus = current;
      if (current.state !== 2 || current.result || result) {
        throw new Error('FTP server error: ' + describeStatus(current) +
          ', callResult=0x' + result.toString(16));
      }
      return current;
    } finally {
      work.threads.delete('civ7-ftp:registered-call');
    }
  }

  async function run(destination) {
    do {
      currentPromise = invoke(destination);
      await currentPromise;
    } while (!stopping);
    return lastStatus;
  }

  async function close() {
    if (closed) return;
    stopping = true;
    if (loopPromise) {
      const outcome = await Promise.race([
        loopPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 70000)),
      ]);
      if (!outcome || uncertainFailure) {
        throw new Error(
          'The current Civ7 FTP call is still active or its bridge disconnected. ' +
          'Its mappings and allocation were retained; close the FTP client and restart the console before retrying.',
        );
      }
    }
    if (!work.base) {
      a.s.threads.delete('standalone-civ7-ftp');
      closed = true;
      return;
    }
    // Service renewals keep the listening descriptor open. Run one final
    // stopped invocation to close it on the same registered console thread
    // before unmapping the payload.
    if (lastStatus?.listenerFd >= 0) {
      const stop = Buffer.alloc(4);
      stop.writeUInt32LE(1);
      await work.write(work.base + CONFIG_OFFSET + 12, stop);
      const destination = mappings[0]?.destination;
      check(destination, 'Missing Civ7 FTP entry mapping during shutdown');
      await invoke(destination);
    }
    const current = lastStatus || (loopPromise ? await status() : null);
    await releaseStoppedResources();
    a.s.threads.delete('standalone-civ7-ftp');
    closed = true;
    if (ready && current) console.log('FTP server stopped. Transferred ' + transferSummary(current) + '.');
    if (loopOutcome?.error) throw loopOutcome.error;
  }

  try {
    await work.initialize();
    // `free` normally resolves through the SDK-relative call path, but also
    // register it as an address call so cleanup remains valid across connector
    // target-range differences.
    for (const entry of [sdkFunctions.send, sdkFunctions.close, sdkFunctions.free]) {
      await work.rpc.verifyFunction(a.live.sdk + entry.offset, entry.bytes);
    }

    const symbols = await resolveSdkFunctions({
      read: work.read.bind(work),
      query: work.rpc.query,
      base: a.live.sdk,
      sdkBytes: target.sdkBytes,
    });
    // Verify the SDK socket path on the connector's registered application
    // thread before mapping or starting the server.
    const probeFd = await work.rpc.call3(symbols.socket, 2, 1, 0);
    check(probeFd < 0x80000000, 'Civ7 socket preflight failed: 0x' + probeFd.toString(16));
    const probeClose = await work.rpc.call3(symbols.close, probeFd, 0, 0);
    check(!probeClose, 'Civ7 socket preflight close failed: 0x' + probeClose.toString(16));
    const functions = Buffer.alloc(15 * 8);
    Object.keys(wanted).forEach((name, i) => {
      functions.writeBigUInt64LE(BigInt(symbols[name]), i * 8);
    });
    functions.writeBigUInt64LE(BigInt(a.live.sdk + sdkFunctions.send.offset), 11 * 8);
    functions.writeBigUInt64LE(BigInt(a.live.sdk + sdkFunctions.close.offset), 12 * 8);

    const configuration = encodeConfiguration({
      functions: work.base + FUNCTIONS_OFFSET,
      index: work.base + INDEX_OFFSET,
      indexBytes: index.length,
      sourceAddress: work.base + sourceOffset,
      sources,
      data: work.base + dataOffset,
      dataBytes: DATA_BYTES,
      outputBytes,
      ipcBuffer: work.base + ipcOffset,
      slots: work.base + slotsOffset,
      slotBytes: CIV7_SLOT_BYTES,
      maxClients: CIV7_MAX_CLIENTS,
      port,
    });
    configuration.config.writeInt32LE(-1, 184);
    await work.write(work.base + CONFIG_OFFSET, configuration.config);
    await work.write(work.base + FUNCTIONS_OFFSET, functions);
    await work.write(work.base + sourceOffset, configuration.sources);
    await work.write(work.base + INDEX_OFFSET, index);
    await work.write(work.base + IMAGE_OFFSET, image);

    ro = await a.service('ro:dmnt');
    const reply = await work.ipc('Civ7 FTP verify application process', ro, 0x524f0010, Buffer.alloc(32), {
      pid: true,
      copies: [0xffff8001],
    });
    if (reply.result) throw resultError('Civ7 FTP verify application process', reply.result);
    pid = reply.data.readBigUInt64LE().toString();
    const destination = Number(reply.data.readBigUInt64LE(88));
    check(validAddress(destination), 'RO returned an invalid Civ7 code destination');
    for (let offset = 0; offset < codeBytes; offset += 4096) {
      const source = work.base + IMAGE_OFFSET + offset;
      const targetAddress = destination + offset;
      await roRequest(0x524f0012, [pid, source, targetAddress, 4096]);
      mappings.push({ source, destination: targetAddress });
    }
    await work.rpc.verifyFunction(destination, image.subarray(0, Math.min(256, image.length)));
    a.s.threads.add('standalone-civ7-ftp');
    loopPromise = run(destination).then(
      (result) => {
        loopOutcome = { result };
        return loopOutcome;
      },
      (error) => {
        loopOutcome = { error };
        return loopOutcome;
      },
    );

    const early = await Promise.race([
      currentPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    if (early) {
      throw new Error(
        'Civ7 FTP returned before accepting a client: ' + describeStatus(early),
      );
    }

    ready = true;
    return {
      close,
      status,
      done: loopPromise,
      get finished() { return Boolean(loopOutcome); },
    };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], error.message + '\n' + closeError.message);
    }
    throw error;
  }
}

module.exports = { deployCiv7Ftp, loadCiv7Artifacts, readCiv7Image };
