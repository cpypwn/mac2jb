const fs = require('node:fs');
const path = require('node:path');
const { executeLua, DEFAULT_PORT } = require('./repl-client.cjs');

const SOURCE = fs.readFileSync(path.join(__dirname, 'probe.lua'), 'utf8');
const KNOWN_PROFILES = new Set([
  'gravity-circuit-v1.0',
  'gravity-circuit-v1.2.1',
]);

function parseReply(reply) {
  if (typeof reply !== 'string') throw new TypeError('reply must be text');
  if (/^(?:compile error:|error:)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const line = reply.trimEnd().split('\n').find((item) => item.startsWith('-> GC_PROBE_V1\t'));
  if (!line) throw new Error('Gravity Circuit probe reply was not recognized');
  const fields = line.slice(3).split('\t');
  if (fields.length === 2 && fields[1] === 'missing-runtime') {
    throw new Error('Gravity Circuit launcher runtime is unavailable');
  }
  if (fields.length !== 8) throw new Error('Gravity Circuit probe reply is incomplete');
  const [, gameId, gameName, state, jitOs, nativeProfile, ip, bridgeStage] = fields;
  const recognizedGame = gameId === 'gravity-circuit';
  const recognizedProfile = KNOWN_PROFILES.has(nativeProfile);
  const runtimeReady = recognizedGame && state === 'serving' && recognizedProfile;
  return {
    gameId,
    gameName,
    state,
    jitOs,
    nativeProfile: nativeProfile || null,
    ip: ip || null,
    recognizedGame,
    recognizedProfile,
    runtimeReady,
    fsBridgeReady: runtimeReady && ['accept', 'send-hello', 'read-request', 'send-response'].includes(bridgeStage),
  };
}

async function probe({ host, port = DEFAULT_PORT, timeoutMs = 15000 }) {
  const reply = await executeLua({ host, port, source: SOURCE, timeoutMs });
  return parseReply(reply);
}

async function main() {
  const host = process.argv[2];
  if (!host) {
    process.stderr.write('usage: node probe.cjs <switch-ipv4> [port]\n');
    process.exitCode = 2;
    return;
  }
  const port = process.argv[3] === undefined ? DEFAULT_PORT : Number(process.argv[3]);
  try {
    const result = await probe({ host, port });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { SOURCE, parseReply, probe };
