const {main: run} = require('./run-canary.cjs');

async function main(values = process.argv.slice(2), dependencies = {}) {
  const previous = process.env.NS2_APP_STORAGE_PROBE;
  process.env.NS2_APP_STORAGE_PROBE = '1';
  try {return await run(values, dependencies, 'app');}
  finally {
    if (previous === undefined) delete process.env.NS2_APP_STORAGE_PROBE;
    else process.env.NS2_APP_STORAGE_PROBE = previous;
  }
}

module.exports = {main};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
