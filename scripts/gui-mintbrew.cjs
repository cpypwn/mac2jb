#!/usr/bin/env node
'use strict';
const homebrew=require('./gui-homebrew.cjs');
async function main(args=process.argv.slice(2),options={}) {
  const stremio=require('./gui-stremio.cjs');
  const input=options.config??(options.root?{}:await stremio.configuration());
  const config={...stremio.playerConfiguration(input),
    quality:require('../stremio/quality.cjs').qualityProfile(input.quality).id};
  return homebrew.main(args,{...options,application:'mintbrew',config});
}
module.exports={main};
if(require.main===module)main().catch(error=>{
  if(!error.homebrewReported)try{
    process.stdout.write('MAC2JB_HOMEBREW '+JSON.stringify({type:'failed',
      message:error.message+' This launch was not retried. Finish RPC and restart the console.'})+'\n');
  }catch{}
  process.exitCode=1;
});
