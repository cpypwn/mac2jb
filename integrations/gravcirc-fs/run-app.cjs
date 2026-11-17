const {main} = require('./run-canary.cjs');

if (require.main === module)
  main(process.argv.slice(2), {}, 'app').catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
