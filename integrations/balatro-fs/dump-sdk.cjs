const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');

const CHUNK_BYTES = 16 * 1024;
const MAX_BYTES = 0x5e0000;
const PROFILE = '1.0.1f-FULL';
const RANGES = [
  [0, MAX_BYTES],
  [0x71d898, 0x7bf7c0],
  [0x7bf7c0, 0xaa600d],
];

function parseLine(reply, marker, count) {
  const error = reply.split('\n').find(line => /^(?:compile error:|error:|internal evaluation error|reply too large)/.test(line));
  if (error) throw new Error(error);
  const line = reply.split('\n').find(item => item.startsWith(`-> ${marker}\t`));
  if (!line) throw new Error(`Missing ${marker} reply`);
  const fields = line.slice(3).split('\t');
  if (fields.length !== count || fields[0] !== marker) throw new Error(`Invalid ${marker} reply`);
  return fields;
}

function infoSource() {
  return [
    'local b=BL',
    'if not b or b.state~="serving" or not b.info or b.info.version~="1.0.1f-FULL" then error("Balatro runtime changed") end',
    'if not love.ffi or not love.ffi.native_ready() then error("Balatro native profile unavailable") end',
    'local base=b.info.sdk_base',
    'if type(base)~="number" or base<=0 or base%4096~=0 then error("Invalid SDK base") end',
    'return ("BAL_SDK_INFO_V1\\t0x%x"):format(base)',
  ].join('\n');
}

function chunkSource(base, offset, count) {
  return [
    'local b=BL',
    'if not b or b.state~="serving" or not b.info or b.info.version~="1.0.1f-FULL" then error("Balatro runtime changed") end',
    `local base=b.info.sdk_base; if base~=${base} then error("SDK base changed") end`,
    `local offset=${offset}; local count=${count}`,
    'local ffi=require("ffi")',
    'local bytes=ffi.string(ffi.cast("const char*",base+offset),count)',
    'local hex={}; for i=1,count do hex[i]=("%02x"):format(bytes:byte(i)) end',
    'return ("BAL_SDK_CHUNK_V1\\t%d\\t%d\\t0x%x\\t%s"):format(offset,count,base,table.concat(hex))',
  ].join('\n');
}

async function dump({host, startOffset = 0, length, output, execute = executeLua, onProgress = () => {}}) {
  if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(length) || length <= 0 ||
      !RANGES.some(([start, end]) => startOffset >= start && startOffset + length <= end)) {
    throw new RangeError('SDK read is outside a verified image range');
  }
  const [, baseText] = parseLine(await execute({host, source: infoSource(), timeoutMs: 15000}), 'BAL_SDK_INFO_V1', 2);
  if (!/^0x[0-9a-f]+$/i.test(baseText)) throw new Error('Invalid SDK base');
  const base = Number(BigInt(baseText));
  if (!Number.isSafeInteger(base) || base <= 0 || base % 4096 !== 0) throw new Error('Unsafe SDK base');
  const result = Buffer.alloc(length);
  for (let at = 0; at < length; at += CHUNK_BYTES) {
    const offset = startOffset + at;
    const count = Math.min(CHUNK_BYTES, length - at);
    const [, receivedOffset, receivedCount, receivedBase, hex] = parseLine(
      await execute({host, source: chunkSource(base, offset, count), timeoutMs: 15000}), 'BAL_SDK_CHUNK_V1', 5);
    if (receivedOffset !== String(offset) || receivedCount !== String(count) ||
        receivedBase.toLowerCase() !== baseText.toLowerCase() ||
        hex.length !== count * 2 || !/^[0-9a-f]+$/i.test(hex)) {
      throw new Error(`SDK chunk mismatch at ${offset}`);
    }
    Buffer.from(hex, 'hex').copy(result, at);
    onProgress(at + count, length);
  }
  const resolved = path.resolve(output);
  await fs.writeFile(resolved, result, {flag: 'wx', mode: 0o600});
  return {profile: PROFILE, base: baseText, startOffset, bytes: length,
    sha256: crypto.createHash('sha256').update(result).digest('hex'), output: resolved};
}

async function main() {
  const [host, lengthText, output, offsetText] = process.argv.slice(2);
  if (!host || !/^[0-9]+$/.test(lengthText || '') || !output ||
      (offsetText !== undefined && !/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(offsetText))) {
    process.stderr.write('usage: node dump-sdk.cjs <switch-ipv4> <byte-length> <output-file> [start-offset]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await dump({host, startOffset: offsetText === undefined ? 0 : Number(offsetText),
      length: Number(lengthText), output,
      onProgress: (bytes, total) => {
        if (bytes === total || bytes % (1024 * 1024) === 0) process.stderr.write(`read ${bytes}/${total}\n`);
      }});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {CHUNK_BYTES, MAX_BYTES, RANGES, infoSource, chunkSource, parseLine, dump};
