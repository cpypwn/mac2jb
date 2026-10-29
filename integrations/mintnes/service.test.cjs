const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const layout=require('../../vendor/MintBrew/apps/mintnes/layout.cjs');
const service=require('./service.cjs');
const {chrRam}=require('./scroll-fixture.cjs');

const root=path.resolve(__dirname,'../../vendor/MintBrew/apps/mintnes');
async function setup(){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mintnes-test-'));
 const bytes=await fs.readFile(path.join(root,'assets/memory.bin'));
 const memory=Buffer.from(bytes),mapped=0x100000;
 const rpc={async read(address,length){assert.ok(address>=mapped&&address+length<=mapped+memory.length);return Buffer.from(memory.subarray(address-mapped,address-mapped+length));},
  async write(address,input){assert.ok(address>=mapped&&address+input.length<=mapped+memory.length);Buffer.from(input).copy(memory,address-mapped);}};
 const app={root,files:{memory:{bytes}}};
 const gpu={privateStorage:{mapped,bytes:layout.bytes}};
 return {folder,memory,rpc,app,gpu};
}
const word=(bytes,index)=>bytes.readUInt32LE(index*4);

test('bundled ROM has the expected open-source mapper-0 iNES layout',async()=>{
 const bytes=await fs.readFile(path.join(root,'rom/game.nes'));
 const parsed=service.validRom(bytes);
 assert.equal(bytes.length,40976);
 assert.equal(parsed.prgBanks,2);
 assert.equal(parsed.prg.length,32768);
 assert.equal(parsed.chr.length,8192);
 const vertical=Buffer.from(bytes);vertical[6]=1;
 assert.equal(service.validRom(vertical).mirroring,1);
 const bad=Buffer.from(bytes);bad[6]=0x10;
 assert.throws(()=>service.validRom(bad),/mapper 0/);
});

test('ROM list seeds once, refreshes live, and loading resets the GPU interpreter',async t=>{
 const env=await setup();t.after(()=>fs.rm(env.folder,{recursive:true,force:true}));
 const runtime=await service.create({rpc:env.rpc,gpu:env.gpu,app:env.app,directory:env.folder});
 assert.equal(word(env.memory,layout.menuMode),1);
 assert.equal(word(env.memory,layout.count),1);
 assert.equal(String.fromCharCode(word(env.memory,layout.menuText)), 'D');
 assert.ok((await fs.readdir(env.folder)).includes('Diamond Chase.nes'));
 assert.equal(await runtime.pending(),false);

 await fs.copyFile(path.join(root,'rom/game.nes'),path.join(env.folder,'Second Game.nes'));
 env.memory.writeUInt32LE(1,layout.refreshRequest*4);
 assert.equal(await runtime.pending(),true);
 await runtime.afterBatch();
 assert.equal(await runtime.pending(),false);
 assert.equal(word(env.memory,layout.count),2);
 assert.equal(String.fromCharCode(word(env.memory,layout.menuText+layout.nameWords)), 'S');

 env.memory.writeUInt32LE(2,layout.loadRequest*4);
 assert.equal(await runtime.pending(),true);
 await runtime.afterBatch();
 assert.equal(word(env.memory,layout.menuMode),0);
 assert.equal(word(env.memory,layout.loadRequest),0);
 assert.equal(word(env.memory,4),0x8000);
 assert.equal(word(env.memory,layout.prg),0x78);
 assert.equal(word(env.memory,layout.chr+4096),0x18);

 await fs.rm(path.join(env.folder,'Diamond Chase.nes'));
 env.memory.writeUInt32LE(1,layout.menuMode*4);
 assert.equal(await runtime.pending(),true);
 await runtime.afterBatch();
 assert.equal(word(env.memory,layout.count),1);
 assert.deepEqual((await fs.readdir(env.folder)).filter(name=>name.endsWith('.nes')),['Second Game.nes']);
});

test('16 KB PRG is mirrored at $c000 and unsupported ROMs stay off the menu',async t=>{
 const env=await setup();t.after(()=>fs.rm(env.folder,{recursive:true,force:true}));
 const original=await fs.readFile(path.join(root,'rom/game.nes'));
 const short=Buffer.concat([Buffer.from(original.subarray(0,16)),original.subarray(16,16+16384),original.subarray(16+32768)]);
 short[4]=1;
 assert.equal(service.validRom(short).prgBanks,1);
 const image=service.imageFor(env.app,short,[{title:'Short'}],0);
 assert.equal(word(image,layout.prg),word(image,layout.prg+16384));
 await fs.mkdir(env.folder,{recursive:true});
 await fs.writeFile(path.join(env.folder,'Bad.nes'),Buffer.from('bad'));
 const runtime=await service.create({rpc:env.rpc,gpu:env.gpu,app:env.app,directory:env.folder});
 assert.equal((await runtime.scan()).length,1);
});

test('mapper-0 CHR-RAM ROM starts with writable blank pattern memory',async()=>{
 const env=await setup();
 const rom=chrRam();
 assert.equal(service.validRom(rom).chrRam,true);
 const image=service.imageFor(env.app,rom,[{title:'CHR RAM'}],0);
 assert.equal(word(image,layout.chrRam),1);
 assert.equal(word(image,layout.chr+16),0);
});
