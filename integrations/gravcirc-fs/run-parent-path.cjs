// One short-path semantic control through the existing 512 KiB app-only runner.
process.env.NS2_GC_PARENT_PATH_SEMANTICS = '1';
require('./run-canary.cjs').main(process.argv.slice(2), {}, 'app')
  .catch(error => {console.error(error.stack); process.exitCode = 1;});
