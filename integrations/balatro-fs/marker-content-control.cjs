const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {qualifyLive} = require('./qualify-live.cjs');
const {paths} = require('./marker-path-control.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');

const TAG = 'BAL_MARKER_CONTENT_V1';
const PORT = 9026;
const TIMEOUT_MS = 30000;
const SYMBOLS = ['entryType', 'createFile', 'openFile', 'writeFile',
  'flushFile', 'closeFile', 'readFile', 'getFileSize', 'commit', 'deleteFile'];

function content(nonce) {
  paths(nonce);
  return Buffer.concat([Buffer.from('BALFSv01'), Buffer.from(nonce, 'hex')]);
}

function luaBytes(bytes) {
  return '"' + [...bytes].map(byte => '\\' + String(byte).padStart(3, '0')).join('') + '"';
}

function checks() {
  if (profile.runtimeVersion !== '1.0.1f-FULL' ||
      profile.gameProfile !== abi.gameProfile ||
      profile.sdkCode.sha256 !== abi.sdkCodeSha256 ||
      live.identity.runtimeVersion !== profile.runtimeVersion) {
    throw new Error('Balatro content profile mismatch');
  }
  return SYMBOLS.map(name => {
    const item = abi.functions[name];
    if (!item || !Number.isSafeInteger(item.offset) ||
        !/^[0-9a-f]{16,32}$/.test(item.head)) {
      throw new Error('missing pinned symbol: ' + name);
    }
    return `{${item.offset},${luaBytes(Buffer.from(item.head, 'hex'))},${JSON.stringify(name)}}`;
  }).join(',');
}

