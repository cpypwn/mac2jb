const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const readonly = require('./probe-readonly.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_FS_LOG_SNAPSHOT_V1';
const LOGGER_SHA256 = 'fb42dd88c98e2136f852980f24914c43af3112587cbc5a70cf12e7d943d636c1';
const REPLACEMENT_POINT = "local showcase=package.loaded['bl.lovera1n_showcase']";

function makeSource({nonce}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid Balatro log snapshot nonce');
  const source = readonly.makeSource({nonce});
  const cut = source.indexOf(REPLACEMENT_POINT);
  if (cut < 0 || !source.slice(cut).includes("return table.concat({'BAL_FS_READONLY_V1','ok'")) {
    throw Error('Balatro read-only source changed; log snapshot needs review');
  }
  const snapshot = `local function snapFail(reason)
  return table.concat({'${MARKER}','fail',nonce,reason},'\\t')
end
local fs=love and love.filesystem
if not (fs and type(fs.getInfo)=='function' and type(fs.read)=='function') then return snapFail('filesystem-api') end
local logger=fs.read('bl/log.lua')
if type(logger)~='string' or #logger<100 or #logger>8192 then return snapFail('logger-source') end
local logInfo=fs.getInfo('bl_log.txt','file')
if not logInfo or logInfo.type~='file' or type(logInfo.size)~='number' or
   logInfo.size<0 or logInfo.size%1~=0 then return snapFail('log-info') end
local phaseInfo=fs.getInfo('bl_phase.txt','file')
local phaseSize=-1
if phaseInfo then
  if phaseInfo.type~='file' or type(phaseInfo.size)~='number' or
     phaseInfo.size<0 or phaseInfo.size%1~=0 then return snapFail('phase-info') end
  phaseSize=phaseInfo.size
end
local hex={}
for i=1,#logger do hex[i]=string.format('%02x',logger:byte(i)) end
return table.concat({'${MARKER}','ok',nonce,tostring(free),
  string.format('%08x',tonumber(entryRc)),tostring(logInfo.size),
  tostring(phaseSize),table.concat(hex)},'\\t')`;
  const result = source.slice(0, cut) + snapshot;
  if (Buffer.byteLength(result, 'utf8') > 32768) throw new RangeError('Balatro log snapshot exceeds REPL request limit');
  return result;
}

function parseReply(reply, {nonce, expectedLoggerHash = LOGGER_SHA256}) {
  if (typeof reply !== 'string' || !/^[0-9a-f]{16}$/.test(nonce || '') ||
      !/^[0-9a-f]{64}$/.test(expectedLoggerHash)) {
    throw new TypeError('invalid Balatro log snapshot reply or context');
  }
  const lines = reply.trimEnd().split('\n')
    .filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) {
    if (reply.includes('-> BAL_FS_READONLY_V1\t')) readonly.parseReply(reply, {nonce});
    throw Error('missing or duplicated Balatro log snapshot reply');
  }
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[2] !== nonce) throw Error('Balatro log snapshot nonce mismatch');
  if (fields[1] === 'fail' && fields.length === 4) {
    throw Error(`Balatro log snapshot failed: ${fields[3]}`);
  }
  if (fields[1] !== 'ok' || fields.length !== 8 ||
      !/^\d+$/.test(fields[3]) || !/^[0-9a-f]{8}$/.test(fields[4]) ||
      !/^\d+$/.test(fields[5]) || !/^-?\d+$/.test(fields[6]) ||
      !/^[0-9a-f]{200,16384}$/.test(fields[7]) || fields[7].length % 2) {
    throw Error('Balatro log snapshot is incomplete');
  }
  const freeBytes = Number(fields[3]);
  const logSizeBytes = Number(fields[5]);
  const phaseSizeBytes = Number(fields[6]);
  if (![freeBytes, logSizeBytes, phaseSizeBytes].every(Number.isSafeInteger) ||
      freeBytes < 1048576 || freeBytes > 16777216 ||
      logSizeBytes > 16777216 || phaseSizeBytes < -1 || phaseSizeBytes > 8192) {
    throw Error('Balatro log snapshot has invalid sizes');
  }
  const loggerSourceSha256 = crypto.createHash('sha256')
    .update(Buffer.from(fields[7], 'hex')).digest('hex');
  if (loggerSourceSha256 !== expectedLoggerHash) {
    throw Error('Balatro RPC logger source differs from the pinned save');
  }
  return {
    gameProfile: profile.gameProfile,
    nonce,
    readonly: {gameProfile: profile.gameProfile, freeBytes,
      absentPathResult: `0x${fields[4]}`},
    log: {sizeBytes: logSizeBytes, phaseSizeBytes,
      loggerSourceSha256, sourcePinned: true},
  };
}

async function takeSnapshot({host, execute = executeLua, nonceBytes = crypto.randomBytes}) {
  if (net.isIP(host) !== 4 || typeof execute !== 'function' ||
      typeof nonceBytes !== 'function') {
    throw new TypeError('Balatro log snapshot needs an IPv4 address and RPC dependencies');
  }
  const bytes = nonceBytes(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) throw Error('invalid snapshot nonce source');
  const nonce = bytes.toString('hex');
  const reply = await execute({host, port: 9026, source: makeSource({nonce}), timeoutMs: 15000});
  return parseReply(reply, {nonce});
}

module.exports = {MARKER, LOGGER_SHA256, makeSource, parseReply, takeSnapshot};
