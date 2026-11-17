const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {qualifyLive} = require('./qualify-live.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');

const MARKER = 'BAL_MARKER_PATH_V1';
const CLEANUP_MARKER = 'BAL_MARKER_CLEANUP_V1';
const INSPECT_MARKER = 'BAL_MARKER_INSPECT_V1';
const PINNED = ['entryType', 'createFile', 'commit', 'deleteFile'];
const PORT = 9026;
const TIMEOUT_MS = 30000;

function paths(nonce) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid nonce');
  const marker = `save:/bal-marker-${nonce}.bin`;
  const absent = `save:/bal-absent-${nonce}.bin`;
  if (Buffer.byteLength(marker) !== Buffer.byteLength(absent)) {
    throw new Error('Balatro path controls have different lengths');
  }
  return {marker, absent};
}

function luaBytes(hex) {
  return '"' + [...Buffer.from(hex, 'hex')].map(byte =>
    '\\' + String(byte).padStart(3, '0')).join('') + '"';
}

function pinnedChecks(names) {
  if (profile.runtimeVersion !== '1.0.1f-FULL' ||
      profile.gameProfile !== abi.gameProfile ||
      profile.sdkCode.sha256 !== abi.sdkCodeSha256 ||
      live.identity.runtimeVersion !== profile.runtimeVersion) {
    throw new Error('Balatro marker profile mismatch');
  }
  return names.map(name => {
    const item = abi.functions[name];
    if (!item || !Number.isSafeInteger(item.offset) ||
        !/^[0-9a-f]{16,32}$/.test(item.head)) {
      throw new Error('missing pinned symbol: ' + name);
    }
    return `{${item.offset},${luaBytes(item.head)},${JSON.stringify(name)}}`;
  }).join(',');
}

function validateContext({nonce, absentResult}) {
  const ownedPaths = paths(nonce);
  if (!/^0x[0-9a-f]{8}$/.test(absentResult || '') || absentResult === '0x00000000') {
    throw new TypeError('exact missing-path Result is required');
  }
  return ownedPaths;
}

function makeSource({nonce, absentResult}) {
  const {marker, absent} = validateContext({nonce, absentResult});
  const checks = pinnedChecks(PINNED);
  const a = abi.functions;
  const source = [
    'local b=BL',
    'local info=b and b.info',
    `local nonce=${JSON.stringify(nonce)}`,
    `local markerPath=${JSON.stringify(marker)}`,
    `local absentPath=${JSON.stringify(absent)}`,
    `local expected=${Number.parseInt(absentResult, 16)}`,
    `local tag=${JSON.stringify(MARKER)}`,
    "local function reply(status,detail,cleanup) return table.concat({tag,status,nonce,detail,cleanup},'|') end",
    "if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return reply('fail','identity','not-created') end",
    `if type(info.sdk_base)~='number' or info.sdk_base<4096 or info.sdk_base%4096~=0 or info.sdk_base+${profile.sdkCode.size}>=2^39 then return reply('fail','sdk-base-range','not-created') end`,
    "if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return reply('fail','native-bridge','not-created') end",
    "local ffi=require('ffi')",
    'local base=info.sdk_base',
    `for _,item in ipairs({${checks}}) do if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return reply('fail','code-'..item[3],'not-created') end end`,
    `local entry=love.ffi.declare('uint32_t',{'void *','const char *'},base+${a.entryType.offset})`,
    `local create=love.ffi.declare('uint32_t',{'const char *','int64_t'},base+${a.createFile.offset})`,
    `local commit=love.ffi.declare('uint32_t',{'const char *'},base+${a.commit.offset})`,
    `local remove=love.ffi.declare('uint32_t',{'const char *'},base+${a.deleteFile.offset})`,
    "local marker=ffi.new('char[?]',#markerPath+1,markerPath)",
    "local absent=ffi.new('char[?]',#absentPath+1,absentPath)",
    "local mount=ffi.new('char[5]','save')",
    "local function kind(path) local out=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc);local called,rc=pcall(entry,ffi.cast('uint32_t*',out)+1,path);if not called then return nil,nil end;if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return nil,nil end;return tonumber(rc),tonumber(out[1]) end",
    "local function call(fn,...) local called,rc=pcall(fn,...);return called and tonumber(rc)==0 end",
    'local created=false',
    "local function cleanup() if not created then return 'not-created' end;local rc,tp=kind(marker);if rc==expected then return 'verified' end;if rc~=0 or tp~=1 then return 'retained' end;if not call(remove,marker) then return 'retained' end;if not call(commit,mount) then return 'retained' end;rc=kind(marker);if rc~=expected then return 'retained' end;created=false;return 'verified' end",
    "local function fail(why) return reply('fail',why,cleanup()) end",
    "local mr=kind(marker);local ar=kind(absent)",
    "if mr~=expected or ar~=expected then return reply('fail','path-preflight','not-created') end",
    'created=true',
    "if not call(create,marker,16) then return fail('create') end",
    "if not call(commit,mount) then return fail('create-commit') end",
    "local present,tp=kind(marker);if present~=0 or tp~=1 then return fail('marker-not-file') end",
    "ar=kind(absent);if ar~=expected then return fail('absent-path') end",
    "local clean=cleanup();if clean~='verified' then return reply('fail','cleanup','retained') end",
    "mr=kind(marker);ar=kind(absent)",
    "if mr~=expected or ar~=expected then return reply('fail','post-cleanup-path','retained') end",
    "return reply('ok','direct-path-controls','verified')",
  ].join('\n');
  if (Buffer.byteLength(source, 'utf8') > 32768) {
    throw new RangeError('Balatro marker path source exceeds REPL limit');
  }
  return source;
}

