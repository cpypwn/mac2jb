'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),vm=require('node:vm');
const {findSession,processRunDirectories}=require('../lib/find-session.cjs'),{verifiedRun}=require('../install.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ml-')),root=path.join(temporary,'Host files 日本語'),requests=[],servers=[];
function macFinder(output,error){
 const filename=require.resolve('../lib/find-session.cjs'),module={exports:{}};let calls=0;
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,__dirname:path.dirname(filename),process:{platform:'darwin',cwd:()=>root},Buffer,
  require:name=>name==='node:child_process'?{execFile(program,args,options,callback){
   calls++;assert.equal(program,'ps');assert.deepEqual(Array.from(args),['-axww','-o','command=']);assert.equal(options.shell,undefined);assert(options.timeout>0&&options.maxBuffer>0);callback(error,{stdout:output});
  }}:require(name.startsWith('.')?path.resolve(path.dirname(filename),name):name)}, {filename});
 return{findSession:module.exports.findSession,calls:()=>calls};
}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}
async function run(session,{closed=false,identity=session,httpIdentity=true}={}){
 const server=http.createServer((req,res)=>{let text='';req.on('data',part=>text+=part);req.on('end',()=>{assert.equal(text,'{"command":"status"}');requests.push(session);res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,...(httpIdentity?{session}:{})}));});});
 servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const folder=path.join(root,'runs',session);write(path.join(folder,'result.json'),{verified:true,target:'switch2',rpc:{state:closed?'closed':'listening'}});
 write(path.join(folder,'switch2/fs-execution-current.json'),{verified:true,file:'switch2/proof.json'});write(path.join(folder,'switch2/proof.json'),{verified:true,session});
 write(path.join(folder,'connection.json'),{port:server.address().port,addresses:{session:identity,target:'switch2'}});
 if(!httpIdentity){
  // Keep the Unix endpoint below macOS's shorter sockaddr_un path limit,
  // independently of the long/unicode PC paths exercised by this fixture.
  const socketPath=process.platform==='win32'?'\\\\.\\pipe\\modloader-discovery-'+process.pid+'-'+session:path.join(temporary,'fs'+servers.length+'.sock');
  const endpoint=net.createServer(socket=>{let input='';socket.on('data',part=>{input+=part;if(input.includes('\n')){assert.deepEqual(JSON.parse(input),{command:'info'});socket.end(JSON.stringify({ready:true,session}));}});});
  servers.push(endpoint);await new Promise(resolve=>endpoint.listen(socketPath,resolve));write(path.join(folder,'switch2/current-acquisition.json'),{socketPath});
 }
 return fs.realpathSync(folder);
}
(async()=>{try{
 const proc=path.join(root,'no-proc'),roots=[root,path.join(root,'runs'),root];
 await assert.rejects(findSession(verifiedRun,{proc,roots}),/No active FS 4\/4/);
 const first=await run('switch2-first',{httpIdentity:false});await run('switch2-ended',{closed:true});await run('switch2-mismatched',{identity:'switch2-different'});
 assert.equal(await findSession(verifiedRun,{proc,roots}),first);assert.equal(requests.length,1);
 const second=await run('switch2-second');await assert.rejects(findSession(verifiedRun,{proc,roots}),/More than one active session/);
 fs.rmSync(second,{recursive:true});
 // A stale report must not borrow another run's live HTTP port or endpoint.
 const stale=await run('switch2-stale');
 write(path.join(stale,'connection.json'),{...JSON.parse(fs.readFileSync(path.join(first,'connection.json'))),addresses:{session:'switch2-stale'}});
 write(path.join(stale,'switch2/current-acquisition.json'),JSON.parse(fs.readFileSync(path.join(first,'switch2/current-acquisition.json'))));
 assert.equal(await findSession(verifiedRun,{proc,roots}),first);
 write(path.join(stale,'connection.json'),{...JSON.parse(fs.readFileSync(path.join(root,'runs/switch2-mismatched/connection.json'))),addresses:{session:'switch2-stale'}});
 assert.equal(await findSession(verifiedRun,{proc,roots}),first);
 // Process discovery still finds a qualified session outside the nearby roots.
 const alternate=path.dirname(first)+path.sep+'.'+path.sep+path.basename(first);
 if(process.platform==='linux'){
  const fakeProc=path.join(root,'proc','123');fs.mkdirSync(fakeProc,{recursive:true});fs.writeFileSync(path.join(fakeProc,'cmdline'),'node\0'+path.join(first,'switch2/pipeline.cjs')+'\0');
  assert.equal(await findSession(verifiedRun,{proc:path.dirname(fakeProc),roots:[]}),first);
  fs.writeFileSync(path.join(fakeProc,'cmdline'),'node\0'+alternate+path.sep+'switch2'+path.sep+'pipeline.cjs\0');
  assert.equal(await findSession(verifiedRun,{proc:path.dirname(fakeProc),roots}),first);
 }
 console.log('Session discovery: missing /proc, nearby runs, proof and live identity, legacy endpoint, reused ports, ended/foreign sessions, canonical directory deduplication, ambiguity and original process discovery: passed');
 // Use the complete discovery path with real local HTTP/Unix endpoints, while
 // only the macOS ps call is modeled. No native console operation is sent.
 if(process.platform!=='win32'){
 const pipeline=path.join(first,'switch2','pipeline.cjs');
 for(const command of [
  '/opt/homebrew/bin/node '+pipeline,
  'node '+pipeline,
  '/usr/local/bin/node --no-warnings --expose-gc '+pipeline+' --hold-rpc',
  '/Applications/Node JS/bin/node "'+pipeline+'"',
  "node --require '/Users/example/extra setup.cjs' '"+pipeline+"'",
  'node '+pipeline+'\r\nnode '+pipeline,
  'node '+alternate+'/switch2/pipeline.cjs\nnode '+pipeline
 ]){
  assert(processRunDirectories(command).has(first));
  const mac=macFinder(command);assert.equal(await mac.findSession(verifiedRun,{proc,roots:[]}),first);assert.equal(mac.calls(),1);
 }
 assert.equal(processRunDirectories('node '+pipeline+'.map').size,0);
 const noPs=macFinder('',Object.assign(Error('ps unavailable'),{code:'ENOENT'}));assert.equal(await noPs.findSession(verifiedRun,{proc,roots}),first);
 await assert.rejects(noPs.findSession(verifiedRun,{proc,roots:[]}),/No active FS 4\/4.*--run-dir/);
 // A discovered path is still rejected when its live endpoint belongs to
 // another run; multiple genuine sessions still require explicit selection.
 const foreign=macFinder('node '+path.join(stale,'switch2','pipeline.cjs'));await assert.rejects(foreign.findSession(verifiedRun,{proc,roots:[]}),/No active FS 4\/4/);
 const macSecond=await run('switch2-macsecond'),ambiguous=macFinder('node '+pipeline+'\nnode '+path.join(macSecond,'switch2','pipeline.cjs'));
 await assert.rejects(ambiguous.findSession(verifiedRun,{proc,roots:[]}),/More than one active session/);
 fs.rmSync(macSecond,{recursive:true});
 assert.equal(await macFinder('').findSession(verifiedRun,{proc,roots:[root]}),first);
 console.log('macOS discovery: Node paths/options, spaces/unicode/quotes, duplicate commands, bounded ps failure fallback, stale endpoint rejection and genuine ambiguity: passed');
 }
}finally{for(const server of servers)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
