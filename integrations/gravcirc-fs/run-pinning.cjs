const {main: run} = require('./run-canary.cjs');

async function main(values = process.argv.slice(2), dependencies = {}) {
  const previous = process.env.NS2_GC_PINNING_PROBE;
  process.env.NS2_GC_PINNING_PROBE = '1';
  try {
    return await (dependencies.run || run)(values, dependencies, 'app');
  } finally {
    if (previous === undefined) delete process.env.NS2_GC_PINNING_PROBE;
    else process.env.NS2_GC_PINNING_PROBE = previous;
  }
}

module.exports = {main};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
