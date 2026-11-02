#!/usr/bin/env node
const path = require('node:path');
const { createInterface } = require('node:readline');
const { titleId, withCleanup } = require('./engine/protocol.cjs');
const { attachGame } = require('./engine/session.cjs');
const { discoverGames } = require('./engine/content.cjs');
const { prepareGame } = require('./engine/mounts.cjs');
const { dumpAllNcas } = require('./engine/nca-dump.cjs');
const { deployServer, readImage } = require('./engine/server.cjs');

const USAGE = 'Usage: node ouncecake.cjs <run-directory> [title-id] [--port 8080] [--base-only] [--nca [--out dir]]\n' +
              'Use the run dir given by ns2jb (Run folder: <whatever>)\n' +
              'You can also provide a title ID to skip the selection menu and just mount a specific game\n' +
              '--base-only serves base/exefs and base/romfs without preparing updates or DLC\n' +
              '--nca dumps the raw (encrypted) NCA file(s) to --out instead of serving romfs/exefs\n' +
              '--skip-program omits the Program NCA during --nca export\n';

function getArgs(argv) {
  const args = [];
  let port = 8080;
  let nca = false;
  let skipProgram = false;
  let baseOnly = false;
  let out = 'nca-dump';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help') {
      return { help: true };
    }

    if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Invalid --port value\n' + USAGE);
      }
      continue;
    }

    if (a === '--nca') {
      nca = true;
      continue;
    }

    if (a === '--base-only') {baseOnly = true; continue;}

    if (a === '--skip-program') {
      skipProgram = true;
      continue;
    }

    if (a === '--out') {
      out = argv[++i];
      if (!out) throw new Error('--out needs a directory\n' + USAGE);
      continue;
    }

    if (a.startsWith('--')) {
      throw new Error('Unknown option: ' + a + '\n' + USAGE);
    }

    args.push(a);
  }

  if (args.length < 1 || args.length > 2) {
    throw new Error(USAGE);
  }

  if (args.length === 1 && /^(?:0x)?[0-9a-fA-F]{16}$/.test(args[0])) {
    throw new Error('You need to add a run directory\n' + USAGE);
  }

  const title = args.length === 2 ? titleId(args[1]) : undefined;
  if (skipProgram && !nca) throw new Error('--skip-program requires --nca');
  if (baseOnly && nca) throw new Error('--base-only applies to file serving, not --nca');
  return { run: path.resolve(args[0]), title, port, nca, skipProgram, baseOnly, out: path.resolve(out) };
}

const storageNames = { 2: 'Game card', 4: 'Internal', 5: 'SD' };

function gameMenu(games) {
  const width = String(games.length).length;
  return games
    .map((game, i) => {
      const number = String(i + 1).padStart(width);
      const name = game.name || 'Unknown title';
      const storages = game.storages.map((id) => storageNames[id]).join(', ');
      return number + '. ' + name + '  [' + game.title.toUpperCase() + ']  (' + storages + ')';
    })
    .join('\n');
}

async function pickGame(games, signal) {
  const input = process.stdin;
  const output = process.stdout;

  if (!games.length) {
    throw new Error('No games were found. How did you even run this?');
  }

  output.write(gameMenu(games) + '\n');

  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const close = () => rl.close();
  rl.once('SIGINT', close);
  signal.addEventListener('abort', close, { once: true });

  const prompt = () => output.write('Choose a game: ');

  try {
    if (signal.aborted) return null;

    prompt();

    for await (const line of lines) {
      if (signal.aborted) return null;

      const value = line.trim();

      if (/^q(?:uit)?$/i.test(value)) return null;

      if (/^[0-9]+$/.test(value)) {
        const number = Number(value);

        if (Number.isSafeInteger(number) && number >= 1 && number <= games.length) return games[number - 1];
      }

      output.write('Enter a number from 1 to ' + games.length + ', or q.\n');
      prompt();
    }

    return null;
  } finally {
    signal.removeEventListener('abort', close);
    rl.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = getArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const image = await readImage();
  const { port, run } = options;
  let { title } = options;
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let attachment;
  let server;
  await withCleanup(async () => {
    attachment = await attachGame(run);
    const shouldStop = () => cancellation.signal.aborted;
    if (!title) {
      const selected = await pickGame(await discoverGames({ ...attachment, shouldStop }), cancellation.signal);
      if (!selected || shouldStop()) return;
      title = selected.title;
    }
    if (options.nca) {
      const results = await dumpAllNcas({ attachment, title, outDir: options.out, skipProgram: options.skipProgram, shouldStop });
      for (const r of results) console.log('Dumped: ' + r.name + ' -> ' + r.path + ' (' + r.size + ' bytes)');
      return;
    }
    const prepared = await prepareGame({ attachment, title, baseOnly: options.baseOnly, shouldStop });
    if (shouldStop()) return;
    server = await deployServer({ attachment, image, ...prepared, port });
    console.log('Serving on http://' + (server.address || '<console ip>') + ':' + port + '/ (HTTP + read-only WebDAV)');
    console.log('Ctrl-C to stop the server');
    
    while (!shouldStop()) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }, () => server?.close(), () => attachment?.close(), () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { getArgs, pickGame, main };
