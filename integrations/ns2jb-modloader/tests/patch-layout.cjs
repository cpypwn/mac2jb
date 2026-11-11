'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {collectMods}=require('../lib/mods.cjs'),lazy=require('../lib/lazy-context.cjs'),{patchedNso}=require('../lib/exefs.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'patch-layout-')),title='0400c3f00006e000',build='12'.padEnd(64,'0');
function write(name,bytes){const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;}
const binary=Buffer.from(['PATCH',Buffer.from([0,1,8,0,1,0x78]),'EOF'].map(part=>Buffer.isBuffer(part)?part:Buffer.from(part)).reduce((a,b)=>Buffer.concat([a,b]),Buffer.alloc(0)));
try{
 const folder='contents/'+title+'/exefs/';
 const ips=write(folder+build+'.ips',binary);write(folder+build+'.pchtxt','@nsobid-'+build+'\n@enabled\n00000008 78\n');
 const full=Buffer.alloc(1024);full.write('NSO0');Buffer.from(build,'hex').copy(full,0x40);
 for(let i=0;i<3;i++){full.writeUInt32LE(256+i*256,16+i*16);full.writeUInt32LE(i*0x1000,20+i*16);full.writeUInt32LE(64,24+i*16);}
 write(folder+'main',full);write(folder+'subsdk0',full);write(folder+'sdk.stub','');
 let collection=collectMods(root),game=collection.games[0];
 assert.deepEqual(game.exefs.map(row=>row.path),['/main','/subsdk0']);assert.deepEqual(game.stubs,['sdk']);
 assert.equal(game.patches.length,1);assert.equal(game.patches[0].file,ips);assert.equal(collection.patches.length,0);assert.equal(game.patchReferences.length,1);
 const virtual=patchedNso(full,game.patches);assert.equal(virtual.segments[0].data[8],0x78);assert.equal(virtual.segments[0].data[7],0);
 // Metadata-only SD scanning must make the same choice without reading file bodies.
 const remote={remote:true,existsSync:fs.existsSync,statSync:fs.statSync,lstatSync:fs.lstatSync,readdirSync:fs.readdirSync};
 collection=collectMods(root,remote);const plan=lazy.plan(collection,'switch2-layout');
 assert.equal(plan.lazyPatches.length,0);assert.equal(plan.lazyGames[0].titleId,title);
 const scoped=plan.lazyGames[0].files.filter(file=>file.kind===6);assert.equal(scoped.length,1);assert.equal(scoped[0].sdPath,ips);
 const native={sdk:{original:Object.fromEntries(['fileRead','fileSize','fileRelease','filesystemRelease','storageRelease','directoryRead','directoryCount','directoryRelease'].map((name,i)=>[name,0x1000+i*16]))},namespace:{original:{open:0x2000,directory:0x2010,type:0x2020}},originalSize:0x3000,lazy:{original:{current:0x4000,program:0x4010,data:0x4020}}};
 const bytes=lazy.buildContext(plan,{filesystem:{object:0x6100001000n},registry:0x6100003000n},0x4000000000n,0x6000000000n,native),layout=lazy.layout(plan);
 assert.equal(bytes.readBigUInt64LE(layout.gamesOffset),BigInt('0x'+title));assert.equal(bytes.readBigUInt64LE(layout.lazyOffset+88),0n);
 assert.equal(bytes.readUInt32LE(layout.filesOffset+plan.lazyGames[0].files.findIndex(file=>file.kind===6)*80+72),6);
 // Also accept the common misplaced per-title patch tree and flat global IPS.
 write('contents/'+title+'/exefs_patches/group/34.ips32',binary);write('exefs_patches/56.ips',binary);write('exefs_patches/atmosphere/78.ips',binary);
 collection=collectMods(root);assert.equal(collection.games[0].patches.length,2);assert.equal(collection.patches.length,2);
 // Accept both global roots; neither is mistaken for a Title ID. Compile
 // arbitrary text filenames by their internal NSO ID, never as ExeFS files.
 write('contents/exefs_patches/compat/90.ips',binary);
 const text=write(folder+'friendly-name.pchtxt','@nsobid-'+build+'\n@flag offset_shift 0x100\n@enabled\n8 79\n');
 collection=collectMods(root);game=collection.games[0];assert.equal(collection.patches.length,3);
 assert(collection.patches[0].path.startsWith('contents/exefs_patches/'));
 const compiled=game.patches.find(file=>file.file===text);assert.equal(compiled.inputFormat,'pchtxt');assert.equal(compiled.patchRecords,1);assert.equal(compiled.buildId,build);
 assert.equal(game.exefs.length,2);assert.equal(patchedNso(full,[compiled]).segments[0].data[8],0x79);
 // The resident manifest embeds the generated IPS in one owned allocation,
 // with pointers relocated to that allocation and no scratch SD file.
 collection=collectMods(root,remote);assert.equal(collection.games[0].patches.find(file=>file.file===text).format,'pchtxt');
 assert.throws(()=>lazy.plan(collection,'switch2-layout'),/compiled during setup/);
 collection=collectMods(root);for(const file of [...collection.games[0].exefs,...collection.games[0].patches,...collection.patches])file.sdPath=file.file;
 const compiledPlan=lazy.plan(collection,'switch2-layout'),compiledLayout=lazy.layout(compiledPlan),base=0x6000000000n;
 const context=lazy.buildContext(compiledPlan,{filesystem:{object:0x6100001000n},registry:0x6100003000n},0x4000000000n,base,native);
 const index=compiledPlan.lazyGames[0].files.findIndex(file=>file.kind===7),record=compiledLayout.filesOffset+index*80;
 const pointer=Number(context.readBigUInt64LE(record+56)-base),size=Number(context.readBigUInt64LE(record+64));
 assert(pointer>=compiledLayout.inlineOffset&&pointer+size<=compiledLayout.logOffset);assert.equal(context.readUInt32LE(record+72),7);
 assert.equal(context.subarray(pointer,pointer+size).toString('hex'),compiled.compiledHex);
 const again=lazy.buildContext(compiledPlan,{filesystem:{object:0x6100001000n},registry:0x6100003000n},0x4000000000n,base+4096n,native);
 assert.equal(again.readBigUInt64LE(record+56),context.readBigUInt64LE(record+56)+4096n);
 fs.unlinkSync(text);
 const invalid=write(folder+'main.ips',binary);assert.throws(()=>collectMods(root),/named for an NSO Build ID/);fs.unlinkSync(invalid);
 fs.symlinkSync(ips,path.join(root,'exefs_patches','ab.ips'));assert.throws(()=>collectMods(root),/symlinks/);
 console.log('Patch layout: native ExeFS, binary companion preference, both global roots, text-only compilation, resident inline extent/relocation and title-scoped ABI: passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
