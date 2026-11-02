require('./tools/fs-rpc-browser/start.cjs').main().catch(e=>{console.error(e.message);process.exitCode=1;});
