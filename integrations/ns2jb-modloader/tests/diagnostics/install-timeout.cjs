'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const repo=path.resolve(__dirname,'../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'install-timeout-')),run=path.join(root,'switch2-timeouttest'),directory=path.join(root,'state',path.basename(run));
fs.copyFileSync(path.join(repo,'install.cjs'),path.join(root,'install.cjs'));fs.symlinkSync(path.join(repo,'lib'),path.join(root,'lib'),'dir');
fs.rmSync(run,{recursive:true,force:true});fs.rmSync(directory,{recursive:true,force:true});fs.mkdirSync(path.join(run,'switch2'),{recursive:true});
fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({verified:true,rpc:{state:'listening'},completed:false}));fs.writeFileSync(path.join(run,'switch2/fs-execution-current.json'),JSON.stringify({verified:true,file:'proof.json'}));fs.writeFileSync(path.join(run,'proof.json'),JSON.stringify({verified:true,session:path.basename(run)}));
fs.writeFileSync(path.join(run,'connection.json'),JSON.stringify({addresses:{session:path.basename(run),target:'switch2'}}));
let closed=0,released=0,reports=0;const client={pending:false,record:{closed:false},close:async()=>{closed++;}},bootstrap={bridge:{c:client},transferred:false,release:async()=>{released++;}};
function mock(name,exports){const id=require.resolve(name);require(id);require.cache[id].exports=exports;}
mock('../../lib/native-capture.cjs',{captureNative:async(run,dir)=>{fs.mkdirSync(path.join(dir,'native-fs'),{recursive:true});fs.writeFileSync(path.join(dir,'native-fs/manifest.json'),JSON.stringify({sha256:'test',validatedRanges:[]}));return{file:'unused',client};}});
mock('../../lib/sd-mods.cjs',{collectSdMods:async()=>({games:[],patches:[],bootstrap})});
const diagnostics=require('../../lib/diagnostics.cjs');mock('../../lib/diagnostics.cjs',{...diagnostics,writeReport:async()=>{reports++;throw Error('Console response timed out; restart the application');}});
(async()=>{try{
 await assert.rejects(require(path.join(root,'install.cjs')).main(['--run-dir',run]),/Console response timed out/);assert.equal(reports,1);assert.equal(closed,0);assert.equal(released,0);assert(client.pending);
 const status=JSON.parse(fs.readFileSync(path.join(run,'ns2jb-modloader-install.json')));assert.equal(status.status,'stopped');
 const log=fs.readdirSync(path.join(root,'logs')).find(n=>n.endsWith('switch2-timeouttest.install.json'));const report=JSON.parse(fs.readFileSync(path.join(root,'logs',log)));assert.equal(report.stage,'creating SD reports');assert.equal(report.requiresInspectionOrReboot,true);fs.unlinkSync(path.join(root,'logs',log));
 console.log('Installer timeout retains its exact stage and does not continue, replay or clean up uncertain native requests: passed');
}finally{fs.rmSync(run,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e.stack);process.exitCode=1;});
