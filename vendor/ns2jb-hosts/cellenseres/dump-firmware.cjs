#!/usr/bin/env node
// Run the regular exploit, then opt in to read-only system-program CodeFS
// capture before the upstream runner closes its SmileBASIC-backed RPC.
async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node dump-firmware.cjs [computer-IP]\n' +
      '       node dump-firmware.cjs --fs-only <held-run-directory> [--out <new-directory>] [--plan-only]\n' +
      'Default: launches a fresh exploit and captures NCM system-program CodeFS.\n' +
      '--fs-only: attaches to the held run and exports native FS code/RO/data as an ELF memory snapshot.\n' +
      'See README.md for scope and prerequisites.');
    return;
  }
  if (args.includes('--fs-only')) return require('./engine/switch2/fs-process-dump.cjs').main(args);
  return require('./run.cjs').main(['--dump-firmware', ...args]);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = {main};
