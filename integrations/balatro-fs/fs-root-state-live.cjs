const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const MARKER = 'BAL_ROOT_STATE_V1';

function makeSource({nonce, mainBase, sdkBase, arenaBase}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      [mainBase, sdkBase, arenaBase].some(value => !/^0x[0-9a-f]+$/.test(value || ''))) {
    throw new TypeError('Balatro state inspection needs exact owner and image addresses');
  }
  return `local b=BL
local h=b and b.fs_bridge
local t=b and b.fs_transport
if not b or b.state~='serving' or not b.info or
   b.info.version~='${profile.runtimeVersion}' or
   string.format('0x%x',b.info.main_base or 0)~='${mainBase}' or
   string.format('0x%x',b.info.sdk_base or 0)~='${sdkBase}' then
  return '${MARKER}\\tfail\\timage-changed'
end
if not h or h.owner~='${nonce}' or
   string.format('0x%x',h.base or 0)~='${arenaBase}' or
   h.bytes~=0x200000 or not h.buf then
  return '${MARKER}\\tfail\\tarena-owner-or-base-changed'
end
local ffi=require('ffi')
local raw=tonumber(ffi.cast('uintptr_t',h.buf))
if not raw or h.before~=h.base-raw-64 or
   h.after~=h.base-raw+h.bytes or
   h.base+h.bytes+64>raw+ffi.sizeof(h.buf) then
  return '${MARKER}\\tfail\\tarena-bounds'
end
for i=0,63 do
  if tonumber(h.buf[h.before+i])~=165 or
     tonumber(h.buf[h.after+i])~=165 then
    return '${MARKER}\\tfail\\tarena-guard'
  end
end
local transport='none'
if t then
  if t.owner~='${nonce}' then transport='foreign'
  else transport=tostring(t.stage or 'unknown') end
end
return table.concat({'${MARKER}','ok','${nonce}',
  string.format('0x%x',h.base),tostring(h.stage or 'unknown'),
  transport,t and t.listener and 'listener-present' or 'listener-absent',
  t and t.client and 'client-present' or 'client-absent',
  b.fs_worker_hold and 'worker-present' or 'worker-absent'},'\\t')`;
}

function parseReply(reply, {nonce, arenaBase}) {
  if (typeof reply !== 'string') throw new TypeError('Balatro state reply must be text');
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('Balatro state reply is missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields[1] === 'fail' && fields.length === 3) {
    throw Error(`Balatro state inspection failed: ${fields[2]}`);
  }
  if (fields.length !== 9 || fields[0] !== MARKER || fields[1] !== 'ok' ||
      fields[2] !== nonce || fields[3] !== arenaBase ||
      !['ready', 'quarantined', 'verifying'].includes(fields[4]) ||
      !['none', 'accept', 'send-hello', 'read-request', 'send-response',
        'closed', 'foreign'].includes(fields[5]) ||
      !['listener-present', 'listener-absent'].includes(fields[6]) ||
      !['client-present', 'client-absent'].includes(fields[7]) ||
      !['worker-present', 'worker-absent'].includes(fields[8])) {
    throw Error('Balatro state reply is incomplete or changed');
  }
  return {owner: nonce, arenaBase, arenaStage: fields[4],
    transportStage: fields[5], listener: fields[6],
    client: fields[7], worker: fields[8]};
}

async function inspectRootState({host, nonce, mainBase, sdkBase, arenaBase,
  execute = executeLua}) {
  if (net.isIP(host) !== 4) throw new TypeError('Balatro state target must be IPv4');
  const context = {nonce, mainBase, sdkBase, arenaBase};
  return parseReply(await execute({host, port: 9026, source: makeSource(context),
    timeoutMs: 10000}), context);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 5) {
    process.stderr.write('usage: node fs-root-state-live.cjs <switch-ipv4> <nonce> <main-base> <sdk-base> <arena-base>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await inspectRootState({host: argv[0], nonce: argv[1],
      mainBase: argv[2], sdkBase: argv[3], arenaBase: argv[4]});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry or cleanup was attempted.\n`);
    process.exitCode = 1;
  }
}

module.exports = {MARKER, makeSource, parseReply, inspectRootState, main};
if (require.main === module) main();