function makeCleanupSource({nonce, absentResult}) {
  const {marker, absent} = validateContext({nonce, absentResult});
  const checks = pinnedChecks(['entryType', 'openFile', 'getFileSize', 'readFile', 'closeFile',
    'deleteFile', 'commit']);
  const wanted = Buffer.concat([Buffer.from('BALFSv01'),
    Buffer.from(nonce, 'hex')]);
  const a = abi.functions;
  const source = [
    'local b=BL',
    'local info=b and b.info',
    `local nonce=${JSON.stringify(nonce)}`,
    `local markerPath=${JSON.stringify(marker)}`,
    `local absentPath=${JSON.stringify(absent)}`,
    `local wanted=${luaBytes(wanted.toString('hex'))}`,
    `local expected=${Number.parseInt(absentResult, 16)}`,
    `local tag=${JSON.stringify(CLEANUP_MARKER)}`,
    "local function reply(status,detail,cleanup) return table.concat({tag,status,nonce,detail,cleanup},'|') end",
    "if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return reply('fail','identity','retained') end",
    `if type(info.sdk_base)~='number' or info.sdk_base<4096 or info.sdk_base%4096~=0 or info.sdk_base+${profile.sdkCode.size}>=2^39 then return reply('fail','sdk-base-range','retained') end`,
    "if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return reply('fail','native-bridge','retained') end",
    "local ffi=require('ffi')",
    'local base=info.sdk_base',
    `for _,item in ipairs({${checks}}) do if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return reply('fail','code-'..item[3],'retained') end end`,
    `local entry=love.ffi.declare('uint32_t',{'void *','const char *'},base+${a.entryType.offset})`,
    `local open=love.ffi.declare('uint32_t',{'void *','const char *','int'},base+${a.openFile.offset})`,
    `local getSize=love.ffi.declare('uint32_t',{'void *','uint64_t'},base+${a.getFileSize.offset})`,
    `local readFile=love.ffi.declare('uint32_t',{'uint64_t','int64_t','void *','uint64_t'},base+${a.readFile.offset})`,
    `local close=love.ffi.declare('void',{'uint64_t'},base+${a.closeFile.offset})`,
    `local remove=love.ffi.declare('uint32_t',{'const char *'},base+${a.deleteFile.offset})`,
    `local commit=love.ffi.declare('uint32_t',{'const char *'},base+${a.commit.offset})`,
    "local marker=ffi.new('char[?]',#markerPath+1,markerPath)",
    "local absent=ffi.new('char[?]',#absentPath+1,absentPath)",
    "local mount=ffi.new('char[5]','save')",
    "local function kind(path) local out=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc);local called,rc=pcall(entry,ffi.cast('uint32_t*',out)+1,path);if not called then return nil,nil end;if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return nil,nil end;return tonumber(rc),tonumber(out[1]) end",
    "local ar=kind(absent);if ar~=expected then return reply('fail','absent-path','retained') end",
    "local mr=kind(marker);if mr==expected then return reply('ok','already-absent','verified') end",
    "if mr~=0 then return reply('fail','marker-entry','retained') end",
    "local out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "local called,rc=pcall(open,ffi.cast('uint64_t*',out)+1,marker,1)",
    "if not called or tonumber(rc)~=0 or tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc or tonumber(out[1])==0 then return reply('fail','open-or-handle','retained') end",
    "local h=out[1];local size=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "called,rc=pcall(getSize,ffi.cast('uint64_t*',size)+1,h)",
    "if not called or tonumber(rc)~=0 then pcall(close,h);return reply('fail','size-call','retained') end",
    "local exact=tonumber(size[0])==0x5a17eacc and tonumber(size[2])==0x5a17eacc and tonumber(size[1])==#wanted",
    "local bytes=ffi.new('uint8_t[16]');if exact then called,rc=pcall(readFile,h,0,bytes,16);exact=called and tonumber(rc)==0 and ffi.string(bytes,16)==wanted end",
    "called=pcall(close,h);if not called then return reply('fail','close','retained') end",
    "if not exact then return reply('fail','marker-content','retained') end",
    "called,rc=pcall(remove,marker);if not called or tonumber(rc)~=0 then return reply('fail','delete','retained') end",
    "called,rc=pcall(commit,mount);if not called or tonumber(rc)~=0 then return reply('fail','delete-commit','retained') end",
    "mr=kind(marker);ar=kind(absent)",
    "if mr~=expected or ar~=expected then return reply('fail','post-cleanup-path','retained') end",
    "return reply('ok','removed-owned-marker','verified')",
  ].join('\n');
  if (Buffer.byteLength(source, 'utf8') > 32768) {
    throw new RangeError('Balatro marker cleanup source exceeds REPL limit');
  }
  return source;
}

