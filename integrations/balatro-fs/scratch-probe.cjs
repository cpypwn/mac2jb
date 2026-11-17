const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {qualifyLive} = require('./qualify-live.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');

const MARKER = 'BAL_SCRATCH_V1';
const CHUNK = 262144;
const STEP = 1048576;
const SIZES = Object.freeze({'4k': 4096, '4m': 4194304, '8m': 8388608});
const PINNED = ['entryType', 'freeSpace', 'createFile', 'openFile', 'writeFile',
  'flushFile', 'closeFile', 'commit', 'readFile', 'getFileSize', 'deleteFile'];

function luaBytes(hex) {
  return '"' + [...Buffer.from(hex, 'hex')].map(byte =>
    '\\' + String(byte).padStart(3, '0')).join('') + '"';
}

function validate(context) {
  const {phase, nonce, size, absentResult, index} = context;
  if (!['create', 'write', 'commit', 'read', 'delete', 'inspect', 'cleanup'].includes(phase)) {
    throw new TypeError('invalid phase');
  }
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid nonce');
  if (![4096, 4194304, 8388608].includes(size)) throw new RangeError('invalid size');
  if (!/^0x[0-9a-f]{8}$/.test(absentResult || '') || absentResult === '0x00000000') {
    throw new TypeError('exact missing-path Result is required');
  }
  const count = Math.ceil(size / STEP);
  if (phase === 'write' || phase === 'read') {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('invalid step');
  } else if (index !== undefined) throw new TypeError('unexpected step');
  if (profile.runtimeVersion !== '1.0.1f-FULL' ||
      profile.sdkCode.sha256 !== abi.sdkCodeSha256 ||
      live.identity.runtimeVersion !== profile.runtimeVersion) throw new Error('profile mismatch');
  for (const name of PINNED) {
    const item = abi.functions[name];
    if (!item || !Number.isSafeInteger(item.offset) || !/^[0-9a-f]{16,32}$/.test(item.head)) {
      throw new Error('missing pinned symbol: ' + name);
    }
  }
}

