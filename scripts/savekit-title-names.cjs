'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');
const titlePattern = /^[a-f0-9]{16}$/;

function check(value, message) { if (!value) throw Error(message); }

function cleanName(value) {
  if (typeof value !== 'string') return '';
  let name = '';
  for (const character of value.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()) {
    if (Buffer.byteLength(name + character, 'utf8') > 160) break;
    name += character;
  }
  return name.trim();
}

function namesFromGames(games) {
  check(Array.isArray(games) && games.length <= 2048, 'The game name list exceeds its limit.');
  const names = [], ids = new Set();
  for (const game of games) {
    const titleId = typeof game?.title === 'string' ? game.title.toLowerCase() : '';
    check(titlePattern.test(titleId) && !ids.has(titleId), 'The game name list contains an invalid title ID.');
    ids.add(titleId);
    const name = cleanName(game.name);
    if (name) names.push({titleId, name});
  }
  check(Buffer.byteLength(JSON.stringify(names), 'utf8') <= 512 * 1024,
    'The game name list exceeds its output limit.');
  return names;
}

function nameServiceUnavailable(error) {
  const message = String(error?.message || '');
  return message === 'Service unavailable: ns:am2' ||
    message === 'Service unavailable: ns:ro' ||
    /^SM could not open ns:(?:ro|am2): 0x615$/.test(message) ||
    message.startsWith('Open read-only application names: result 0x') &&
      error?.nativeResult?.canonical === 0x615;
}

async function lookup(runDirectory, options = {}) {
  const projectRoot = options.root || root;
  const ouncecake = options.ouncecake || require('./gui-ouncecake.cjs');
  const validateRun = options.validateRun || require('./gui-homebrew.cjs').validateRun;
  const verifiedSession = options.verifiedSession || require('./gui-dump.cjs').verifiedSession;
  const session = options.session || require(path.join(projectRoot, 'vendor/OunceCake/engine/session.cjs'));
  const content = options.content || require(path.join(projectRoot, 'vendor/OunceCake/engine/content.cjs'));
  await ouncecake.verifySnapshot(projectRoot);
  const run = await validateRun(projectRoot, runDirectory, verifiedSession);
  await ouncecake.validateAttachment(run);
  let attachment, names, failure;
  let cleanupConfirmed = false;
  try {
    attachment = await session.attachGame(run.directory);
    check(attachment?.live?.session === run.proof.session,
      'The title list attached to a different held session.');
    names = namesFromGames(await content.discoverGames({...attachment, shouldStop: () => false}));
  } catch (error) {
    failure = error;
  } finally {
    if (attachment) {
      try {
        await attachment.close();
        cleanupConfirmed = true;
      } catch (error) {
        failure = failure ? new AggregateError([failure, error],
          'Title name lookup and native cleanup both failed.') : error;
      }
    }
  }
  if (failure && cleanupConfirmed && nameServiceUnavailable(failure)) return [];
  if (failure) throw failure;
  check(cleanupConfirmed, 'Title name lookup did not confirm native cleanup.');
  return names;
}

async function main(args = process.argv.slice(2), options = {}) {
  check(args.length === 1 && path.isAbsolute(args[0]),
    'Usage: savekit-title-names.cjs RUN_DIRECTORY');
  const titles = await lookup(args[0], options);
  const write = options.write || (line => process.stdout.write(line + '\n'));
  write('MAC2JB_TITLE_NAMES ' + JSON.stringify({cleanupConfirmed: true, titles}));
  return titles;
}

module.exports = {cleanName, namesFromGames, nameServiceUnavailable, lookup, main};
if (require.main === module)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
