const fs = require('node:fs');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {probeDomainLive} = require('./probe-domain-live.cjs');
const {matchingBoot, validateEvidence} = require('./clone-control.cjs');
const {runMarkerPathInspect} = require('./marker-path-control.cjs');

const MARKER = 'BAL_CLONE_SCAN_V1';
const MAX_MARKERS = 16;
const NAME = /^bal-marker-([0-9a-f]{16})\.bin$/;

function makeScanSource() {
  return [
    'local b=BL',
    `local tag=${JSON.stringify(MARKER)}`,
    "if not (b and b.state=='serving' and b.info and b.info.version=='1.0.1f-FULL') then return tag..'\\tfail\\tidentity' end",
    "if not (love and love.filesystem and type(love.filesystem.getDirectoryItems)=='function') then return tag..'\\tfail\\tlisting-unavailable' end",
    "local ok,items=pcall(love.filesystem.getDirectoryItems,'')",
    "if not ok or type(items)~='table' then return tag..'\\tfail\\tlisting-failed' end",
    'local matches={}',
    "for _,name in ipairs(items) do if type(name)=='string' and name:match('^bal%-marker%-%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%x%.bin$') then",
    "if #matches>=16 then return tag..'\\tfail\\ttoo-many-markers' end",
    'matches[#matches+1]=name end end',
    'table.sort(matches)',
    "return tag..'\\tok\\t'..table.concat(matches,',')",
  ].join('\n');
}

function parseScanReply(reply) {
  if (typeof reply !== 'string') throw new TypeError('Balatro scan reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const lines = reply.split('\n').map(line => line.replace(/\r$/, ''))
    .filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw new Error('Balatro scan reply is missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields.length !== 3 || fields[0] !== MARKER) {
    throw new Error('Balatro scan reply is malformed');
  }
  if (fields[1] === 'fail' && /^[a-z-]+$/.test(fields[2])) {
    throw new Error(`Balatro read-only scan unavailable: ${fields[2]}`);
  }
  if (fields[1] !== 'ok') throw new Error('Balatro scan did not complete');
  if (fields[2] === '') return [];
  const names = fields[2].split(',');
  if (names.length > MAX_MARKERS || names.some(name => !NAME.test(name)) ||
      new Set(names).size !== names.length ||
      names.some((name, index) => index > 0 && name <= names[index - 1])) {
    throw new Error('Balatro scan returned unexpected marker names');
  }
  return names.map(name => NAME.exec(name)[1]);
}

async function runRecoveryReadOnly({host, evidence, probe = probeDomainLive,
  execute = executeLua, inspect = runMarkerPathInspect,
  onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || typeof probe !== 'function' ||
      typeof execute !== 'function' || typeof inspect !== 'function' ||
      typeof onPhase !== 'function') {
    throw new TypeError('Balatro recovery needs an IPv4 host and read-only dependencies');
  }
  validateEvidence(evidence);
  onPhase('recovery: verify same-boot mounted domain');
  matchingBoot(evidence, await probe({host, nonceBytes: () => Buffer.from(evidence.nonce, 'hex')}));
  onPhase('recovery: list nonce-owned marker paths');
  const nonces = parseScanReply(await execute({host, port: 9026,
    source: makeScanSource(), timeoutMs: 15000}));
  const markers = [];
  for (const nonce of nonces) {
    onPhase(`recovery: inspect marker ${nonce}`);
    const result = await inspect({host, nonce, execute});
    if (result.nonce !== nonce || result.absentResult !== evidence.absentPathResult) {
      throw new Error('Balatro marker inspection disagrees with pinned evidence');
    }
    markers.push({nonce, marker: result.marker,
      entryResult: result.entryResult, fileType: result.fileType,
      fileSize: result.fileSize, openResult: result.openResult});
  }
  return {gameProfile: evidence.gameProfile, sdkBase: evidence.sdkBase,
    status: 'read-only; no marker changed', markers};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || net.isIP(argv[0]) !== 4) {
    process.stderr.write('usage: node clone-recovery-readonly.cjs <switch-ipv4> <same-boot-evidence.json>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const evidence = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
    const result = await runRecoveryReadOnly({host: argv[0], evidence,
      onPhase: phase => process.stderr.write(`phase: ${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {MARKER, MAX_MARKERS, makeScanSource, parseScanReply,
  runRecoveryReadOnly, main};
if (require.main === module) main();