function makeSource(context) {
  validate(context);
  const {phase, nonce, size, absentResult, index} = context;
  const path = 'save:/bal-fs-' + nonce + '.bin';
  const checks = PINNED.map(name => {
    const item = abi.functions[name];
    return '{' + item.offset + ',' + luaBytes(item.head) + ',' + JSON.stringify(name) + '}';
  }).join(',');
  const a = abi.functions;
  const header = [
    'local b=BL',
    'local info=b and b.info',
    'local nonce=' + JSON.stringify(nonce),
    'local path=' + JSON.stringify(path),
    'local phase=' + JSON.stringify(phase),
    'local size=' + size,
    'local expected=' + Number.parseInt(absentResult, 16),
    "local function fail(reason) local s=b and b._balScratch; if s and s.nonce==nonce then s.phase='failed';s.failure=phase..':'..reason end; return table.concat({'" + MARKER + "',phase,'fail',nonce,tostring(reason)},'|') end",
    "local function ok(detail) return table.concat({'" + MARKER + "',phase,'ok',nonce,tostring(detail)},'|') end",
    "if not (b and b.state=='serving' and info and info.version=='1.0.1f-FULL') then return fail('identity') end",
    "if type(info.sdk_base)~='number' or info.sdk_base<4096 or info.sdk_base%4096~=0 or info.sdk_base+" + profile.sdkCode.size + ">=2^39 then return fail('sdk-base-range') end",
    "if not (love and love.ffi and love.ffi.native_ready and love.ffi.native_ready()) then return fail('native-bridge') end",
    "local ffi=require('ffi')",
    'local base=info.sdk_base',
    'for _,item in ipairs({' + checks + "}) do if ffi.string(ffi.cast('const char*',base+item[1]),#item[2])~=item[2] then return fail('code:'..item[3]) end end",
    "local p=ffi.new('char[?]',#path+1,path)",
    "local mount=ffi.new('char[5]','save')",
    "local entry=love.ffi.declare('uint32_t',{'void *','const char *'},base+" + a.entryType.offset + ')',
    "local free=love.ffi.declare('uint32_t',{'void *','const char *'},base+" + a.freeSpace.offset + ')',
    "local function queryEntry() local out=ffi.new('uint32_t[3]',0x5a17eacc,0,0x5a17eacc); local called,rc=pcall(entry,ffi.cast('uint32_t*',out)+1,p); if not called then return nil,'entry-call' end; if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return nil,'entry-guard' end; return tonumber(rc),tonumber(out[1]) end",
    "local function queryFree() local out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc); local called,rc=pcall(free,ffi.cast('uint64_t*',out)+1,ffi.new('char[7]','save:/')); if not called or tonumber(rc)~=0 then return nil,'free-result' end; if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return nil,'free-guard' end; return tonumber(out[1]) end",
    'local s=b._balScratch',
  ];
  if (phase !== 'create') header.push(
    "if not (s and s.nonce==nonce and s.path==path and s.size==size and s.expected==expected) then return fail('state') end");
  let body;
  if (phase === 'create') body = [
    "if s then return fail('prior-transaction') end",
    "local missing,why=queryEntry(); if missing==nil then return fail(why) end",
    "if missing~=expected then return fail('path-result:'..string.format('%08x',missing)) end",
    "local available,why=queryFree(); if not available then return fail(why) end",
    "if available<size+524288 or available>16777216 then return fail('space:'..tostring(available)) end",
    "s={nonce=nonce,path=path,size=size,expected=expected,freeBefore=available,phase='creating',step=0};b._balScratch=s",
    "local createFile=love.ffi.declare('uint32_t',{'const char *','int64_t'},base+" + a.createFile.offset + ')',
    "local commit=love.ffi.declare('uint32_t',{'const char *'},base+" + a.commit.offset + ')',
    "local called,rc=pcall(createFile,p,size); if not called or tonumber(rc)~=0 then return fail('create:'..tostring(rc)) end",
    "called,rc=pcall(commit,mount); if not called or tonumber(rc)~=0 then return fail('create-commit:'..tostring(rc)) end",
    "s.phase='write';return ok('created')",
  ];
  if (phase === 'write') {
    const stop = Math.min(size, (index + 1) * STEP);
    body = [
      "if s.phase~='write' or s.step~=" + index + " then return fail('write-order') end",
      "local open=love.ffi.declare('uint32_t',{'void *','const char *','int'},base+" + a.openFile.offset + ')',
      "local writeFile=love.ffi.declare('uint32_t',{'uint64_t','int64_t','const void *','uint64_t','const void *'},base+" + a.writeFile.offset + ')',
      "local flush=love.ffi.declare('uint32_t',{'uint64_t'},base+" + a.flushFile.offset + ')',
      "local close=love.ffi.declare('void',{'uint64_t'},base+" + a.closeFile.offset + ')',
      "local out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
      "local called,rc=pcall(open,ffi.cast('uint64_t*',out)+1,p,2); if not called or tonumber(rc)~=0 then return fail('open-write:'..tostring(rc)) end",
      "if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return fail('handle-guard') end",
      "local h=out[1];if tonumber(h)==0 then return fail('handle-zero') end",
      "local opts=ffi.new('uint32_t[1]',0)",
      'for off=' + index * STEP + ',' + (stop - 1) + ',' + CHUNK + ' do',
      'local n=math.min(' + CHUNK + ',' + stop + '-off)',
      "local buffer=ffi.new('uint8_t[?]',n+16);for i=0,7 do buffer[i]=165;buffer[n+8+i]=165 end",
      "local data=ffi.cast('uint8_t*',buffer)+8",
      'ffi.fill(data,n,(math.floor(off/' + CHUNK + ')*37+17)%256)',
      "called,rc=pcall(writeFile,h,off,data,n,opts);if not called or tonumber(rc)~=0 then pcall(close,h);return fail('write:'..tostring(rc)) end",
      "for i=0,7 do if tonumber(buffer[i])~=165 or tonumber(buffer[n+8+i])~=165 then pcall(close,h);return fail('write-guard') end end",
      'end',
      "called,rc=pcall(flush,h);if not called or tonumber(rc)~=0 then pcall(close,h);return fail('flush:'..tostring(rc)) end",
      "called,rc=pcall(close,h);if not called then return fail('close-write:'..tostring(rc)) end",
      's.step=' + (index + 1),
      "if s.step==math.ceil(size/" + STEP + ") then s.phase='commit' end",
      "return ok('written:" + stop + "')",
    ];
  }
  if (phase === 'commit') body = [
    "if s.phase~='commit' or s.step~=math.ceil(size/" + STEP + ") then return fail('commit-order') end",
    "local commit=love.ffi.declare('uint32_t',{'const char *'},base+" + a.commit.offset + ')',
    "local called,rc=pcall(commit,mount);if not called or tonumber(rc)~=0 then return fail('data-commit:'..tostring(rc)) end",
    "s.phase='read';s.step=0;return ok('committed')",
  ];
  if (phase === 'read') {
    const stop = Math.min(size, (index + 1) * STEP);
    body = [
      "if s.phase~='read' or s.step~=" + index + " then return fail('read-order') end",
      "local open=love.ffi.declare('uint32_t',{'void *','const char *','int'},base+" + a.openFile.offset + ')',
      "local getSize=love.ffi.declare('uint32_t',{'void *','uint64_t'},base+" + a.getFileSize.offset + ')',
      "local readFile=love.ffi.declare('uint32_t',{'uint64_t','int64_t','void *','uint64_t'},base+" + a.readFile.offset + ')',
      "local close=love.ffi.declare('void',{'uint64_t'},base+" + a.closeFile.offset + ')',
      "local out=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
      "local called,rc=pcall(open,ffi.cast('uint64_t*',out)+1,p,1);if not called or tonumber(rc)~=0 then return fail('open-read:'..tostring(rc)) end",
      "if tonumber(out[0])~=0x5a17eacc or tonumber(out[2])~=0x5a17eacc then return fail('handle-guard') end",
      "local h=out[1];if tonumber(h)==0 then return fail('handle-zero') end",
      "local outSize=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
      "called,rc=pcall(getSize,ffi.cast('uint64_t*',outSize)+1,h);if not called or tonumber(rc)~=0 then pcall(close,h);return fail('size-result:'..tostring(rc)) end",
      "if tonumber(outSize[0])~=0x5a17eacc or tonumber(outSize[2])~=0x5a17eacc or tonumber(outSize[1])~=size then pcall(close,h);return fail('size-mismatch') end",
      'for off=' + index * STEP + ',' + (stop - 1) + ',' + CHUNK + ' do',
      'local n=math.min(' + CHUNK + ',' + stop + '-off)',
      "local buffer=ffi.new('uint8_t[?]',n+16);for i=0,7 do buffer[i]=165;buffer[n+8+i]=165 end",
      "local data=ffi.cast('uint8_t*',buffer)+8",
      "called,rc=pcall(readFile,h,off,data,n);if not called or tonumber(rc)~=0 then pcall(close,h);return fail('read:'..tostring(rc)) end",
      "if ffi.string(data,n)~=string.rep(string.char((math.floor(off/" + CHUNK + ")*37+17)%256),n) then pcall(close,h);return fail('read-mismatch:'..tostring(off)) end",
      "for i=0,7 do if tonumber(buffer[i])~=165 or tonumber(buffer[n+8+i])~=165 then pcall(close,h);return fail('read-guard') end end",
      'end',
      "called,rc=pcall(close,h);if not called then return fail('close-read:'..tostring(rc)) end",
      's.step=' + (index + 1),
      "if s.step==math.ceil(size/" + STEP + ") then s.phase='verified' end",
      "return ok('verified:" + stop + "')",
    ];
  }
  if (phase === 'delete') body = [
    "if s.phase~='verified' then return fail('delete-order') end",
    "local deleteFile=love.ffi.declare('uint32_t',{'const char *'},base+" + a.deleteFile.offset + ')',
    "local commit=love.ffi.declare('uint32_t',{'const char *'},base+" + a.commit.offset + ')',
    "local called,rc=pcall(deleteFile,p);if not called or tonumber(rc)~=0 then return fail('delete:'..tostring(rc)) end",
    "called,rc=pcall(commit,mount);if not called or tonumber(rc)~=0 then return fail('delete-commit:'..tostring(rc)) end",
    "local missing,why=queryEntry();if missing==nil then return fail(why) end",
    "if missing~=expected then return fail('delete-result:'..string.format('%08x',missing)) end",
    "local available,why=queryFree();if not available then return fail(why) end",
    "if available<s.freeBefore-1048576 then return fail('free-not-restored:'..tostring(available)) end",
    "b._balScratch=nil;return ok('clean:'..tostring(available))",
  ];
  if (phase === 'inspect') body = [
    "local result,kind=queryEntry();if result==nil then return fail(kind) end",
    "if result~=expected and result~=0 then return fail('entry-result:'..string.format('%08x',result)) end",
    "if result==0 and kind~=1 then return fail('entry-type:'..tostring(kind)) end",
    "local available,why=queryFree();if not available then return fail(why) end",
    "return ok(s.phase..':'..string.format('%08x',result)..':'..tostring(kind)..':'..tostring(available))",
  ];
  if (phase === 'cleanup') body = [
    "if s.phase~='failed' then return fail('cleanup-not-failed') end",
    "local result,kind=queryEntry();if result==nil then return fail(kind) end",
    "if result~=expected and result~=0 then return fail('entry-result:'..string.format('%08x',result)) end",
    "if result==0 then",
    "if kind~=1 then return fail('entry-type:'..tostring(kind)) end",
    "local open=love.ffi.declare('uint32_t',{'void *','const char *','int'},base+" + a.openFile.offset + ')',
    "local getSize=love.ffi.declare('uint32_t',{'void *','uint64_t'},base+" + a.getFileSize.offset + ')',
    "local close=love.ffi.declare('void',{'uint64_t'},base+" + a.closeFile.offset + ')',
    "local handleOut=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "local called,rc=pcall(open,ffi.cast('uint64_t*',handleOut)+1,p,1)",
    "if not called or tonumber(rc)~=0 then return fail('cleanup-open:'..tostring(rc)) end",
    "if tonumber(handleOut[0])~=0x5a17eacc or tonumber(handleOut[2])~=0x5a17eacc or tonumber(handleOut[1])==0 then return fail('cleanup-handle') end",
    "local h=handleOut[1];local sizeOut=ffi.new('uint64_t[3]',0x5a17eacc,0,0x5a17eacc)",
    "called,rc=pcall(getSize,ffi.cast('uint64_t*',sizeOut)+1,h)",
    "if not called or tonumber(rc)~=0 then pcall(close,h);return fail('cleanup-size:'..tostring(rc)) end",
    "local exactSize=tonumber(sizeOut[0])==0x5a17eacc and tonumber(sizeOut[2])==0x5a17eacc and tonumber(sizeOut[1])==size",
    "called,rc=pcall(close,h);if not called then return fail('cleanup-close:'..tostring(rc)) end",
    "if not exactSize then return fail('cleanup-size-mismatch') end",
    "local deleteFile=love.ffi.declare('uint32_t',{'const char *'},base+" + a.deleteFile.offset + ')',
    "local commit=love.ffi.declare('uint32_t',{'const char *'},base+" + a.commit.offset + ')',
    "local called,rc=pcall(deleteFile,p);if not called or tonumber(rc)~=0 then return fail('delete:'..tostring(rc)) end",
    "called,rc=pcall(commit,mount);if not called or tonumber(rc)~=0 then return fail('delete-commit:'..tostring(rc)) end",
    "result,kind=queryEntry();if result==nil then return fail(kind) end",
    "if result~=expected then return fail('delete-result:'..string.format('%08x',result)) end",
    "end",
    "local available,why=queryFree();if not available then return fail(why) end",
    "if available<s.freeBefore-1048576 then return fail('free-not-restored:'..tostring(available)) end",
    "b._balScratch=nil;return ok('clean:'..tostring(available))",
  ];
  const source = header.concat(body).join('\n');
  if (Buffer.byteLength(source, 'utf8') > 32768) throw new RangeError('scratch source exceeds REPL limit');
  return source;
}

