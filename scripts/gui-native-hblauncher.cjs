#!/usr/bin/env node
'use strict';
process.umask(0o077);
if (!process.env.NS2_RPC_TIMEOUT_MS) process.env.NS2_RPC_TIMEOUT_MS = '86400000';
const {main} = require('../integrations/mintbrew-native/host.cjs');

module.exports = {main};

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  if (error.homebrewReported) {process.exitCode = 1; return;}
  try {
    process.stdout.write('MAC2JB_HOMEBREW ' + JSON.stringify({type: 'failed',
      cleanupBlocked: false, retrySafe: true, message: error.message}) + '\n');
  } catch {}
  process.exitCode = 1;
});
