'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'setup-report-'));try{
 const {start}=require('../../lib/setup-diagnostics.cjs');let last;
 for(let i=0;i<6;i++){const t=start(root,'switch2-test'+i,'checkpoint.2');t.mark('activating resident runtime');t.finish(i===5?Error('Console response timed out'):null,{nativeOperation:{label:'activate-resident-mods',status:'awaiting-native-reply'}});last=t.file;}
 assert.equal(fs.readdirSync(path.join(root,'logs')).length,3);const result=JSON.parse(fs.readFileSync(last));assert.equal(result.stage,'activating resident runtime');assert.equal(result.status,'stopped');assert.match(result.error,/timed out/);assert.equal(result.nativeOperation.status,'awaiting-native-reply');
 const mismatch=Object.assign(Error('Unsupported FS function layout'),{fsCompatibility:{stage:'native-functions',mismatches:[{offset:0x24a000,actual:'observed',sha256:'expected'}]}});
 const compatibility=start(root,'switch2-layout','release-candidate');compatibility.mark('qualifying FS runtime');compatibility.finish(mismatch);
 assert.deepEqual(JSON.parse(fs.readFileSync(compatibility.file)).fsCompatibility,mismatch.fsCompatibility);
 const diagnostic=require('../../lib/diagnostics.cjs').report({session:'switch2-layout',sdPath:'/ns2jb-modloader/logs/20261106T000000Z-switch2-layout.log',error:mismatch,status:'stopped'});
 assert(diagnostic.buffer.includes(Buffer.from('FS compatibility: '+JSON.stringify(mismatch.fsCompatibility))));
 const blocked=path.join(root,'blocked');fs.writeFileSync(blocked,'file');const warn=console.warn;console.warn=()=>{};try{const t=start(blocked,'switch2-safe','checkpoint.2');t.mark('reading');t.finish(null);}finally{console.warn=warn;}
 console.log('Automatic PC setup stages, pending-operation detail, bounded rotation and nonfatal reporting failure: passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
