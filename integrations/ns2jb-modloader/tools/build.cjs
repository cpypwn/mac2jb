#!/usr/bin/env node
'use strict';
// Maintainer build. End users load the bundled templates using Node alone.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {check,sha}=require('../lib/common.cjs'),{symbols,sections}=require('../lib/native/elf-text.cjs'),{callSource}=require('../lib/native/call-source.cjs');
const root=path.resolve(__dirname,'..'),work=path.join(root,'state/build-release'),out=path.join(root,'native/prebuilt'),zig=process.env.ZIG||'zig';
fs.mkdirSync(work,{recursive:true});fs.mkdirSync(out,{recursive:true});
const common=['cc','-target','aarch64-freestanding-none','-mcpu=cortex_a78c+reserve_x18','-g0','-ffile-prefix-map='+root+'=.'];
const run=args=>cp.execFileSync(zig,args,{stdio:'pipe'});
const templates={};
function assemble(name,source){
 const input=path.join(work,name+'.S'),output=path.join(work,name+'.o');fs.writeFileSync(input,source);run([...common,'-c',input,'-o',output]);
 const bytes=fs.readFileSync(output);templates[name]={object:bytes.toString('base64'),symbols:symbols(bytes)};
}
for(let i=0;i<=6;i++)assemble('call'+i,callSource(i));
assemble('publish',callSource(2,true));
assemble('allocate',callSource(1,false,true));
const linker=path.join(work,'runtime.ld'),elfFile=path.join(work,'runtime.elf'),objects=[];
fs.writeFileSync(linker,'ENTRY(lfs_read_entry)\nSECTIONS { . = 0; .text : { KEEP(*(.text)) *(.text*) *(.rodata*) } /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) } }\n');
const nativeSources=['romfs.c','namespace.c','diagnostics.c','trace.c','inventory.c','capture.c','verify.c','lazy.c','lazy-romfs.c','lazy-codefs.c','lazy-nso.c','minilibc.c','zbic-native.c','namespace.S'];
for(const name of nativeSources){
 const object=path.join(work,name+'.o');
 run([...common,'-Os','-ffreestanding','-fno-builtin','-fPIC','-fvisibility=hidden','-ffixed-x18','-fno-stack-protector','-mno-outline-atomics','-mbranch-protection=pac-ret+b-key+bti',...(name==='zbic-native.c'?['-ffunction-sections','-fdata-sections','-I'+path.join(root,'native/vendor/freestanding'),'-Wno-deprecated-declarations']:['-Wall','-Wextra','-Werror']),'-c',path.join(root,'native',name),'-o',object]);objects.push(object);
}
run([...common,'-nostdlib','-static','-Wl,-Bsymbolic','-Wl,--gc-sections','-Wl,-T,'+linker,'-Wl,-e,lfs_read_entry','-Wl,--build-id=none',...objects,'-o',elfFile]);
const elf=fs.readFileSync(elfFile),all=sections(elf),text=all.find(s=>s.name==='.text'),table=symbols(elf);
check(text?.address===0n&&all.filter(s=>(s.flags&2n)&&s.size).every(s=>s===text)&&!all.some(s=>(s.type===4||s.type===9)&&s.size),'Unexpected runtime sections or relocations');
templates.runtime={code:elf.subarray(text.offset,text.offset+text.size).toString('base64'),offsets:Object.fromEntries(Object.keys(table).filter(n=>/^lfs_|resident_context$|namespace_context$|lazy_context$/.test(n)).map(n=>[n,table[n].value]))};
fs.writeFileSync(path.join(out,'templates.json'),JSON.stringify(templates)+'\n');
run(['cc','-target','wasm32-wasi','-O2','-Wno-deprecated-declarations','-DZSTD_ZBIC_SUPPORT=1','-ffunction-sections','-fdata-sections','-mexec-model=reactor','-Wl,--gc-sections','-Wl,--strip-all','-Wl,--export=ZSTD_decompress','-Wl,--export=ZSTD_isError','-Wl,--export=malloc','-Wl,--export=free','-Wl,--max-memory=2147483648','-x','c',path.join(root,'native/vendor/zstd/zstd.inc'),'-o',path.join(out,'zbic.wasm')]);
const wasmModule=new WebAssembly.Module(fs.readFileSync(path.join(out,'zbic.wasm')));check(WebAssembly.Module.imports(wasmModule).length===0,'ZBIC decoder must not require external imports');
const sources=[...nativeSources.map(name=>'native/'+name),'native/namespace.h','native/lazy.h','native/trace.h','lib/native/call-source.cjs','native/vendor/zstd/zstd.inc',...['assert.h','stdio.h','stdlib.h','string.h','time.h'].map(name=>'native/vendor/freestanding/'+name)];
const manifest={schema:1,zig:cp.execFileSync(zig,['version'],{encoding:'utf8'}).trim(),sources:Object.fromEntries(sources.map(n=>[n,sha(fs.readFileSync(path.join(root,n)))])),files:Object.fromEntries(['templates.json','zbic.wasm'].map(n=>[n,sha(fs.readFileSync(path.join(out,n)))]))};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log('Built portable ARM64 templates and import-free ZBIC WebAssembly decoder.');
