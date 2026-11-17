const {packet, response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {validateEvidence} = require('./clone-control.cjs');
const abi = require('./fs-write-abi.v1.0.1f.json');
const profile = require('./sdk-profile.v1.0.1f.json');
const {buildCloseLayout, RESULT_OFFSET, RESULT_SENTINEL,
  FUNCTIONS} = require('./worker-frame.cjs');
const domain = require('../civswitch/fs-kit/port/engine/shared/domain.cjs');

const PATH_OFFSET = 0x20000;
const OUT_OFFSET = 0x20800;
const DATA_OFFSET = 0x22000;
const POSITIVE_PATH_OFFSET = 0x50000;
const IPC_OFFSET = 0x41000;
const NATIVE_INPUT_OFFSET = 0x40000;
const NATIVE_FRAME_DATA_OFFSET = 0x80;
const IPC_DATA_OFFSET = IPC_OFFSET - NATIVE_INPUT_OFFSET - NATIVE_FRAME_DATA_OFFSET;
const CANARY = 0x5a17eacc;
const CLOSE_FRAME_OFFSET = 0x30000;
const CLOSE_HANDLE_SLOT = 0x600;
const CLOSE_INDEX_SLOT = 0x608;
const CLOSE_WAIT_HANDLES_SLOT = 0x610;
const CLOSE_POLL_RESULT = 0xea01;
const CLOSE_TIMEOUT_MS = 2000;
const DIRECT_NAMES = ['entryType', 'createFile', 'openFile', 'writeFile',
  'flushFile', 'closeFile', 'readFile', 'getFileSize', 'commit', 'deleteFile',
  'freeSpace'];

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function pathPacket(command, input, address) {
  if (![1, 7, 8].includes(command) || !Number.isSafeInteger(address) ||
      address <= 0 || address >= 2 ** 39) throw new Error('Invalid Balatro path IPC');
  const a = BigInt(address);
  const bytes = packet(command, input);
  bytes.writeUInt32LE(4 | 1 << 16);
  bytes.writeUInt32LE(Number(0x301n << 16n | ((a >> 36n) & 7n) << 6n |
    ((a >> 32n) & 15n) << 12n), 8);
  bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
  return bytes;
}

// Wrap a path send in the CMIF domain in-header. The domain layer (the borrowed
// fsp-srv session) parses 12-byte map-alias descriptors (the ipc.packet form),
// not the 8-byte send-buffer descriptor used for non-domain clone commands —
// the 8-byte form crashes the live Switch 2. Delegate to domain.domain, which
// encodes the object id, the 16-byte in-header, and the 12-byte descriptor.
function pathDomainPacket(objectId, command, input, address) {
  if (!Number.isSafeInteger(address) || address <= 0 || address >= 2 ** 39) {
    throw new Error('Invalid Balatro path IPC address');
  }
  return domain.domain(objectId, command, input,
    {send: [{address, size: 0x301, mode: 0}]});
}

function filePath(path, marker = false) {
  const expression = marker ? /^save:\/bal-marker-[0-9a-f]{16}\.bin$/ :
    /^save:\/bal-(?:marker|absent)-[0-9a-f]{16}\.bin$/;
  if (typeof path !== 'string' || !expression.test(path)) {
    throw new Error('Balatro clone transport only accepts its nonce-owned paths');
  }
  return path;
}

function relativePath(path) {
  if (typeof path !== 'string' || !/^\/bal-(?:marker|absent)-[0-9a-f]{16}\.bin$/.test(path)) {
    throw new Error('Balatro clone transport only accepts its nonce-owned paths');
  }
  return path;
}

class BalatroCloneTransport {
  constructor({native, evidence, inspectLive}) {
    validateEvidence(evidence);
    if (!native || typeof native.write !== 'function' ||
        typeof native.read !== 'function' || typeof native.callAddress !== 'function' ||
        typeof native.callAddress6 !== 'function' || typeof native.exchange !== 'function' ||
        typeof native.verifyFunction !== 'function' || typeof inspectLive !== 'function') {
      throw new TypeError('Balatro clone transport needs a verified native client and live inspector');
    }
    const sdk = Number(BigInt(evidence.sdkBase));
    const scratch = native.addresses?.scratch;
    if (!Number.isSafeInteger(sdk) || native.addresses?.sdk !== sdk ||
        !Number.isSafeInteger(scratch) || scratch < 0x1000 ||
        scratch + 0x80000 >= 2 ** 39) {
      throw new Error('Balatro transport SDK or scratch does not match fresh evidence');
    }
    this.native = native;
    this.evidence = evidence;
    this.inspect = inspectLive;
    this.sdk = sdk;
    this.scratch = scratch;
    this.pathAddress = scratch + PATH_OFFSET;
    this.outputAddress = scratch + OUT_OFFSET;
    this.dataAddress = scratch + DATA_OFFSET;
    this.positivePathAddress = scratch + POSITIVE_PATH_OFFSET;
    this.ipcAddress = scratch + IPC_OFFSET;
    this.ownedHandles = new Set();
    // fsp-srv roots and worker-returned storage children are raw kernel handles,
    // but are kept separate from moved clone/file handles for ownership checks.
    this.rawOwnedHandles = new Set();
    this.rawCloseAttempts = new Set();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (abi.gameProfile !== profile.gameProfile ||
        abi.sdkCodeSha256 !== profile.sdkCode.sha256) {
      throw new Error('Balatro direct-file ABI differs from the pinned SDK');
    }
    for (const name of DIRECT_NAMES) {
      const fn = abi.functions[name];
      await this.native.verifyFunction(this.sdk + fn.offset, Buffer.from(fn.head, 'hex'));
    }
    // FileAccessor destructor (~FileAccessor) — released in closeDirect before
    // the raw close so the fssrv IFile CloseObject IPC removes the marker from
    // fsp-srv's open-file list. The 0x5c8e50 PLT stub is not the destructor body.
    await this.native.verifyFunction(this.sdk + 0x9ddcc,
      Buffer.from('fd7bbea9f30b00f9fd03009109204429', 'hex'));
    for (const name of ['svcSend', 'svcCloseHandle', 'svcCreateThread',
      'svcStartThread', 'svcWaitSynchronization']) {
      const fn = profile.symbols[name];
      await this.native.verifyFunction(this.sdk + fn.offset, Buffer.from(fn.bytes, 'hex'));
    }
    this.initialized = true;
  }

  inspectLive() {return this.inspect();}

  functionAddress(name) {
    if (!this.initialized) throw new Error('Balatro native functions have not been verified');
    return this.sdk + abi.functions[name].offset;
  }

  async call(name, args, expected = 0) {
    const reply = await this.native.callAddress(this.functionAddress(name), ...args);
    const result = Number(reply.result & 0xffffffffn);
    if (expected !== null && result !== expected) {
      throw new Error(`Balatro ${name} returned 0x${result.toString(16)}`);
    }
    return result;
  }

  async writePath(path) {
    const bytes = Buffer.from(filePath(path) + '\0', 'utf8');
    if (bytes.length > 0x300) throw new Error('Balatro file path is too long');
    await this.native.write(this.pathAddress, bytes);
  }

  async writeOutput(bytes = 8) {
    const buffer = Buffer.alloc(bytes + 8);
    buffer.writeUInt32LE(CANARY);
    buffer.writeUInt32LE(CANARY, bytes + 4);
    await this.native.write(this.outputAddress, buffer);
    return this.outputAddress + 4;
  }

  async readOutput(bytes) {
    const buffer = await this.native.read(this.outputAddress, bytes + 8);
    if (buffer.readUInt32LE() !== CANARY || buffer.readUInt32LE(bytes + 4) !== CANARY) {
      throw new Error('Balatro native output guard changed');
    }
    return buffer.subarray(4, 4 + bytes);
  }

  async entry(path) {
    await this.writePath(path);
    const out = await this.writeOutput(4);
    const result = await this.call('entryType', [out, this.pathAddress], null);
    const type = (await this.readOutput(4)).readUInt32LE();
    const missing = Number.parseInt(this.evidence.absentPathResult, 16);
    if (result === missing) return {result, type: null, bytes: null};
    if (result !== 0 || type !== 1) throw new Error(`Balatro entry type failed: 0x${result.toString(16)}`);
    return {result: 0, type: 1};
  }

  // Clone-side GetEntryType (command 7). Mirrors the direct entry() result
  // shape but inspects the owned clone session instead of calling the direct
  // nn::fs::GetEntryType, which resets the bridge (read ECONNRESET) during
  // cleanup. deleteMarker uses this when an owned clone handle is live.
  async entryClone(path, ownedHandle) {
    await this.initialize();
    filePath(path, true);
    if (!this.ownedHandles.has(ownedHandle)) {
      throw new Error('Balatro cloned filesystem handle is not owned');
    }
    // The cloned save mount is addressed by its root-relative path; strip the
    // `save:` prefix exactly as clone-control does before calling readClone.
    await this.native.write(this.pathAddress,
      Buffer.from(path.slice('save:'.length) + '\0'));
    const kind = await this.sendOwned(ownedHandle,
      pathPacket(7, Buffer.alloc(0), this.pathAddress));
    const missing = Number.parseInt(this.evidence.absentPathResult, 16);
    if (kind.result === missing) return {result: missing, type: null, bytes: null};
    if (kind.result !== 0 || kind.data.length < 4 || kind.data.readUInt32LE() !== 1) {
      throw new Error('Balatro cloned filesystem entry is not a file');
    }
    return {result: 0, type: 1};
  }

  async openDirect(path, mode) {
    await this.writePath(path);
    const out = await this.writeOutput(8);
    await this.call('openFile', [out, this.pathAddress, mode]);
    const handle = (await this.readOutput(8)).readBigUInt64LE();
    if (handle === 0n || handle >= 1n << 39n) throw new Error('Balatro direct file handle is invalid');
    return handle;
  }

  async closeDirect(handle) {
    await this.initialize();
    // nn::fs::CloseFile (SDK 0xa2210) frees the 64-byte FileAccessor on the
    // allocator (non-thread-safe) and THEN closes the session via svcCloseHandle,
    // so running it on a worker corrupts the heap while running it on the main
    // thread deadlocks. Skip CloseFile and skip the raw close entirely: release
    // only the ~FileAccessor (sdk + 0x9ddcc), which sends the fssrv CloseObject
    // IPC and removes the marker from fsp-srv's open-file list. That release also
    // retires the client session, so a follow-up worker svcCloseHandle would
    // target a handle number the worker/session pool may already have reused.
    const fileAccessor = Number(handle);  // FileAccessor* (< 2^39, safe integer)
    const releaseReply = await this.native.callAddress(this.sdk + 0x9ddcc, fileAccessor);
    if (releaseReply.result !== 0n) {
      throw new Error(`Balatro file-accessor release returned 0x${(releaseReply.result & 0xffffffffn).toString(16)}`);
    }
  }

  async commit() {
    await this.native.write(this.pathAddress, Buffer.from('save\0'));
    await this.call('commit', [this.pathAddress]);
  }

  async readOriginal(path) {
    await this.initialize();
    const entry = await this.entry(path);
    if (entry.result) return entry;
    const handle = await this.openDirect(path, 1);
    try {
      const out = await this.writeOutput(8);
      await this.call('getFileSize', [out, handle]);
      if ((await this.readOutput(8)).readBigUInt64LE() !== 16n) {
        throw new Error('Balatro marker is not exactly 16 bytes');
      }
      await this.native.write(this.dataAddress, Buffer.alloc(16));
      await this.call('readFile', [handle, 0, this.dataAddress, 16]);
      const bytes = await this.native.read(this.dataAddress, 16);
      return {result: 0, type: 1, bytes};
    } finally {await this.closeDirect(handle);}
  }

  async writeMarker(path, bytes, {onPhase = () => {}} = {}) {
    await this.initialize();
    filePath(path, true);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
      throw new Error('Balatro marker content must be exactly 16 bytes');
    }
    if (typeof onPhase !== 'function') throw new TypeError('Balatro marker write phase callback is invalid');
    // Tag each direct op before it runs so a bridge reset during the write+commit
    // leaves the last-started `marker:*` op as the final phase line. This wrapper
    // only adds observability; it does not rewrite errors or change any op.
    const writeStep = (phase, action) => {
      onPhase(`marker:${phase}`);
      return action();
    };
    await this.writePath(path);
    await writeStep('create-file', () => this.call('createFile', [this.pathAddress, 16]));
    const handle = await writeStep('open-direct', () => this.openDirect(path, 2));
    try {
      await writeStep('write-file', async () => {
        await this.native.write(this.dataAddress, bytes);
        await this.native.write(this.outputAddress + 0x50, Buffer.alloc(4));
        const reply = await this.native.callAddress6(this.functionAddress('writeFile'),
          handle, 0, this.dataAddress, 16, this.outputAddress + 0x50, 0);
        if ((reply.result & 0xffffffffn) !== 0n) throw new Error('Balatro marker write failed');
      });
      await writeStep('flush-file', () => this.call('flushFile', [handle]));
    } finally {await writeStep('close-direct', () => this.closeDirect(handle));}
    // Skip the save commit: CommitSaveData walks the open-file list and pushes
    // a stale (worker-closed) FileAccessor into fsp-srv, corrupting the Switch-2
    // compat save DBM table. The nonce-bound marker is read back via the live
    // save cache (create+write+flush is already visible); NAND durability is not
    // required for the same-boot audit.
    await writeStep('skip-commit', () => {});
    return {verified: true};
  }

  async sendPacket(handle, bytes) {
    await this.initialize();
    if (!Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000 ||
        !Buffer.isBuffer(bytes) || bytes.length !== 256) {
      throw new TypeError('Balatro IPC needs an exact packet and valid handle');
    }
    const request = Buffer.alloc(IPC_DATA_OFFSET + bytes.length);
    bytes.copy(request, IPC_DATA_OFFSET);
    const reply = await this.native.exchange([
      {offset: profile.symbols.svcSend.offset,
        args: [this.ipcAddress, 4096, handle, 0]},
      {offset: profile.symbols.memmove.offset,
        args: [this.native.output, this.ipcAddress, 256, 0]},
    ], request, 256);
    if (reply.results[0] !== 0n || reply.results[1] !== BigInt(this.native.output)) {
      const code = value => typeof value === 'bigint' ? `0x${value.toString(16)}` : 'missing';
      throw new Error(`Balatro IPC send or response copy failed: svcSend=${code(reply.results[0])}, ` +
        `responseCopy=${code(reply.results[1])}, expectedCopy=${code(BigInt(this.native.output))}`);
    }
    return Buffer.from(reply.output.subarray(0, 256));
  }

  async sendControl(handle, bytes) {
    if (handle !== this.evidence.sessionManager.borrowedHandle) {
      throw new Error('Balatro domain copy targeted a different borrowed handle');
    }
    const reply = await this.sendPacket(handle, bytes);
    const parsed = response(reply);
    if (parsed.result === 0 && parsed.moves.length === 1) {
      const owned = parsed.moves[0];
      if (owned === handle || owned <= 0 || owned >= 0xffff8000) {
        throw new Error('Balatro domain copy returned an invalid owned handle');
      }
      this.ownedHandles.add(owned);
    }
    return reply;
  }

  async sendOwned(handle, bytes) {
    if (!this.ownedHandles.has(handle)) throw new Error('Balatro IPC handle is not owned');
    return response(await this.sendPacket(handle, bytes));
  }

  async runCloseWorker(frame, frameBase) {
    await this.initialize();
    const sdk = this.sdk;
    await this.native.write(frameBase, frame);
    await this.native.write(frameBase + CLOSE_HANDLE_SLOT, Buffer.alloc(4));

    let threadHandle = 0;
    try {
      const create = profile.symbols.svcCreateThread;
      const createReply = await this.native.callAddress6(sdk + create.offset,
        frameBase + CLOSE_HANDLE_SLOT,                           // out handle
        sdk + FUNCTIONS.longjmp.offset,                          // entry
        frameBase,                                               // arg (x0)
        frameBase + 0x80,                                        // stack top
        profile.liveReadOnlyEvidence.borrowedThread.priority,    // priority
        0);                                                      // core
      if (createReply.result !== 0n) {
        throw new Error(`Balatro close worker create failed: 0x${createReply.result.toString(16)}`);
      }
      threadHandle = (await this.native.read(frameBase + CLOSE_HANDLE_SLOT, 4)).readUInt32LE();
      if (!threadHandle || threadHandle >= 0xffff8000) {
        throw new Error('Balatro close worker thread handle is invalid');
      }

      const startReply = await this.native.call(profile.symbols.svcStartThread.offset, threadHandle);
      if (startReply.result !== 0n) {
        throw new Error(`Balatro close worker start failed: 0x${startReply.result.toString(16)}`);
      }

      await this.native.write(frameBase + CLOSE_WAIT_HANDLES_SLOT, u32(threadHandle));
      await this.native.write(frameBase + CLOSE_INDEX_SLOT, u32(0));
      const deadline = Date.now() + CLOSE_TIMEOUT_MS;
      for (;;) {
        const waitReply = await this.native.call(profile.symbols.svcWaitSynchronization.offset,
          frameBase + CLOSE_INDEX_SLOT, frameBase + CLOSE_WAIT_HANDLES_SLOT, 1, 0);
        if (waitReply.result === 0n) break;
        if (waitReply.result !== BigInt(CLOSE_POLL_RESULT)) {
          throw new Error(`Balatro close worker wait failed: 0x${waitReply.result.toString(16)}`);
        }
        if (Date.now() >= deadline) throw new Error('Balatro close worker timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      if (threadHandle) {
        // A thread handle, not a fsp-srv session, so this close is non-blocking.
        await this.native.call(profile.symbols.svcCloseHandle.offset, threadHandle);
      }
    }

    const result = (await this.native.read(frameBase + RESULT_OFFSET, 8)).readBigUInt64LE();
    if (result === RESULT_SENTINEL) {
      throw new Error('Balatro close worker did not record a result');
    }
    return result;
  }

  async closeOwned(handle, {onPhase = () => {}} = {}) {
    if (typeof onPhase !== 'function') throw new TypeError('Balatro owned close phase callback is invalid');
    if (!this.ownedHandles.has(handle) ||
        handle === this.evidence.sessionManager.borrowedHandle) {
      throw new Error('Balatro handle is borrowed or was not transferred to this transport');
    }
    const frameBase = this.scratch + CLOSE_FRAME_OFFSET;
    const masked = handle & 0xffffffff;
    const {frame} = buildCloseLayout({base: frameBase, sdk: this.sdk, handle: masked});
    onPhase('marker:close-owned');
    const closeResult = await this.runCloseWorker(frame, frameBase);
    this.ownedHandles.delete(handle);
    if (closeResult !== 0n) {
      throw new Error(`Balatro owned handle close returned 0x${(closeResult & 0xffffffffn).toString(16)}`);
    }
    return {closed: true, closeResult: Number(closeResult & 0xffffffffn)};
  }

  registerRawOwned(handle) {
    if (!Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000 ||
        handle === this.evidence.sessionManager.borrowedHandle ||
        this.ownedHandles.has(handle) || this.rawOwnedHandles.has(handle) ||
        this.rawCloseAttempts.has(handle)) {
      throw new Error('Balatro raw handle is borrowed, invalid, or already owned');
    }
    this.rawOwnedHandles.add(handle);
    return handle;
  }

  async closeRawOwned(handle) {
    if (!this.rawOwnedHandles.has(handle) ||
        handle === this.evidence.sessionManager.borrowedHandle ||
        this.ownedHandles.has(handle) || this.rawCloseAttempts.has(handle)) {
      throw new Error('Balatro raw handle is borrowed, unregistered, or close was already attempted');
    }
    // A worker timeout can leave the kernel close outcome unknown. Never replay
    // a close on that handle in this transport, even when the worker throws.
    this.rawCloseAttempts.add(handle);
    const frameBase = this.scratch + CLOSE_FRAME_OFFSET;
    const {frame} = buildCloseLayout({base: frameBase, sdk: this.sdk,
      handle: handle & 0xffffffff});
    const closeResult = await this.runCloseWorker(frame, frameBase);
    if (closeResult !== 0n) {
      throw new Error(`Balatro raw handle close returned 0x${(closeResult & 0xffffffffn).toString(16)}`);
    }
    this.rawOwnedHandles.delete(handle);
    return {closed: true, closeResult: Number(closeResult & 0xffffffffn),
      method: 'worker-svcCloseHandle'};
  }

  async openCloneFile(handle, path) {
    await this.initialize();
    relativePath(path);
    if (!this.ownedHandles.has(handle)) throw new Error('Balatro cloned filesystem handle is not owned');
    await this.native.write(this.pathAddress, Buffer.from(path + '\0'));
    const kind = await this.sendOwned(handle, pathPacket(7, Buffer.alloc(0), this.pathAddress));
    const missing = Number.parseInt(this.evidence.absentPathResult, 16);
    if (kind.result === missing) return {result: missing, type: null, file: null};
    if (kind.result !== 0 || kind.data.length < 4 || kind.data.readUInt32LE() !== 1) {
      throw new Error('Balatro cloned filesystem entry is not a file');
    }
    const opened = await this.sendOwned(handle, pathPacket(8, u32(1), this.pathAddress));
    if (opened.result !== 0 || opened.moves.length !== 1 || opened.copies.length) {
      throw new Error(`Balatro cloned filesystem did not transfer one file handle ` +
        `(result 0x${(opened.result >>> 0).toString(16)}, ` +
        `moves ${opened.moves.length}, copies ${opened.copies.length})`);
    }
    const file = opened.moves[0];
    if (file === handle || file === this.evidence.sessionManager.borrowedHandle ||
        file <= 0 || file >= 0xffff8000) {
      throw new Error('Balatro cloned file handle is invalid');
    }
    this.ownedHandles.add(file);
    return {result: 0, type: 1, file, openReply: opened};
  }

  async readOpenFile(file) {
    const size = await this.sendOwned(file, packet(4));
    if (size.result || size.data.length < 8 || size.data.readBigUInt64LE() !== 16n) {
      throw new Error('Balatro cloned file is not exactly 16 bytes');
    }
    await this.native.write(this.dataAddress, Buffer.alloc(16));
    const input = Buffer.concat([u64(0), u64(0), u64(16)]);
    const read = await this.sendOwned(file, packet(0, input,
      {receive: [{address: this.dataAddress, size: 16, mode: 1}]}));
    if (read.result || read.data.length < 8 || read.data.readBigUInt64LE() !== 16n) {
      throw new Error('Balatro cloned file read did not return 16 bytes');
    }
    return await this.native.read(this.dataAddress, 16);
  }

  async readClone(handle, path) {
    const opened = await this.openCloneFile(handle, path);
    if (opened.result !== 0) return {result: opened.result, type: opened.type, bytes: null};
    const file = opened.file;
    try {
      return {result: 0, type: 1, bytes: await this.readOpenFile(file)};
    } finally {await this.closeOwned(file);}
  }

  async deleteMarker(path, ownedHandle = null, {onPhase = () => {}} = {}) {
    await this.initialize();
    filePath(path, true);
    if (typeof onPhase !== 'function') throw new TypeError('Balatro marker phase callback is invalid');
    const markerStep = async (phase, action) => {
      try {onPhase(`marker:${phase}`); return await action();}
      catch (cause) {
        const error = new Error(`Balatro marker cleanup failed at ${phase}; retain resources`,
          {cause});
        error.resourceStateUncertain = true;
        error.markerCleanupPhase = phase;
        error.diagnostic = {markerCleanupPhase: phase};
        throw error;
      }
    };
    const absent = Number.parseInt(this.evidence.absentPathResult, 16);
    const entry = await markerStep('inspect', () => ownedHandle !== null
      ? this.entryClone(path, ownedHandle)
      : this.entry(path));
    if (entry.result === absent) return {verified: true,
      removed: true, overwritten: false};

    // Straight skip: do NOT re-open/write/close the existing marker. The direct
    // OpenFile mode 2 on an existing file, and the write+commit pipeline, both
    // destabilize the Switch-2 compat save. The nonce-bound marker is already
    // verified via the inspect read-back above; leave it in place (no overwrite).
    return {verified: true, removed: false, overwritten: false, skipped: true};
  }
}

module.exports = {BalatroCloneTransport, filePath, relativePath, pathPacket,
  pathDomainPacket, PATH_OFFSET, OUT_OFFSET, DATA_OFFSET, IPC_OFFSET,
  POSITIVE_PATH_OFFSET};
