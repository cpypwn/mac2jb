const {main} = require('./run-canary.cjs');

main(process.argv.slice(2), {}, 'geometry').catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
