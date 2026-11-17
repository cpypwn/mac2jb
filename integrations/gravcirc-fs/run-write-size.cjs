const {main: run} = require('./run-canary.cjs');

function main(values = process.argv.slice(2), dependencies = {}) {
  return run(values, dependencies, 'write-size');
}

module.exports = {main};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
