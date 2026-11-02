const fs = require('node:fs/promises'), path = require('node:path'), net = require('node:net');
const {readJson} = require('../../core/session/ledger.cjs');
async function discover({root = path.resolve(__dirname, '../..'), settings = {},
  preflight = require('../../modules/iz-exchange/server/games.cjs').preflight,
  findSession = require('../dolphin-fs-rpc/library.cjs').findSession} = {}) {
  const roots = new Set();
  for (let current = root, n = 0; n < 5; n++, current = path.dirname(current)) {
    roots.add(current); roots.add(path.join(current, 'ns2jb2')); roots.add(path.join(current, 'ns2jb')); roots.add(path.join(current, 'iz2s-platform-run20'));
    roots.add(path.join(current, 'ns2jb/iz2s-platform-run20'));
    if (path.dirname(current) === current) break;
  }
  if (process.env.NS2_RUN20_ROOT) roots.add(path.resolve(process.env.NS2_RUN20_ROOT));
  async function qualified(value) {
    const run = await fs.realpath(value), proof = await readJson(path.join(run, 'switch2/fs-execution-current.json'), {});
    const connection = await readJson(path.join(run, 'connection.json'), {}), session = connection.addresses?.session;
    if (session && proof.session === session && proof.verified && proof.restored && proof.cleanup?.deferred &&
        proof.retainedEndpoint?.ready && proof.retainedEndpoint.session === session && (await preflight(run)).ready) return run;
    return null;
  }
  const host = net.isIPv4(settings.host || '') ? settings.host : '';
  if (path.isAbsolute(settings.run || '')) {
    try {const run = await qualified(settings.run); if (run) return {run, host, source: 'saved'};} catch {}
    roots.add(path.resolve(settings.run, '../../../..'));
    roots.add(path.resolve(settings.run, '../..'));
  }
  const nearby = [];
  for (const candidate of roots) {
    try {
      const directory = path.join(candidate, 'runs');
      const entries = await fs.readdir(directory, {withFileTypes: true});
      for (const entry of entries.filter(entry => entry.isDirectory() && entry.name.startsWith('switch2-')).slice(0, 200)) {
        const run = path.join(directory, entry.name);
        try {const stat = await fs.stat(path.join(run, 'switch2/fs-execution-current.json')); nearby.push({run, at: stat.mtimeMs});} catch {}
      }
    } catch {}
  }
  const seen = new Set();
  for (const candidate of nearby.sort((a, b) => b.at - a.at).slice(0, 20)) {
    if (seen.has(candidate.run)) continue; seen.add(candidate.run);
    try {const run = await qualified(candidate.run); if (run) return {run, host, source: 'detected'};} catch {}
  }
  for (const candidate of roots) {
    try {
      await fs.access(path.join(candidate, 'data/state/attempts'));
      // Explicitly select RUN20 discovery, independent of standalone mode.
      const selected = await findSession(candidate, preflight, {standalone: false});
      return {run: selected.run, host: selected.host, source: 'detected'};
    } catch {}
  }
  throw Error('No active FS RPC session found. Start ns2jb2 or ns2jb with --rpc, or open Connection settings and select the held run folder and console IPv4.');
}
module.exports = {discover};