function makeInspectSource({nonce}) {
  const {marker, absent} = paths(nonce);
  const checks = pinnedChecks(['entryType', 'openFile', 'getFileSize', 'closeFile']);
  const a = abi.functions;
  const source = [
    'local b=BL',
    'local info=b and b.info',
    `local nonce=${JSON.stringify(nonce)}`,
    `local markerPath=${JSON.stringify(marker)}`,
    `local absentPath=${JSON.stringify(absent)}`,
    `local tag=${JSON.stringify(INSPECT_MARKER)}`,
    "local function reply(status,detail) return table.concat({tag,status,nonce,detail},'|') end",
    "if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return reply('fail','identity') end",
    `if type(info.sdk_base)~='number' or info.sdk_base<4096 or info.sdk_base%4096~=0 or info.sdk_base+${profile.sdkCode.size}>=2^39 then return reply('fail','sdk-base-range') end`,
    "if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return reply('fail','native-bridge') end",
    "local ffi=require('ffi')",
    'local base=info.sdk_base',
    `for _,item in ipairs({${checks}}) do if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return reply('fail','code-'..item[3]) end end`,
    `local entry=love.ffi.declare('uint32_t',{'void *','const char *'},base+${a.entryType.offset})`,
    `local open=love.ffi.declare('uint32_t',{'void *','const char *','int'},base+${a.openFile.offset})`,
    `local getSize=love.ffi.declare('uint32_t',{'void *','uint64_t'},base+${a.getFileSize.offset})`,
    `local close=love.ffi.declare('void',{'uint64_t'},base+${a.closeFile.offset})`,
    "local marker=ffi.new('char[?]',#markerPath+1,markerPath)",
    "local absent=ffi.new('char[?]',#absentPath+1,absentPath)",
    "local function kind(path) local out=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc);local called,rc=pcall(entry,ffi.cast('uint32_t*',out)+1,path);if not called or tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return nil,nil end;return tonumber(rc),tonumber(out[1]) end",
    "local mr,tp=kind(marker);local ar=kind(absent)",
    "if not mr or not ar then return reply('fail','entry-or-guard') end",
    "local typ=mr==0 and tostring(tp) or 'na'",
    "local openRc='na';local fileSize='na'",
    "local out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "local called,rc=pcall(open,ffi.cast('uint64_t*',out)+1,marker,1)",
    "if called then openRc=string.format('%08x',tonumber(rc)) else openRc='call' end",
    "if called and tonumber(rc)==0 then",
    "if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc or tonumber(out[1])==0 then return reply('fail','handle-guard') end",
    "local h=out[1];local size=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "called,rc=pcall(getSize,ffi.cast('uint64_t*',size)+1,h)",
    "if called and tonumber(rc)==0 and tonumber(size[0])==0x5a17eacc and tonumber(size[2])==0x5a17eacc then fileSize=tostring(tonumber(size[1])) end",
    "if not pcall(close,h) then return reply('fail','close') end",
    'end',
    "return reply('ok',table.concat({string.format('%08x',mr),typ,openRc,fileSize,string.format('%08x',ar)},','))",
  ].join('\n');
  if (Buffer.byteLength(source, 'utf8') > 32768) {
    throw new RangeError('Balatro marker inspection source exceeds REPL limit');
  }
  return source;
}

