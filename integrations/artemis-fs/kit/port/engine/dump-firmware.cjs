#!/usr/bin/env node
// Run the regular exploit, then opt in to read-only system-program CodeFS
// capture before the runner closes its application-backed RPC.
if (process.argv[2] === '--help') {
  console.log('Usage: node engine/dump-firmware.cjs [--target civ7|smilebasic] [computer-IP]\n' +
    'This launches the exploit first. See README-ENGINE.md for scope and safety notes.');
} else {
  require('./run.cjs').main(['--dump-firmware', ...process.argv.slice(2)]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