function parseReply(reply, context) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw new Error(reply.trim());
  const prefix = '-> ' + MARKER + '|';
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error('missing or duplicated scratch reply');
  const fields = lines[0].slice(3).split('|');
  if (fields.length !== 5 || fields[0] !== MARKER ||
      fields[1] !== context.phase || fields[3] !== context.nonce) {
    throw new Error('scratch reply does not match phase and nonce');
  }
  if (fields[2] === 'fail') throw new Error('Balatro scratch ' + context.phase + ' failed: ' + fields[4]);
  if (fields[2] !== 'ok' || !/^[a-z0-9:-]+$/.test(fields[4])) {
    throw new Error('incomplete scratch reply');
  }
  return {phase: context.phase, detail: fields[4]};
}

async function probeScratch({host, size, absentResult, execute = executeLua,
                             qualify = qualifyLive, nonceBytes = crypto.randomBytes,
                             onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  const bytes = nonceBytes(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) throw new TypeError('nonce must be eight bytes');
  const nonce = bytes.toString('hex');
  validate({phase: 'create', nonce, size, absentResult});
  onPhase('owned path save:/bal-fs-' + nonce + '.bin');
  const preflight = await qualify({host, includeService: true, execute, nonceBytes, onPhase});
  if (preflight.readonly.absentPathResult !== absentResult ||
      preflight.readonly.gameProfile !== profile.gameProfile ||
      preflight.service.cleanup !== 'closed') {
    throw new Error('read-only/service preflight did not match pinned Balatro profile and missing-path Result');
  }
  const count = Math.ceil(size / STEP);
  const phases = [{phase: 'create'}, ...Array.from({length: count}, (_, index) => ({phase: 'write', index})),
    {phase: 'commit'}, ...Array.from({length: count}, (_, index) => ({phase: 'read', index})),
    {phase: 'delete'}];
  const results = [];
  for (const item of phases) {
    const context = {...item, nonce, size, absentResult};
    onPhase(item.phase + (item.index === undefined ? '' : ' ' + (item.index + 1) + '/' + count));
    try {
      const reply = await execute({host, port: 9026, source: makeSource(context), timeoutMs: 30000});
      results.push(parseReply(reply, context));
    } catch (error) {
      throw new Error(error.message + '; owned path save:/bal-fs-' + nonce + '.bin; nonce ' + nonce);
    }
  }
  return {host, port: 9026, profile: profile.gameProfile, nonce,
    path: 'save:/bal-fs-' + nonce + '.bin', size, preflight: preflight.readonly,
    results, cleanup: 'verified'};
}

async function inspectScratch({host, nonce, size, absentResult, cleanup = false,
                               execute = executeLua, qualify = qualifyLive,
                               nonceBytes = crypto.randomBytes, onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  validate({phase: 'inspect', nonce, size, absentResult});
  const preflight = await qualify({host, includeService: true, execute, nonceBytes, onPhase});
  if (preflight.readonly.absentPathResult !== absentResult ||
      preflight.readonly.gameProfile !== profile.gameProfile ||
      preflight.service.cleanup !== 'closed') {
    throw new Error('read-only/service preflight did not match the pinned profile');
  }
  const context = {phase: 'inspect', nonce, size, absentResult};
  const reply = await execute({host, port: 9026, source: makeSource(context), timeoutMs: 30000});
  const inspection = parseReply(reply, context);
  if (!cleanup) return {nonce, path: 'save:/bal-fs-' + nonce + '.bin', inspection};
  const inspectMatch = inspection.detail.match(/^failed:([0-9a-f]{8}):([0-9]+):([0-9]+)$/);
  if (!inspectMatch ||
      (inspectMatch[1] !== '00000000' && inspectMatch[1] !== absentResult.slice(2)) ||
      (inspectMatch[1] === '00000000' && inspectMatch[2] !== '1')) {
    throw new Error('scratch state is not failed; no cleanup was attempted');
  }
  onPhase('explicit owned-file cleanup');
  const cleanupContext = {...context, phase: 'cleanup'};
  const cleaned = parseReply(await execute({host, port: 9026,
    source: makeSource(cleanupContext), timeoutMs: 30000}), cleanupContext);
  return {nonce, path: 'save:/bal-fs-' + nonce + '.bin', inspection,
    cleanup: cleaned};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 7 && (argv[1] === '--inspect' || argv[1] === '--cleanup') &&
      argv[3] === '--size' && argv[5] === '--absent-result' && Object.hasOwn(SIZES, argv[4])) {
    try {
      const result = await inspectScratch({host: argv[0], nonce: argv[2],
        size: SIZES[argv[4]], absentResult: argv[6], cleanup: argv[1] === '--cleanup',
        onPhase: name => process.stderr.write('Balatro scratch: ' + name + '\n')});
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (error) {
      process.stderr.write(error.message + '\nNo automatic retry was attempted.\n');
      process.exitCode = 1;
    }
    return;
  }
  if (argv.length !== 5 || argv[1] !== '--size' || argv[3] !== '--absent-result' ||
      !Object.hasOwn(SIZES, argv[2])) {
    process.stderr.write('usage: node scratch-probe.cjs <switch-ipv4> --size 4k|8m|4m --absent-result 0x00000202\n' +
      '       node scratch-probe.cjs <switch-ipv4> --inspect|--cleanup <nonce> --size 4k|8m|4m --absent-result 0x00000202\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await probeScratch({host: argv[0], size: SIZES[argv[2]], absentResult: argv[4],
      onPhase: name => process.stderr.write('Balatro scratch: ' + name + '\n')});
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\nNo automatic retry or fallback was attempted. Inspect the owned scratch file before another size.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = {CHUNK, STEP, SIZES, makeSource, parseReply, probeScratch, inspectScratch, main};
