#!/usr/bin/env node
'use strict';
const homebrew=require('./gui-homebrew.cjs');
function main(args=process.argv.slice(2),options={}) {
  if(args.length!==3||!['--app-folder','--launcher-folder','--rpc-folder'].includes(args[1]))
    throw Error('Usage: gui-custom-homebrew.cjs RUN_DIRECTORY --app-folder|--launcher-folder|--rpc-folder FOLDER');
  if(args[1]==='--rpc-folder')return require('./custom-rpc-package.cjs').main([args[0],args[2]],options);
  return homebrew.main([args[0]],{...options,application:'custom-homebrew',
    customHomebrewKind:args[1]==='--launcher-folder'?'launcher':'gpu-app',
    customHomebrewPath:args[2]});
}
module.exports={main};
if(require.main===module)main().catch(error=>{
  if(!error.homebrewReported)try{
    process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',
      message:error.message+' This launch was not retried. Finish RPC and restart the console.'})+'\n');
  }catch{}
  process.exitCode=1;
});
