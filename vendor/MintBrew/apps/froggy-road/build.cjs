#!/usr/bin/env node
// Build this standalone app package with the shared HBLauncher SDK.
const fs = require('node:fs');
const path = require('node:path');

function findSdk() {
  if (process.env.HB_SDK) return path.resolve(process.env.HB_SDK);
  const candidates = [
    path.resolve(__dirname, '../../sdk'), // inside the launcher's apps/ folder
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'build.cjs'))) return candidate;
  }
  throw new Error('Cannot find the HBLauncher sdk folder. Set HB_SDK=/path/to/HBLauncher/sdk.');
}

async function main() {
  const sdk = findSdk();
  const { buildApp } = require(path.join(sdk, 'build.cjs'));
  await buildApp(__dirname);
  console.log('Built Froggy Road shaders.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