function makeSource({nonce, absentResult}) {
  const {marker, absent} = paths(nonce);
  if (!/^0x[0-9a-f]{8}$/.test(absentResult || '') || absentResult === '0x00000000') {
    throw new TypeError('exact missing-path Result is required');
  }
  const a = abi.functions;
  const source = [
    'local b=BL',
    'local info=b and b.info',
    `local nonce=${JSON.stringify(nonce)}`,
    `local markerPath=${JSON.stringify(marker)}`,
    `local absentPath=${JSON.stringify(absent)}`,
    `local wanted=${luaBytes(content(nonce))}`,
    `local missing=${Number.parseInt(absentResult, 16)}`,
    `local tag=${JSON.stringify(TAG)}`,
    "local function reply(status,detail,cleanup) return table.concat({tag,status,nonce,detail,cleanup},'|') end",
    "if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return reply('fail','identity','not-created') end",
    `if type(info.sdk_base)~='number' or info.sdk_base<4096 or info.sdk_base%4096~=0 or info.sdk_base+${profile.sdkCode.size}>=2^39 then return reply('fail','sdk-base-range','not-created') end`,
    "if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return reply('fail','native-bridge','not-created') end",
    "local ffi=require('ffi')",
    'local base=info.sdk_base',
    `for _,item in ipairs({${checks()}}) do if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return reply('fail','code-'..item[3],'not-created') end end`,
    `local entry=love.ffi.declare('uint32_t',{'void *','const char *'},base+${a.entryType.offset})`,
    `local create=love.ffi.declare('uint32_t',{'const char *','int64_t'},base+${a.createFile.offset})`,
    `local open=love.ffi.declare('uint32_t',{'void *','const char *','int'},base+${a.openFile.offset})`,
    `local writeFile=love.ffi.declare('uint32_t',{'uint64_t','int64_t','const void *','uint64_t','const void *'},base+${a.writeFile.offset})`,
    `local flush=love.ffi.declare('uint32_t',{'uint64_t'},base+${a.flushFile.offset})`,
    `local close=love.ffi.declare('void',{'uint64_t'},base+${a.closeFile.offset})`,
    `local readFile=love.ffi.declare('uint32_t',{'uint64_t','int64_t','void *','uint64_t'},base+${a.readFile.offset})`,
    `local getSize=love.ffi.declare('uint32_t',{'void *','uint64_t'},base+${a.getFileSize.offset})`,
    `local commit=love.ffi.declare('uint32_t',{'const char *'},base+${a.commit.offset})`,
    `local remove=love.ffi.declare('uint32_t',{'const char *'},base+${a.deleteFile.offset})`,
    "local marker=ffi.new('char[?]',#markerPath+1,markerPath)",
    "local absent=ffi.new('char[?]',#absentPath+1,absentPath)",
    "local mount=ffi.new('char[5]','save')",
    "local function kind(path) local out=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc);local called,rc=pcall(entry,ffi.cast('uint32_t*',out)+1,path);if not called or tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return nil,nil end;return tonumber(rc),tonumber(out[1]) end",
    "local function call(fn,...) local called,rc=pcall(fn,...);return called and tonumber(rc)==0 end",
    "local created=false",
    "local function cleanup() if not created then return 'not-created' end;local rc,tp=kind(marker);if rc==missing then return 'verified' end;if rc~=0 or tp~=1 then return 'retained' end;if not call(remove,marker) then return 'retained' end;if not call(commit,mount) then return 'retained' end;rc=kind(marker);if rc~=missing then return 'retained' end;created=false;return 'verified' end",
    "local function fail(why) return reply('fail',why,cleanup()) end",
    "local mr=kind(marker);local ar=kind(absent)",
    "if mr~=missing or ar~=missing then return reply('fail','path-preflight','not-created') end",
    "created=true",
    "if not call(create,marker,16) then return fail('create') end",
    "local out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "local called,rc=pcall(open,ffi.cast('uint64_t*',out)+1,marker,2)",
    "if not called or tonumber(rc)~=0 or tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc or tonumber(out[1])==0 then return fail('open-write') end",
    "local h=out[1];local data=ffi.new('uint8_t[16]');ffi.copy(data,wanted,16);local opts=ffi.new('uint32_t[1]',0)",
    "called,rc=pcall(writeFile,h,0,data,16,opts)",
    "if not called or tonumber(rc)~=0 then if not pcall(close,h) then return reply('fail','write-close','retained') end;return fail('write') end",
    "called,rc=pcall(flush,h)",
    "if not called or tonumber(rc)~=0 then if not pcall(close,h) then return reply('fail','flush-close','retained') end;return fail('flush') end",
    "if not pcall(close,h) then return reply('fail','write-close','retained') end",
    "if not call(commit,mount) then return fail('write-commit') end",
    "local present,tp=kind(marker);if present~=0 or tp~=1 then return fail('marker-not-file') end",
    "ar=kind(absent);if ar~=missing then return fail('absent-path') end",
    "out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "called,rc=pcall(open,ffi.cast('uint64_t*',out)+1,marker,1)",
    "if not called or tonumber(rc)~=0 or tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc or tonumber(out[1])==0 then return fail('open-read') end",
    "h=out[1];local size=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "called,rc=pcall(getSize,ffi.cast('uint64_t*',size)+1,h)",
    "if not called or tonumber(rc)~=0 or tonumber(size[0])~=0x5a17eacc or tonumber(size[2])~=0x5a17eacc or tonumber(size[1])~=16 then if not pcall(close,h) then return reply('fail','size-close','retained') end;return fail('size') end",
    "local read=ffi.new('uint8_t[16]')",
    "called,rc=pcall(readFile,h,0,read,16)",
    "if not called or tonumber(rc)~=0 then if not pcall(close,h) then return reply('fail','read-close','retained') end;return fail('read') end",
    "local exact=ffi.string(read,16)==wanted",
    "if not pcall(close,h) then return reply('fail','read-close','retained') end",
    "if not exact then return fail('content-mismatch') end",
    "local clean=cleanup();if clean~='verified' then return reply('fail','cleanup','retained') end",
    "mr=kind(marker);ar=kind(absent)",
    "if mr~=missing or ar~=missing then return reply('fail','post-cleanup-path','retained') end",
    "return reply('ok','exact-content-controls','verified')",
  ].join('\n');
  if (Buffer.byteLength(source, 'utf8') > 32768) {
    throw new RangeError('Balatro marker content source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce}) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const prefix = `-> ${TAG}|`;
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro content reply');
  const fields = lines[0].slice(3).split('|');
  if (fields.length !== 5 || fields[0] !== TAG || fields[2] !== nonce ||
      !['verified', 'retained', 'not-created'].includes(fields[4])) {
    throw new Error('Balatro content reply does not match this request');
  }
  if (fields[1] === 'fail' && /^[a-z-]+$/.test(fields[3])) {
    throw new Error(`Balatro content control failed: ${fields[3]}; cleanup ${fields[4]}`);
  }
  if (fields[1] !== 'ok' || fields[3] !== 'exact-content-controls' ||
      fields[4] !== 'verified') throw new Error('incomplete Balatro content reply');
  return {markerContentVerified: true, absentPathVerified: true,
    cleanup: 'verified', markerWaveAttempted: false};
}

async function runMarkerContentControl({host, execute = executeLua,
                                        qualify = qualifyLive,
                                        nonceBytes = crypto.randomBytes,
                                        onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (typeof execute !== 'function' || typeof qualify !== 'function' ||
      typeof nonceBytes !== 'function' || typeof onPhase !== 'function') {
    throw new TypeError('invalid Balatro marker content dependency');
  }
  const bytes = nonceBytes(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) {
    throw new TypeError('nonce must be eight bytes');
  }
  const nonce = bytes.toString('hex');
  const ownedPaths = paths(nonce);
  onPhase(`owned marker ${ownedPaths.marker}`);
  const preflight = await qualify({host, includeService: true, execute, nonceBytes, onPhase});
  if (preflight?.readonly?.gameProfile !== profile.gameProfile ||
      preflight?.service?.cleanup !== 'closed' ||
      !/^0x[0-9a-f]{8}$/.test(preflight.readonly.absentPathResult || '') ||
      preflight.readonly.absentPathResult === '0x00000000') {
    throw new Error('Balatro marker content preflight did not verify the pinned profile');
  }
  const context = {nonce, absentResult: preflight.readonly.absentPathResult};
  onPhase('direct save content control');
  try {
    const reply = await execute({host, port: PORT, source: makeSource(context),
      timeoutMs: TIMEOUT_MS});
    return {host, port: PORT, profile: profile.gameProfile, nonce, ...ownedPaths,
      ...parseReply(reply, context)};
  } catch (error) {
    throw new Error(`${error.message}; inspect owned path ${ownedPaths.marker}; nonce ${nonce}`);
  }
}

module.exports = {TAG, PORT, TIMEOUT_MS, SYMBOLS, content, makeSource, parseReply,
  runMarkerContentControl};
