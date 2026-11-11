'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const repo=path.resolve(__dirname,'../..'),root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-io-control-'));
fs.copyFileSync(path.join(repo,'install.cjs'),path.join(root,'install.cjs'));fs.symlinkSync(path.join(repo,'lib'),path.join(root,'lib'),'dir');
function mock(name,exports){const id=require.resolve(name);require(id);require.cache[id].exports=exports;}
let sdReports=0,installs=0,fail=false,mode='off',loggingCompatible=true;
const client={pending:false,record:{closed:false},close:async()=>{}},bootstrap={bridge:{c:client},transferred:false,release:async()=>{}};
const diagnostics=require('../../lib/diagnostics.cjs');assert.equal(require('../../install.cjs').options([]).runtimeLogs,true);assert.equal(require('../../install.cjs').options(['--no-runtime-logs']).runtimeLogs,false);
assert.equal(require('../../install.cjs').options([]).runtimeTrace,false);assert.equal(require('../../install.cjs').options(['--runtime-trace']).runtimeTrace,true);
assert.throws(()=>require('../../install.cjs').options(['--runtime-trace','--no-runtime-logs']),/cannot be combined/);
assert.throws(()=>require('../../install.cjs').options(['--no-runtime-logs','--runtime-trace']),/cannot be combined/);
mock('../../lib/diagnostics.cjs',{...diagnostics,writeReport:async(run,report)=>{sdReports++;assert.notEqual(mode,'off');assert.equal(!!report.tracePath,mode==='trace');return report;}});
mock('../../lib/native-capture.cjs',{captureNative:async(run,dir)=>{fs.mkdirSync(path.join(dir,'native-fs'),{recursive:true});fs.writeFileSync(path.join(dir,'native-fs/manifest.json'),JSON.stringify({sha256:'test',validatedRanges:[],runtimeLoggingCompatible:loggingCompatible}));return{file:'unused',client};}});
mock('../../lib/sd-mods.cjs',{collectSdMods:async()=>({games:[{titleId:'04006e001823c001',romfs:[{path:'/UNION/Content/Paks/test_P.pak',type:'file',sdPath:'/ns2jb-modloader/contents/04006e001823c001/romfs/UNION/Content/Paks/test_P.pak',size:136688}],exefs:[],stubs:[]}],patches:[],bootstrap})});
const native={sdk:{original:Object.fromEntries(['fileRead','fileSize','fileRelease','filesystemRelease','storageRelease','directoryRead','directoryCount','directoryRelease'].map((name,i)=>[name,0x1000+i*16]))},namespace:{original:{open:0x2000,directory:0x2010,type:0x2020}},originalSize:0x3000,lazy:{original:{current:0x4000,program:0x4010,data:0x4020}}};
mock('../../lib/native.cjs',{buildAll:async()=>native});
mock('../../lib/resident.cjs',{install:async(run,plan)=>{
 installs++;assert.equal(plan.runtimeDiagnostics,mode!=='off');assert.equal(!!plan.diagnostics,mode!=='off');assert.equal(plan.runtimeTrace,mode==='trace');assert.equal(plan.lazyGames[0].files[0].size,136688);
 const {layout,buildContext}=require('../../lib/lazy-context.cjs'),l=layout(plan);
 const source={filesystem:{object:0x6100001000n},registry:0x6100003000n,...(mode!=='off'?{logFile:{object:0x6100002000n,write:0x4000105000n,flush:0x4000105300n,setSize:0x4000105380n}}:{}),...(mode==='trace'?{traceFile:{object:0x6100004000n}}:{})};
 const context=buildContext(plan,source,0x4000000000n,0x6000000000n,native);
 if(mode==='off')for(const at of [160,168,176,184,192,272,l.lazyOffset+104,l.lazyOffset+112,l.lazyOffset+120,l.lazyOffset+136,l.lazyOffset+168])assert.equal(context.readBigUInt64LE(at),0n,'Diagnostic pointer at '+at);
 else{assert.equal(context.readBigUInt64LE(160),source.logFile.object);assert(context.readBigUInt64LE(l.lazyOffset+136));assert.equal(context.readBigUInt64LE(l.lazyOffset+120),BigInt(1024*1024-(mode==='trace'?40960:0)));}
 assert.equal(context.readBigUInt64LE(l.lazyOffset+168)!==0n,mode==='trace');assert.equal(context.readUInt32LE(l.filesOffset+44),mode==='trace'?1:0);
 assert.equal(context.readBigUInt64LE(40),0x6100001000n);assert.equal(context.readBigUInt64LE(l.gamesOffset),0x04006e001823c001n);
 if(fail)throw Error('Simulated resident failure');return{verified:true};
}});
async function run(session,automatic=false){
 const run=path.join(root,session);fs.mkdirSync(path.join(run,'switch2'),{recursive:true});
 fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({verified:true,rpc:{state:'listening'},completed:false}));
 fs.writeFileSync(path.join(run,'connection.json'),JSON.stringify({addresses:{session,target:'switch2'}}));
 fs.writeFileSync(path.join(run,'switch2/fs-execution-current.json'),JSON.stringify({verified:true,file:'proof.json'}));fs.writeFileSync(path.join(run,'proof.json'),JSON.stringify({verified:true,session}));
 return require(path.join(root,'install.cjs')).main(['--run-dir',run,'--keep-rpc',...(mode==='off'&&!automatic?['--no-runtime-logs']:mode==='trace'?['--runtime-trace']:[])]);
}
(async()=>{try{
 await run('switch2-controlok');fail=true;await assert.rejects(run('switch2-controlfailure'),/Simulated resident failure/);
 assert.equal(installs,2);assert.equal(sdReports,0);
 const failedLogs=fs.readdirSync(path.join(root,'logs')).map(n=>JSON.parse(fs.readFileSync(path.join(root,'logs',n))));assert(failedLogs.some(log=>log.status==='stopped'));
 fail=false;mode='normal';await run('switch2-normal');mode='trace';await run('switch2-trace');assert.equal(installs,4);assert.equal(sdReports,2);
 mode='off';loggingCompatible=false;await run('switch2-loggervariant',true);assert.equal(installs,5);assert.equal(sdReports,2);
 const logs=fs.readdirSync(path.join(root,'logs')).filter(n=>n.endsWith('.install.json')).map(n=>JSON.parse(fs.readFileSync(path.join(root,'logs',n))));
 assert.equal(logs.length,3);assert(logs.some(log=>log.status==='complete'));
 console.log('Default normal logs, opt-in trace context, no-log control, unchanged mod identity and automatic PC setup reports: passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