function parseFields(reply, nonce, marker) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const prefix = `-> ${marker}|`;
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro marker path reply');
  const fields = lines[0].slice(3).split('|');
  if (fields.length !== 5 || fields[0] !== marker || fields[2] !== nonce ||
      !['verified', 'retained', 'not-created'].includes(fields[4])) {
    throw new Error('Balatro marker path reply does not match this request');
  }
  if (fields[1] === 'fail' && /^[a-z-]+$/.test(fields[3])) {
    throw new Error(`Balatro marker path control failed: ${fields[3]}; cleanup ${fields[4]}`);
  }
  return fields;
}

function parseReply(reply, {nonce}) {
  const fields = parseFields(reply, nonce, MARKER);
  if (fields[1] !== 'ok' || fields[3] !== 'direct-path-controls' ||
      fields[4] !== 'verified') throw new Error('incomplete Balatro marker path reply');
  return {markerPathVerified: true, absentPathVerified: true, cleanup: 'verified',
    markerWaveAttempted: false};
}

function parseCleanupReply(reply, {nonce}) {
  const fields = parseFields(reply, nonce, CLEANUP_MARKER);
  if (fields[1] !== 'ok' ||
      !['removed-owned-marker', 'already-absent'].includes(fields[3]) ||
      fields[4] !== 'verified') throw new Error('incomplete Balatro marker cleanup reply');
  return {cleanup: 'verified', status: fields[3]};
}

function parseInspectReply(reply, {nonce}) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const prefix = `-> ${INSPECT_MARKER}|`;
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro marker inspection');
  const fields = lines[0].slice(3).split('|');
  if (fields.length !== 4 || fields[0] !== INSPECT_MARKER || fields[2] !== nonce) {
    throw new Error('Balatro marker inspection does not match this nonce');
  }
  if (fields[1] === 'fail' && /^[a-z-]+$/.test(fields[3])) {
    throw new Error(`Balatro marker inspection failed: ${fields[3]}`);
  }
  const parts = fields[3].split(',');
  if (fields[1] !== 'ok' || parts.length !== 5 ||
      !/^[0-9a-f]{8}$/.test(parts[0]) ||
      !/^(?:\d+|na)$/.test(parts[1]) ||
      !/^(?:[0-9a-f]{8}|call|na)$/.test(parts[2]) ||
      !/^(?:\d+|na)$/.test(parts[3]) ||
      !/^[0-9a-f]{8}$/.test(parts[4])) {
    throw new Error('incomplete Balatro marker inspection');
  }
  const fileType = parts[1] === 'na' ? null : Number(parts[1]);
  const fileSize = parts[3] === 'na' ? null : Number(parts[3]);
  if ((fileType !== null && !Number.isSafeInteger(fileType)) ||
      (fileSize !== null && !Number.isSafeInteger(fileSize))) {
    throw new Error('Balatro marker inspection value is out of range');
  }
  return {entryResult: `0x${parts[0]}`, fileType,
    openResult: /^(?:na|call)$/.test(parts[2]) ? parts[2] : `0x${parts[2]}`,
    fileSize,
    absentResult: `0x${parts[4]}`};
}

