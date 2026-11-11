#!/usr/bin/env node
'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
for(const file of ['retained-trace','setup-report','report-files','install-timeout','reader','runtime-io-control','fs-compatibility','sd-patch-inputs','uncertain-session']){
 const result=spawnSync(process.execPath,[path.join(__dirname,'../tests/diagnostics',file+'.cjs')],{stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
