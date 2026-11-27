#!/usr/bin/env node
'use strict';
const {main} = require('./gui-homebrew.cjs');
if (require.main === module) {
  main(process.argv.slice(2), {application: 'mintbrew'}).catch(error => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
module.exports = {main};
