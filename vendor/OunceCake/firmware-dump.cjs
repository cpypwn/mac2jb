#!/usr/bin/env node
const path = require('node:path');
const { withCleanup } = require('./engine/protocol.cjs');
const { attachGame } = require('./engine/session.cjs');
const { dumpFirmware } = require('./engine/firmware.cjs');

// CLI entry point for the firmware dumper. Attaches to a kurumuz --rpc hold
// session already produced by ns2jb and asks the held Loader root for
// SystemProgram ExeFS/RomFS and SystemData RomFS archives.

const USAGE =
  'Usage: node firmware-dump.cjs <run-directory> [options]\n' +
  '\n' +
  'Options:\n' +
  '  --out <dir>         Output directory (default: <run>/firmware-dump).\n' +
  '  --titles <csv>      Comma-separated 16-hex-digit title IDs to limit the sweep.\n' +
  '  --include-programs  Dump SystemProgram titles only.\n' +
  '  --include-data      Dump SystemData titles only.\n' +
  '  --help              Show this message.\n' +
  '\n' +
  'By default both SystemProgram and SystemData are dumped. Specifying one of\n' +
  '--include-programs / --include-data narrows the sweep to that kind.\n';

/// Validate a 16-hex-digit title ID string.
function normalizeTitle(value) {
  if (!/^[0-9a-fA-F]{16}$/.test(value)) {
    throw new Error('Invalid title ID (expected 16 hex digits): ' + value);
  }
  return value.toLowerCase();
}

/// Parse the command-line arguments into an options object.
function getArgs(argv) {
  const out = { titles: [], includePrograms: null, includeData: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--help' || a === '-h') return { help: true };

    if (a === '--out') {
      out.outDir = argv[++i];

      if (!out.outDir) throw new Error('--out requires a directory\n' + USAGE);

      continue;
    }

    if (a === '--titles') {
      const csv = argv[++i];

      if (!csv) throw new Error('--titles requires a comma-separated list\n' + USAGE);

      for (const value of csv.split(',').map((s) => s.trim()).filter(Boolean)) {
        out.titles.push(normalizeTitle(value));
      }
      continue;
    }

    if (a === '--include-programs') { out.includePrograms = true; continue; }
    if (a === '--include-data') { out.includeData = true; continue; }

    if (a.startsWith('--')) throw new Error('Unknown option: ' + a + '\n' + USAGE);

    positional.push(a);
  }

  if (positional.length !== 1) throw new Error(USAGE);

  out.run = path.resolve(positional[0]);

  // If neither --include-* was passed, dump both. If only one was passed,
  // restrict to that kind.
  if (out.includePrograms === null && out.includeData === null) {
    out.includePrograms = true;
    out.includeData = true;
  } else {
    out.includePrograms = out.includePrograms === true;
    out.includeData = out.includeData === true;
  }

  return out;
}

async function main(argv = process.argv.slice(2)) {
  const options = getArgs(argv);

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(options.run, 'firmware-dump');

  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let attachment;

  await withCleanup(async () => {
    attachment = await attachGame(options.run);
    const shouldStop = () => cancellation.signal.aborted;

    console.log('Firmware dump target: ' + outDir);

    await dumpFirmware({
      attachment,
      outDir,
      titles: options.titles,
      includePrograms: options.includePrograms,
      includeData: options.includeData,
      shouldStop,
    });

    console.log('Done.');
  }, () => attachment?.close(), () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { getArgs, main };