function checkedPreflight(preflight) {
  if (preflight?.readonly?.gameProfile !== profile.gameProfile ||
      preflight?.service?.cleanup !== 'closed' ||
      !/^0x[0-9a-f]{8}$/.test(preflight.readonly.absentPathResult || '') ||
      preflight.readonly.absentPathResult === '0x00000000') {
    throw new Error('Balatro marker path preflight did not verify the pinned profile');
  }
  return preflight.readonly.absentPathResult;
}

async function runMarkerPathControl({host, execute = executeLua, qualify = qualifyLive,
                                     nonceBytes = crypto.randomBytes,
                                     onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (typeof execute !== 'function' || typeof qualify !== 'function' ||
      typeof nonceBytes !== 'function' || typeof onPhase !== 'function') {
    throw new TypeError('invalid Balatro marker path dependency');
  }
  const bytes = nonceBytes(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) {
    throw new TypeError('nonce must be eight bytes');
  }
  const nonce = bytes.toString('hex');
  const ownedPaths = paths(nonce);
  onPhase(`owned marker ${ownedPaths.marker}`);
  const preflight = await qualify({host, includeService: true, execute, nonceBytes, onPhase});
  const context = {nonce, absentResult: checkedPreflight(preflight)};
  onPhase('direct save path controls');
  try {
    const reply = await execute({host, port: PORT, source: makeSource(context),
      timeoutMs: TIMEOUT_MS});
    return {host, port: PORT, profile: profile.gameProfile, nonce, ...ownedPaths,
      ...parseReply(reply, context)};
  } catch (error) {
    throw new Error(`${error.message}; inspect owned path ${ownedPaths.marker}; nonce ${nonce}`);
  }
}

async function runMarkerPathCleanup({host, nonce, execute = executeLua,
                                     qualify = qualifyLive,
                                     nonceBytes = crypto.randomBytes,
                                     onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  const ownedPaths = paths(nonce);
  if (typeof execute !== 'function' || typeof qualify !== 'function' ||
      typeof nonceBytes !== 'function' || typeof onPhase !== 'function') {
    throw new TypeError('invalid Balatro marker cleanup dependency');
  }
  const preflight = await qualify({host, includeService: true, execute, nonceBytes, onPhase});
  const context = {nonce, absentResult: checkedPreflight(preflight)};
  onPhase(`recover owned marker ${ownedPaths.marker}`);
  try {
    const reply = await execute({host, port: PORT, source: makeCleanupSource(context),
      timeoutMs: TIMEOUT_MS});
    return {host, port: PORT, nonce, ...ownedPaths, ...parseCleanupReply(reply, context)};
  } catch (error) {
    throw new Error(`${error.message}; inspect owned path ${ownedPaths.marker}; nonce ${nonce}`);
  }
}

async function runMarkerPathInspect({host, nonce, execute = executeLua,
                                     onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  const ownedPaths = paths(nonce);
  if (typeof execute !== 'function' || typeof onPhase !== 'function') {
    throw new TypeError('invalid Balatro marker inspection dependency');
  }
  onPhase(`inspect owned marker ${ownedPaths.marker}`);
  const reply = await execute({host, port: PORT, source: makeInspectSource({nonce}),
    timeoutMs: TIMEOUT_MS});
  return {host, port: PORT, nonce, ...ownedPaths, ...parseInspectReply(reply, {nonce})};
}

module.exports = {MARKER, CLEANUP_MARKER, INSPECT_MARKER, PORT, TIMEOUT_MS,
  paths, makeSource, makeCleanupSource, makeInspectSource, parseReply,
  parseCleanupReply, parseInspectReply, runMarkerPathControl,
  runMarkerPathCleanup, runMarkerPathInspect};
