'use strict';
const path = require('node:path');
const os = require('node:os');
const P = require('../../stremio/protocol.cjs');

const HOLD_MS = 900;
const B_BUTTON = 1 << 1;
const MINUS_BUTTON = 1 << 11;
const check = (value, message) => {if (!value) throw Error(message);};

async function writeChunks(rpc, address, bytes) {
  for (let offset = 0; offset < bytes.length; offset += P.WRITE_BYTES)
    await rpc.write(address + offset, bytes.subarray(offset, offset + P.WRITE_BYTES));
}

async function createGraphics({rpc, gpu, directory, onProgress = () => {}, onReturn = () => {},
  onFatal = () => {}, dependencies = {}}) {
  const mapped = gpu?.privateStorage?.mapped;
  check(Number.isSafeInteger(mapped) && mapped >= 4096 && mapped % 4096 === 0 &&
    mapped + P.MEMORY_BYTES < 2 ** 39 && gpu.privateStorage.bytes === P.MEMORY_BYTES,
  'MintBrew Stremio requires its owned media buffer.');
  const createReceiver = dependencies.createReceiver || require('../../stremio/receiver.cjs').create;
  const createTransport = dependencies.createTransport || P.createTransport;
  const now = dependencies.now || Date.now;
  const nativeRpc = Object.create(rpc);
  nativeRpc.write = (address, bytes) => writeChunks(rpc, address, bytes);
  const header = await rpc.read(mapped, 16);
  check(Buffer.isBuffer(header) && header.length === 16 &&
    header.readUInt32LE(0) === 0x314d5453 && header.readUInt32LE(4) === P.VERSION &&
    header.readUInt32LE(8) === P.WIDTH && header.readUInt32LE(12) === P.HEIGHT,
  'MintBrew did not load the Stremio media buffer.');
  const receiver = await createReceiver({rpc: nativeRpc, mapped, directory, onProgress});
  let transport;
  try {
    transport = createTransport({rpc: nativeRpc, mapped,
      upload: request => request.packet.length <= P.WRITE_BYTES ?
        writeChunks(rpc, request.address, request.packet) : receiver.upload(request)});
  } catch (error) {
    try {await receiver.close();} catch (cleanupError) {error.cleanupError = cleanupError;}
    throw error;
  }
  let heldButton = 0, heldSince = 0, returnQueued = false, closed = false;
  const report = {mapped, bytes: P.MEMORY_BYTES, transport: 'mintbrew-shared-frame-v1',
    receiver: receiver.report};
  return {
    report,
    abortPending: () => receiver.close(),
    get publishedFrameSeq() {return transport.publishedFrameSeq;},
    publish: (bytes, ptsMs, format) => transport.publish(bytes, ptsMs, format),
    async poll() {
      check(!closed, 'MintBrew Stremio graphics are closed.');
      const state = await transport.poll();
      const held = Number(state.currentButtons) || 0;
      const button = (held & MINUS_BUTTON) ? MINUS_BUTTON : (held & B_BUTTON) ? B_BUTTON : 0;
      if (!button || button !== heldButton) {heldButton = button; heldSince = button ? now() : 0;}
      else if (!returnQueued && now() - heldSince >= HOLD_MS) {
        returnQueued = true;
        setImmediate(() => Promise.resolve().then(onReturn).catch(onFatal));
      }
      return state;
    },
    async close() {
      if (closed) return;
      closed = true;
      let failure;
      try {await receiver.close();} catch (error) {failure = error;}
      try {await transport.close();} catch (error) {failure ||= error;}
      if (failure) throw failure;
    }
  };
}

