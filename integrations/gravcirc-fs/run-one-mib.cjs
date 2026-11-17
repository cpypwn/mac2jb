const {main: run} = require('./run-canary.cjs');
const {parseOneShotSize} =
  require('../civswitch/fs-kit/port/engine/switch2/app/one-mib-transaction.cjs');

function main(values = process.argv.slice(2), dependencies = {}) {
  if (values.length < 2 || values.length > 4)
    throw Error('Usage: node run-one-mib.cjs <switch-ipv4> <mac-ipv4> [1m|2m|1m-split] [profile.json]');
  if (values[2] === '1m-split')
    return run([values[0], values[1], ...(values[3] ? [values[3]] : [])],
      dependencies, 'split-mib');
  const retrySize = parseOneShotSize(values[2]);
  return run([values[0], values[1], ...(values[3] ? [values[3]] : [])],
    {...dependencies, retrySize}, 'one-mib');
}

module.exports = {main};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
