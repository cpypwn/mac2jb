const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const stage=require('./prepare.cjs'),{create}=require('./service.cjs');
const layout=require('../../vendor/MintBrew/sdk/host/layout.cjs');
const ftp=require('../../vendor/MintBrew/sdk/host/ftp-service.cjs');

const repository=path.resolve(__dirname,'../..');

test('MintFTP stages exact GPU assets and rejects changed runtime files',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mintftp-test-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'apps'));
 const info=stage.prepareMintBrew(repository,root);
 assert.equal(info.files,7);
 assert.deepEqual(stage.verifyMintBrew(repository,root),info);
 const app=JSON.parse(fs.readFileSync(path.join(root,'apps/mintftp/app.json')));
 assert.equal(app.sdk.ftpPort,2121);
 assert.equal(app.name,'MintFTP');
 const shader=path.join(root,'apps/mintftp/app.comp.spv');
 fs.appendFileSync(shader,'changed');
 assert.throws(()=>stage.verifyMintBrew(repository,root),/Changed MintFTP app file/);
});

test('MintFTP handoff keeps FTP running until a game is selected',async()=>{
 const mapped=4096,base=mapped+layout.OFFSET,memory=Buffer.alloc(base+ftp.REQUEST+8);
 memory.writeUInt32LE(ftp.MAGIC,base+ftp.STATUS);
 memory.writeUInt32LE(1,base+ftp.STATUS+4);
 const actions=[];
 const rpc={
  async read(address,length){return Buffer.from(memory.subarray(address,address+length));},
  async write(address,bytes){
   bytes.copy(memory,address);
   if(address===base+ftp.REQUEST){
    const sequence=bytes.readUInt32LE(),action=bytes.readUInt32LE(4);
    actions.push(action);
    memory.writeUInt32LE(sequence,base+ftp.STATUS+44);
    memory.writeUInt32LE(action===1?1:0,base+ftp.STATUS+4);
   }
  }
 };
 const service=create({rpc,menu:{controls:{mapped}}});
 await service.start();
 assert.equal(service.handoff(),service);
 assert.equal(memory.readUInt32LE(base+ftp.STATUS+4),1);
 await service.stopForGame();
 assert.equal(memory.readUInt32LE(base+ftp.STATUS+4),0);
 await service.resumeForList();
 assert.equal(memory.readUInt32LE(base+ftp.STATUS+4),1);
 await service.close();
 assert.deepEqual(actions,[2,1,2]);
});
