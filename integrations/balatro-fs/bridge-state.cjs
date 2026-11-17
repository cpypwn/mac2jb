const net = require('node:net');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_BRIDGE_GREETING_DIAG_V1';

function makeStateSource({nonce, mainBase, sdkBase, arenaBase, macIp,
  port = 39381}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || net.isIP(macIp) !== 4 ||
      [mainBase, sdkBase, arenaBase].some(value => !/^0x[0-9a-f]+$/.test(value || '')) ||
      !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError('Balatro greeting state needs exact owner, image, and listener');
  }
  return `local b=BL
local h=b and b.fs_bridge
local t=b and b.fs_transport
if not b or b.state~='serving' or not b.info or
   b.info.version~='${profile.runtimeVersion}' or
   string.format('0x%x',b.info.main_base or 0)~='${mainBase}' or
   string.format('0x%x',b.info.sdk_base or 0)~='${sdkBase}' or
   not h or h.owner~='${nonce}' or h.stage~='ready' or
   string.format('0x%x',h.base or 0)~='${arenaBase}' or h.bytes~=0x200000 or
   b.fs_worker_hold then
  return '${MARKER}\\tfail\\towner-image-or-transport'
end
if t and (t.owner~='${nonce}' or t.hostIp~='${macIp}' or
   t.port~=${port} or t.arena~=h or not t.native) then
  return '${MARKER}\\tfail\\tforeign-or-changed-transport'
end
local function clean(v)
  return (tostring(v or ''):sub(1,160):gsub('[\\t\\r\\n]',' '))
end
return table.concat({'${MARKER}','ok','${nonce}',t and tostring(t.stage) or 'absent',
  tostring(t and t.accepted or 0),tostring(t and t.rejectedPeers or 0),
  t and t.listener and 'present' or 'absent',
  t and t.client and 'present' or 'absent',
  clean(t and t.lastPeer),clean(b.fs_transport_last_error)},'\\t')`;
}

function parseStateReply(reply, nonce) {
  if (typeof reply !== 'string' || !/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('Balatro greeting state reply is invalid');
  }
  const lines = reply.split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('Balatro greeting state reply is missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields[1] === 'fail' && fields.length === 3) {
    throw Error(`Balatro greeting state changed: ${fields[2]}`);
  }
  if (fields.length !== 10 || fields[0] !== MARKER || fields[1] !== 'ok' ||
      fields[2] !== nonce ||
      !['accept', 'send-hello', 'read-request', 'send-response', 'closed', 'absent']
        .includes(fields[3]) ||
      !/^\d+$/.test(fields[4]) || !/^\d+$/.test(fields[5]) ||
      !['present', 'absent'].includes(fields[6]) ||
      !['present', 'absent'].includes(fields[7]) ||
      fields[8].length > 160 || fields[9].length > 160) {
    throw Error('Balatro greeting state reply is incomplete');
  }
  const accepted = Number(fields[4]);
  const rejectedPeers = Number(fields[5]);
  if (!Number.isSafeInteger(accepted) || accepted > 2 ||
      !Number.isSafeInteger(rejectedPeers) || rejectedPeers > 4) {
    throw Error('Balatro greeting state counters exceed one bounded handshake');
  }
  return {stage: fields[3], accepted, rejectedPeers,
    listener: fields[6], client: fields[7], lastPeer: fields[8],
    lastTransportError: fields[9]};
}

module.exports = {MARKER, makeStateSource, parseStateReply};
