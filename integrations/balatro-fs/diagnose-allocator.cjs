const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {helpers, makePreamble} = require('./qualify-owned.cjs');

const MARKER = 'BAL_OWNED_V1';
const PHASE = 'allocator-map';

function makeSource({nonce}) {
  const preamble = makePreamble({phase: PHASE, nonce});
  const source = `${preamble}
local manager=tonumber(ffi.cast('const uint64_t*',base+${helpers.allocatorManagerGlobalSdkOffset})[0])
if not manager or manager<4096 or manager>=9007199254740992 then return fail('allocator-manager') end
local region,why=mapping(manager)
if not region then return fail(why) end
local fits=manager>=region.base and manager+0x3f8<=region.base+region.size
if not fits then return fail('manager-header') end
local lower=tonumber(ffi.cast('const uint64_t*',manager+0x3e8)[0])
local extent=tonumber(ffi.cast('const uint64_t*',manager+0x3f0)[0])
if not lower or not extent or lower<4096 or extent<4096 or lower+extent>=9007199254740992 then return fail('allocator-bounds') end
return table.concat({'${MARKER}',phase,'ok',nonce,string.format('0x%x',manager),
  string.format('0x%x',region.base),string.format('0x%x',region.size),
  tostring(region.type),tostring(region.perm),fits and '1' or '0',
  string.format('0x%x',lower),string.format('0x%x',extent)},'\\t')`;
  if (Buffer.byteLength(source, 'utf8') > 32768) {
    throw new RangeError('allocator diagnostic exceeds REPL limit');
  }
  return source;
}

function parseReply(reply, {nonce}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) throw new TypeError('invalid nonce');
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t${PHASE}\t`));
  if (lines.length !== 1) throw new Error('missing or duplicated allocator diagnostic reply');
  const fields = lines[0].slice(3).split('\t');
  if (fields[0] !== MARKER || fields[1] !== PHASE || fields[3] !== nonce) {
    throw new Error('allocator diagnostic reply does not match this nonce');
  }
  if (fields[2] === 'fail' && fields.length === 5) {
    throw new Error(`Balatro allocator diagnostic failed: ${fields[4]}`);
  }
  if (fields[2] !== 'ok' || fields.length !== 12 ||
      ![...fields.slice(4, 7), ...fields.slice(10, 12)].every(value => /^0x[0-9a-f]+$/.test(value)) ||
      !fields.slice(7, 9).every(value => /^\d{1,2}$/.test(value)) ||
      !/^[01]$/.test(fields[9])) {
    throw new Error('allocator diagnostic reply is incomplete');
  }
  const manager = BigInt(fields[4]);
  const base = BigInt(fields[5]);
  const size = BigInt(fields[6]);
  const lower = BigInt(fields[10]);
  const extent = BigInt(fields[11]);
  if (size <= 0n || size > 0x100000000n || manager < base || manager >= base + size ||
      (fields[9] === '1') !== (manager + 0x3f8n <= base + size) ||
      lower < 4096n || extent < 4096n || lower + extent >= 9007199254740992n) {
    throw new Error('allocator diagnostic returned inconsistent memory geometry');
  }
  return {
    manager: fields[4],
    region: {base: fields[5], size: fields[6], type: Number(fields[7]),
      permissions: Number(fields[8])},
    managerHeaderFits: fields[9] === '1',
    blockRange: {base: fields[10], size: fields[11]},
    expectedTypeWasFive: Number(fields[7]) === 5,
    allocated: false,
  };
}

async function diagnose({host, execute = executeLua, nonceBytes = crypto.randomBytes}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  const bytes = nonceBytes(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) {
    throw new Error('nonce generator did not return eight bytes');
  }
  const nonce = bytes.toString('hex');
  const reply = await execute({host, port: 9026, source: makeSource({nonce}), timeoutMs: 15000});
  return parseReply(reply, {nonce});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    process.stderr.write('usage: node diagnose-allocator.cjs <switch-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await diagnose({host: argv[0]});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {makeSource, parseReply, diagnose, main};
