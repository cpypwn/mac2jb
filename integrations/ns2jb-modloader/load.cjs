#!/usr/bin/env node
'use strict';
// Uses the standard ns2jb host as-is; no hooks, subprocess or host changes.
const {main}=require('./install.cjs');
if(require.main===module)main(['--sd',...process.argv.slice(2)]).catch(error=>{console.error('LOAD STOPPED: '+error.message);process.exitCode=1;});
