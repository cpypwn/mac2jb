const crypto = require('node:crypto');
const {makePreamble} = require('./qualify-owned.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_FFI_ARENA_V1';
const BYTES = 0x200000;
const SOURCE_LIMIT = 32768;
const PHASES = new Set(['reserve', 'inspect']);

function makeArenaBody() {
  return `local size=${BYTES}
local extra=0x2000
local mark=0xa5
local function arenaFail(reason)
  if b.fs_bridge and b.fs_bridge.owner==nonce then b.fs_bridge.stage='quarantined' end
  return fail(reason)
end
local held=b.fs_bridge
if phase=='reserve' and not held then
  local allocated,buf=pcall(ffi.new,'uint8_t[?]',size+extra)
  if not allocated or not buf then return fail('ffi-allocation') end
  local raw=tonumber(ffi.cast('uintptr_t',buf))
  if not raw or raw<4096 or raw+size+extra>=2^39 then
    b.fs_bridge={owner=nonce,stage='quarantined',buf=buf}
    return fail('raw-range')
  end
  local aligned=raw+0x100+(0x1000-(raw+0x100)%0x1000)%0x1000
  local before=aligned-raw-64
  local after=aligned-raw+size
  if aligned%0x1000~=0 or before<0 or after+64>size+extra then
    b.fs_bridge={owner=nonce,stage='quarantined',buf=buf}
    return fail('alignment')
  end
  held={owner=nonce,stage='verifying',buf=buf,base=aligned,bytes=size,
        before=before,after=after}
  b.fs_bridge=held
  for i=0,63 do buf[before+i]=mark;buf[after+i]=mark end
elseif not held or held.owner~=nonce or held.stage~='ready' then
  return fail('arena-not-ready')
end
if not held.buf or held.bytes~=size or
   type(held.base)~='number' or held.base%0x1000~=0 or
   held.base<4096 or held.base+size>=2^39 then return arenaFail('retained-range') end
local raw=tonumber(ffi.cast('uintptr_t',held.buf))
if not raw or held.base<raw+64 or held.base+size+64>raw+ffi.sizeof(held.buf) or
   held.before~=held.base-raw-64 or held.after~=held.base-raw+size then
  return arenaFail('retained-bounds')
end
for i=0,63 do
  if tonumber(held.buf[held.before+i])~=mark or
     tonumber(held.buf[held.after+i])~=mark then return arenaFail('guard') end
end
local first,why=mapping(held.base)
if not first then return arenaFail(why) end
local last,lastWhy=mapping(held.base+size-1)
if not last then return arenaFail(lastWhy) end
if first.base~=last.base or first.size~=last.size or first.type~=5 or first.perm~=3 or
   first.base>held.base or held.base+size>first.base+first.size then
  return arenaFail('heap-map')
end
local function disjoint(label,obj)
  if type(obj)~='cdata' then return nil,'missing:'..label end
  local p=tonumber(ffi.cast('uintptr_t',obj))
  local n=tonumber(ffi.sizeof(obj))
  if not p or not n or p<4096 or n<=0 or p+n>=2^39 then return nil,'range:'..label end
  if held.base<p+n and p<held.base+size then return nil,'overlap:'..label end
  return true
end
local net=b.net
if type(net)~='table' or not net.initialized then return arenaFail('socket-state') end
for _,item in ipairs({{'pool',net.pool},{'iobuf',net.iobuf},{'pollfd',net.pollfd},
                       {'addrbuf',net.addrbuf},{'addrlen',net.addrlen}}) do
  local ok,reason=disjoint('socket-'..item[1],item[2])
  if not ok then return arenaFail(reason) end
end
local gotCall,nativeCall=pcall(require,'bl.ffi_call')
if not gotCall or type(nativeCall)~='table' or type(nativeCall.prime)~='function' then
  return arenaFail('native-call-module')
end
local gotNativeArena,nativeArena=pcall(nativeCall.prime,ffi)
if not gotNativeArena or type(nativeArena)~='table' or
   type(nativeArena.ctrl)~='table' then return arenaFail('native-call-state') end
for _,item in ipairs({{'stack',nativeArena.stack},{'control',nativeArena.ctrl.buf},
                       {'context',nativeArena.ctx}}) do
  local ok,reason=disjoint('native-'..item[1],item[2])
  if not ok then return arenaFail(reason) end
end
held.stage='ready'
if type(log)=='function' then
  pcall(log,phase=='reserve' and '[FS] Balatro 2 MiB memory arena verified' or
                     '[FS] Balatro 2 MiB memory arena reverified')
end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',held.base),
                     tostring(size),'retained'},'\\t')`;
}

function makeSource({phase, nonce, skipMountCheck = true}) {
  if (!PHASES.has(phase)) throw new TypeError('phase must be reserve or inspect');
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('nonce must be 16 lowercase hex digits');
  const inherited = makePreamble({phase: 'allocator-map', nonce,
    skipMountCheck});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) {
    throw new Error('Balatro pinned preamble changed');
  }
  const preamble = inherited.replace('local phase="allocator-map"',
    `local phase=${JSON.stringify(phase)}`).replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const source = `${preamble}\n${makeArenaBody()}`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro FFI arena source exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {phase, nonce}) {
  if (!PHASES.has(phase) || !/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('invalid Balatro FFI arena context');
  }
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro FFI arena reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== phase || fields[3] !== nonce) {
    throw new Error('Balatro FFI arena reply does not match this phase and nonce');
  }
  if (fields[2] === 'fail' && fields.length === 5) {
    throw new Error(`Balatro FFI arena ${phase} failed: ${fields[4]}`);
  }
  if (fields.length !== 7 || fields[2] !== 'ok' || !/^0x[0-9a-f]+$/.test(fields[4]) ||
      fields[5] !== String(BYTES) || fields[6] !== 'retained') {
    throw new Error('Balatro FFI arena reply is incomplete');
  }
  const base = Number(BigInt(fields[4]));
  if (!Number.isSafeInteger(base) || base < 4096 || base % 4096 !== 0 ||
      base + BYTES >= 2 ** 39) {
    throw new Error('Balatro FFI arena reply has invalid address');
  }
  return {gameProfile: profile.gameProfile, phase, nonce, base: fields[4], bytes: BYTES,
    status: 'FFI arena retained; no save write, canary, or FS escalation tested'};
}

module.exports = {BYTES, makeArenaBody, makeSource, parseReply};

if (require.main === module) {
  const [phase = 'reserve', nonce = crypto.randomBytes(8).toString('hex')] = process.argv.slice(2);
  process.stdout.write(`${makeSource({phase, nonce})}\n`);
}
