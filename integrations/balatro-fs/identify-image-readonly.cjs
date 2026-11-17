const crypto = require('node:crypto');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');

const MARKER = 'BAL_IMAGE_ID_V1';
const HEADS = {
  '1.0.1f': {
    present: 'fd7bbea9f44f01a9fd030091e81300b0',
    memcpy: 'e80301cb0a0940925f0102eb62040054',
  },
  '1.0.1o': {
    present: 'fd7bbea9f44f01a9fd03009128110090',
    memcpy: 'ec0301cb8a0940924b000aeb69040054',
  },
};

function makeSource(nonce) {
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw new TypeError('invalid probe nonce');
  return `local nonce=${JSON.stringify(nonce)}
local function clean(value) return tostring(value or ''):gsub('[\\t\\r\\n]',' ') end
local okUtil,util=pcall(require,'jit.util')
local okFfi,ffi=pcall(require,'ffi')
if not okUtil or not okFfi then return '${MARKER}\\t'..nonce..'\\terror\\tjit-or-ffi-unavailable' end
local fi=util.funcinfo(love.graphics.present)
local anchor=fi and tonumber(fi.addr)
if not anchor or anchor<4096 or anchor>=2^39 then return '${MARKER}\\t'..nonce..'\\terror\\tpresent-anchor' end
local function head(address)
  local p=ffi.cast('const uint8_t*',address)
  local parts={}
  for i=0,15 do parts[#parts+1]=string.format('%02x',tonumber(p[i])) end
  return table.concat(parts)
end
local info=BL and BL.info
local version=love.filesystem.read('version.jkr')
version=type(version)=='string' and version:match('^[^\\r\\n]+') or ''
local sdkHead=''
local sdkOffset=''
if type(info)=='table' and type(info.sdk_base)=='number' and
   type(info.off)=='table' and type(info.off.memcpy)=='number' and
   info.sdk_base>=4096 and info.sdk_base<2^39 and
   info.off.memcpy>=0 and info.off.memcpy<0x1000000 then
  sdkOffset=string.format('0x%x',info.off.memcpy)
  sdkHead=head(info.sdk_base+info.off.memcpy)
end
return table.concat({'${MARKER}',nonce,clean(BL and BL.state),clean(version),
  string.format('0x%x',anchor),head(anchor),
  type(info)=='table' and string.format('0x%x',info.main_base or 0) or '',
  type(info)=='table' and string.format('0x%x',info.sdk_base or 0) or '',
  sdkOffset,sdkHead},'\\t')`;
}

function parseReply(reply, nonce) {
  if (typeof reply !== 'string') throw new TypeError('probe reply must be text');
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw new Error('missing or duplicated Balatro identity reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== nonce) throw new Error('Balatro identity nonce mismatch');
  if (fields[2] === 'error') throw new Error(fields[3] || 'Balatro identity failed');
  if (fields.length !== 10 || !/^0x[0-9a-f]+$/.test(fields[4]) ||
      !/^[0-9a-f]{32}$/.test(fields[5]) ||
      (fields[9] && !/^[0-9a-f]{32}$/.test(fields[9]))) {
    throw new Error('incomplete Balatro identity reply');
  }
  const [, , state, metadataVersion, presentAddress, presentHead,
    mainBase, sdkBase, memcpyOffset, memcpyHead] = fields;
  const matches = Object.entries(HEADS).filter(([, heads]) =>
    heads.present === presentHead && (!memcpyHead || heads.memcpy === memcpyHead));
  const codeHeadProfile = matches.length === 1 ? matches[0][0] : 'unknown-or-mixed';
  const fingerprint = crypto.createHash('sha256')
    .update(`${presentHead}:${memcpyOffset}:${memcpyHead}`)
    .digest('hex');
  return {state, metadataVersion, presentAddress, mainBase, sdkBase,
    presentHead, memcpyOffset, memcpyHead, codeHeadProfile,
    sampleFingerprintSha256: fingerprint,
    completeSdkHash: false};
}

async function identify(host, execute = executeLua) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const reply = await execute({host, port: 9026, source: makeSource(nonce), timeoutMs: 10000});
  return parseReply(reply, nonce);
}

if (require.main === module) {
  const host = process.argv[2];
  if (!host) {
    process.stderr.write('usage: node identify-image-readonly.cjs <switch-ipv4>\n');
    process.exitCode = 2;
  } else {
    identify(host).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
      error => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}

module.exports = {HEADS, makeSource, parseReply, identify};
