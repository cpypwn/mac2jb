const test=require('node:test'),assert=require('node:assert/strict');
const {virtualPath,nativePath}=require('../host/ftp-native.cjs'),{create}=require('../host/ftp-server.cjs');
const {validateManifest}=require('../host/runtime.cjs');
test('FTP paths stay inside exposed mounts and ROM cannot be mutated',()=>{
 assert.equal(virtualPath('/save/folder','../file'),'/save/file');assert.equal(virtualPath('/','../../../rom'),'/rom');
 assert.deepEqual(nativePath('/save/a',true),{mount:'save',path:'save:/a'});
 for(const p of ['/rom/a','/rom/../rom/a','/save','/tmp','/','/sdmc/a'])assert.throws(()=>nativePath(p,true));
 for(const p of ['/save/a\nDELE b','/save/a\0b','/save/a\\b','/save/rom:/a'])assert.throws(()=>virtualPath('/',p));
 assert.throws(()=>virtualPath('/','x'.repeat(741)));
});
test('background service manifest rejects arbitrary code/services and invalid ports',()=>{
 const base={version:1,capabilities:[],services:['ftp'],ftpPort:5000};assert.doesNotThrow(()=>validateManifest(base));
 for(const extra of [{services:['shell']},{services:'ftp'},{ftpPort:21},{ftpPort:65536},{ftpPort:5000.5}])assert.throws(()=>validateManifest({...base,...extra}));
});
async function fixture(){
 let clock=0,nextFd=10,accepted=false,input=[],output='',closed=[],writes=0,renames=0,stoppedFiles=0;
 const listeners=new Map(),data=new Map();let server;
 const transport={async address(){return '192.0.2.1';},async listen(port){const fd=nextFd++;listeners.set(fd,[]);return {fd,port:port||42000};},async accept(fd){if(fd===10&&!accepted){accepted=true;return {fd:1,peer:'192.0.2.2'};}return listeners.get(fd)?.shift()??null;},async recv(fd){if(fd===1)return input.shift()??null;return data.get(fd)?.shift()??null;},async send(fd,b){const n=Math.min(b.length,7);if(fd===1)output+=b.subarray(0,n).toString();return n;},async close(fd){closed.push(fd);}};
 const storage={async stat(){return {type:'dir',size:0};},async list(){return [{name:'save',type:'dir',size:0}];},async mkdir(){writes++;},async remove(){writes++;},async rename(){renames++;},async openWrite(){writes++;return {write:true,size:0};},async write(){writes++;},async close(){stoppedFiles++;}};
 server=create({transport,storage,now:()=>clock});await server.start();
 async function drain(){for(let i=0;i<150;i++)await server.pump();const value=output;output='';return value;}
 await drain();return {server,closed,data,listeners,get writes(){return writes;},get stoppedFiles(){return stoppedFiles;},async command(line){input.push(Buffer.from(line+'\r\n'));return drain();},async login(){await this.command('USER anonymous');await this.command('PASS test@example.invalid');},async drain(){return drain();},advance(ms){clock+=ms;}};
}
test('FTP requires login, rejects active-mode bounce, and flushes QUIT with partial sends',async()=>{
 const f=await fixture();assert.match(await f.command('MKD /save/no'),/^530 /);assert.equal(f.writes,0);
 await f.login();assert.match(await f.command('PORT 127,0,0,1,0,22'),/^502 /);assert.match(await f.command('EPSV ALL'),/^522 /);
 assert.match(await f.command('QUIT'),/^221 Goodbye\r\n$/);assert.ok(f.closed.includes(1));await f.server.stop();
});
test('ROM upload is rejected before opening a file; passive data peer must match control peer',async()=>{
 const f=await fixture();await f.login();assert.match(await f.command('PASV'),/^227 /);
 assert.match(await f.command('STOR /rom/file'),/^550 /);assert.equal(f.writes,0);
 f.listeners.get(11).push({fd:2,peer:'192.0.2.99'});await f.drain();assert.ok(f.closed.includes(2));assert.equal(f.writes,0);await f.server.stop();
});
test('an upload does not truncate a file until its data connection exists',async()=>{
 const f=await fixture();await f.login();await f.command('EPSV');assert.match(await f.command('STOR /save/new'),/^150 /);assert.equal(f.writes,0);
 f.advance(31000);assert.match(await f.drain(),/^425 |^426 /);assert.equal(f.writes,0);await f.server.stop();
});
test('active uploads survive control idle timeout and stop closes the writable file',async()=>{
 const f=await fixture();await f.login();await f.command('PASV');f.listeners.get(11).push({fd:2,peer:'192.0.2.2'});await f.command('STOR /save/new');
 for(let i=0;i<10;i++){f.advance(20000);f.data.set(2,[Buffer.from('chunk')]);await f.drain();}
 assert.equal(f.server.state.clients,1);assert.equal(f.server.state.received,50);await f.server.stop();assert.equal(f.stoppedFiles,1);assert.ok(f.closed.includes(2));assert.ok(f.closed.includes(1));assert.equal(f.server.state.running,false);
});
