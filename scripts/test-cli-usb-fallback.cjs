'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('CLI automatic USB selection skips an absent drd2 before trying drd3', t => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'mac2jb.command'), 'utf8');
  const begin = source.indexOf('choose_controller() {');
  const end = source.indexOf('\nif [[ "$mode" == 1 ]]', begin);
  assert.ok(begin >= 0 && end > begin);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-cli-usb-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const helper = path.join(folder, 'helper.sh');
  const attempts = path.join(folder, 'attempts.txt');
  fs.writeFileSync(helper, `#!/bin/bash
printf '%s\\n' "$MAC2JB_CONTROLLER" >> "$MAC2JB_TEST_ATTEMPTS"
if [[ "$MAC2JB_CONTROLLER" == usb-drd3 ]]; then
  echo 'Keyboard enumerated. Sending...'
  exit 0
fi
echo 'libusbd_init failed; check usbgadget.kext.'
exit 1
`);
  fs.chmodSync(helper, 0o700);
  const script = `set -euo pipefail
controller=auto
auto_timeout=1
manual_timeout=1
attempt_log="$(mktemp "${folder}/attempt.XXXXXX")"
trap 'rm -f "$attempt_log"' EXIT
${source.slice(begin, end)}
run_hid 'Sending bootstrap' '${helper}'
`;
  const result = spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8', env: {...process.env, MAC2JB_TEST_ATTEMPTS: attempts}, timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(fs.readFileSync(attempts, 'utf8').trim().split('\n'),
    ['usb-drd0', 'usb-drd1', 'usb-drd2', 'usb-drd3']);
});