function create({rpc, menu, gpu, directory, root, config = {}, onProgress = () => {},
  onAccountProgress = () => {}, onFatal = () => {}, dependencies = {}}) {
  check(rpc && Number.isSafeInteger(menu?.controls?.mapped) &&
    path.isAbsolute(directory) && path.isAbsolute(root), 'Invalid MintBrew Stremio session.');
  check(Array.isArray(config.addonUrls || []) && Array.isArray(config.libraryItems || []) &&
    ['720p', '540p', '360p', '180p'].includes(config.quality || '720p'),
  'Invalid MintBrew Stremio configuration.');
  const makeGraphics = dependencies.createGraphics || createGraphics;
  const makeAudio = dependencies.createAudio || require('../../stremio/audio.cjs').create;
  const makePipeline = dependencies.createPipeline || require('../../stremio/pipeline.cjs').create;
  const loadPreferences = dependencies.loadPreferences || (file =>
    require('../../stremio/source-preferences.cjs').SourcePreferences.load(file));
  const checkDecoder = dependencies.checkDecoder || (() => require('../../stremio/decoder.cjs').tools());
  let graphics, audio, pipeline, starting, closing, disposing, returning, closed = false;
  let soundSequence = 0, soundTail = Promise.resolve();
  function navigationSound() {
    if (closed) return;
    const event = Buffer.alloc(8);
    event.writeUInt32LE(++soundSequence);
    event.writeUInt32LE(8, 4);
    const pending = soundTail.then(() => rpc.write(menu.controls.mapped + 976, event));
    soundTail = pending.catch(() => {});
    return pending;
  }
  let fatalQueued = false;
  const report = {id: 'stremio', started: new Date().toISOString(),
    session: rpc.a?.session, status: 'prepared'};
  const fail = error => {
    if (closed || fatalQueued) return;
    fatalQueued = true;
    report.error = error.message;
    setImmediate(() => {returnToMenu().catch(onFatal);});
    onFatal(error);
  };
  async function dispose() {
    if (disposing) return disposing;
    disposing = (async () => {
      let failure;
      const abortTask = Promise.resolve().then(() => graphics?.abortPending?.());
      abortTask.catch(() => {});
      try {await pipeline?.close();} catch (error) {failure ||= error;}
      await soundTail;
      try {await audio?.close();} catch (error) {failure ||= error;}
      try {await graphics?.close();} catch (error) {failure ||= error;}
      try {await abortTask;} catch (error) {failure ||= error;}
      report.status = failure || report.error ? 'failed' : 'stopped';
      if (failure) throw failure;
    })();
    return disposing;
  }
  async function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await starting?.catch(() => {});
      await dispose();
    })();
    return closing;
  }
  function returnToMenu() {
    if (returning) return returning;
    returning = (async () => {
      await close();
      const signal = Buffer.alloc(4);
      signal.writeUInt32LE(1);
      await rpc.write(menu.controls.mapped + 1016, signal);
    })();
    return returning;
  }
  return {
    report,
    async start() {
      check(!closed, 'MintBrew Stremio session is closed.');
      if (starting) return starting;
      starting = (async () => {
        report.status = 'starting';
        await checkDecoder();
        check(!closed, 'MintBrew Stremio session closed during startup.');
        graphics = await makeGraphics({rpc, gpu, directory, onProgress,
          onReturn: returnToMenu, onFatal: fail});
        check(!closed, 'MintBrew Stremio session closed during startup.');
        audio = await makeAudio({rpc, directory});
        check(!closed, 'MintBrew Stremio session closed during startup.');
        const sourcePreferences = config.sourcePreferences || await loadPreferences(
          path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb', 'stremio-last-sources.json'));
        check(!closed, 'MintBrew Stremio session closed during startup.');
        pipeline = await makePipeline({graphics, audio,onNavigation: navigationSound,
          addonUrls: config.addonUrls || [], libraryItems: config.libraryItems || [],
          sourcePreferences, directory, root, quality: config.quality || '720p',
          onProgress, onAccountProgress, onFatal: fail});
        check(!closed, 'MintBrew Stremio session closed during startup.');
        report.status = 'running';
        return report;
      })().catch(async error => {closed = true; try {await dispose();} catch (cleanupError) {
        error.cleanupBlocked = true; error.cleanupError = cleanupError.message;} report.status = 'failed'; throw error;});
      return starting;
    },
    async afterBatch() {return report;},
    close
  };
}

module.exports = {create, createGraphics, writeChunks, HOLD_MS, B_BUTTON, MINUS_BUTTON};
