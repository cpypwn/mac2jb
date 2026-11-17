const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const {executeLua, DEFAULT_PORT} = require('./repl-client.cjs');

const MAX_DUMP_BYTES = 32 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const PROFILES = new Set(['gravity-circuit-v1.0', 'gravity-circuit-v1.2.1']);

function parseLength(value) {
  if (typeof value !== 'string' || !/^(?:[1-9][0-9]*|0x[0-9a-f]+)$/i.test(value)) {
    throw new TypeError('length must be a positive decimal or hexadecimal byte count');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_DUMP_BYTES) {
    throw new RangeError(`length must be between 1 and ${MAX_DUMP_BYTES} bytes`);
  }
  return length;
}

function checkOptions({host, port, module, length, output, timeoutMs}) {
  if (net.isIP(host) !== 4) throw new TypeError('host must be a Switch IPv4 address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('port must be between 1 and 65535');
  }
  if (module !== 'main' && module !== 'sdk') {
    throw new TypeError('module must be main or sdk');
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_DUMP_BYTES) {
    throw new RangeError(`length must be between 1 and ${MAX_DUMP_BYTES} bytes`);
  }
  if (typeof output !== 'string' || !output.trim()) {
    throw new TypeError('output must be a file path');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
}

function infoSource(module) {
  const field = module === 'main' ? 'main_base' : 'sdk_base';
  return [
    'local info = LS and LS.nx_info',
    'if not info or LS.game_id ~= "gravity-circuit" or LS.state ~= "serving" then error("Gravity Circuit runtime unavailable") end',
    `local base = info.${field}`,
    'if type(base) ~= "number" or base <= 0 or base % 4096 ~= 0 then error("invalid resolved module base") end',
    'return ("GC_DUMP_INFO_V1\\t%s\\t0x%x"):format(tostring(info.profile or ""), base)',
  ].join('\n');
}

function remoteError(reply) {
  if (typeof reply !== 'string') throw new TypeError('Gravity Circuit reply must be text');
  const error = reply.split('\n').find((line) => /^(?:compile error:|error:|internal evaluation error|reply too large)/.test(line));
  if (error) throw new Error(`Gravity Circuit REPL: ${error}`);
}

function replyFields(reply, marker, count) {
  remoteError(reply);
  const line = reply.split('\n').find((item) => item.startsWith(`-> ${marker}\t`));
  if (!line) throw new Error(`Gravity Circuit ${marker} reply was not recognized`);
  const fields = line.slice(3).split('\t');
  if (fields.length !== count) throw new Error(`Gravity Circuit ${marker} reply is incomplete`);
  return fields;
}

function parseInfoReply(reply) {
  const [, profile, baseHex] = replyFields(reply, 'GC_DUMP_INFO_V1', 3);
  if (!PROFILES.has(profile)) throw new Error(`Unsupported Gravity Circuit profile: ${profile}`);
  if (!/^0x[0-9a-f]+$/i.test(baseHex)) throw new Error('Invalid Gravity Circuit module base');
  const base = Number(BigInt(baseHex));
  if (!Number.isSafeInteger(base) || base <= 0 || base % 4096 !== 0) {
    throw new Error('Gravity Circuit module base is outside the supported address range');
  }
  return {profile, base, baseHex: `0x${base.toString(16)}`};
}

function chunkSource({module, profile, base, offset, count}) {
  const field = module === 'main' ? 'main_base' : 'sdk_base';
  if (!PROFILES.has(profile) || !Number.isSafeInteger(base) || !Number.isSafeInteger(offset) ||
      !Number.isInteger(count) || count < 1 || count > CHUNK_BYTES) {
    throw new TypeError('Invalid Gravity Circuit dump chunk');
  }
  return [
    'local info = LS and LS.nx_info',
    'if not info or LS.game_id ~= "gravity-circuit" or LS.state ~= "serving" then error("Gravity Circuit runtime unavailable") end',
    `local base = info.${field}`,
    `if info.profile ~= "${profile}" or base ~= ${base} then error("Gravity Circuit module changed during dump") end`,
    `local offset = ${offset}`,
    `local count = ${count}`,
    'local ffi = require("ffi")',
    'local bytes = ffi.string(ffi.cast("const char*", base + offset), count)',
    'local hex = {}',
    'for i = 1, count do hex[i] = ("%02x"):format(bytes:byte(i)) end',
    `return ("GC_DUMP_CHUNK_V1\\t%s\\t${module}\\t%d\\t%d\\t0x%x\\t%s"):format(info.profile, offset, count, base, table.concat(hex))`,
  ].join('\n');
}

function parseChunkReply(reply, {module, profile, baseHex, offset, count}) {
  const [marker, receivedProfile, receivedModule, receivedOffset, receivedCount, receivedBase, hex] =
    replyFields(reply, 'GC_DUMP_CHUNK_V1', 7);
  if (marker !== 'GC_DUMP_CHUNK_V1' || receivedProfile !== profile || receivedModule !== module ||
      receivedOffset !== String(offset) || receivedCount !== String(count) ||
      receivedBase.toLowerCase() !== baseHex) {
    throw new Error('Gravity Circuit dump chunk metadata changed');
  }
  if (hex.length !== count * 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('Gravity Circuit dump chunk has invalid hex data');
  }
  return Buffer.from(hex, 'hex');
}

async function writeAll(file, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(bytes, written, bytes.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Could not write the Gravity Circuit dump');
    written += result.bytesWritten;
  }
}

async function dumpModule({host, port = DEFAULT_PORT, module, length, output, timeoutMs = 15000,
  execute = executeLua, onProgress = () => {}}) {
  checkOptions({host, port, module, length, output, timeoutMs});
  const outputPath = path.resolve(output);
  const infoReply = await execute({host, port, source: infoSource(module), timeoutMs});
  const info = parseInfoReply(infoReply);
  const partialPath = path.join(path.dirname(outputPath),
    `.${path.basename(outputPath)}.${crypto.randomUUID()}.partial`);
  let file;
  let complete = false;
  const hash = crypto.createHash('sha256');
  try {
    file = await fs.open(partialPath, 'wx', 0o600);
    for (let offset = 0; offset < length; offset += CHUNK_BYTES) {
      const count = Math.min(CHUNK_BYTES, length - offset);
      const reply = await execute({host, port,
        source: chunkSource({module, profile: info.profile, base: info.base, offset, count}), timeoutMs});
      const bytes = parseChunkReply(reply, {module, profile: info.profile,
        baseHex: info.baseHex, offset, count});
      await writeAll(file, bytes, offset);
      hash.update(bytes);
      onProgress({bytes: offset + count, total: length});
    }
    await file.sync();
    await file.close();
    file = null;
    await fs.link(partialPath, outputPath);
    complete = true;
    return {module, profile: info.profile, base: info.baseHex, bytes: length,
      sha256: hash.digest('hex'), output: outputPath};
  } finally {
    if (file) await file.close();
    await fs.unlink(partialPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!complete) onProgress({failed: true, total: length});
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length < 4 || argv.length > 5) {
    process.stderr.write('usage: node dump-module.cjs <switch-ipv4> <main|sdk> <byte-length> <output-file> [port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const [host, module, lengthValue, output, portValue] = argv;
    const length = parseLength(lengthValue);
    const port = portValue === undefined ? DEFAULT_PORT : Number(portValue);
    const result = await dumpModule({host, module, length, output, port,
      onProgress: ({bytes, total}) => {
        if (bytes === total || bytes % (1024 * 1024) < CHUNK_BYTES) {
          process.stderr.write(`read ${bytes}/${total} bytes\n`);
        }
      }});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {MAX_DUMP_BYTES, CHUNK_BYTES, parseLength, infoSource, parseInfoReply,
  chunkSource, parseChunkReply, dumpModule};
