#!/usr/bin/env node
'use strict';
// Maintainer build. End users load the bundled templates using Node alone.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {check,sha}=require('../lib/common.cjs'),{symbols,sections}=require('../lib/native/elf-text.cjs'),{callSource}=require('../lib/native/call-source.cjs');
const {ABI,CAVE}=require('../lib/native-namespace.cjs');
const root=path.resolve(__dirname,'..'),work=path.join(root,'state/build-release'),out=path.join(root,'native/prebuilt'),zig=process.env.ZIG||'zig';
fs.mkdirSync(work,{recursive:true});fs.mkdirSync(out,{recursive:true});
const common=['cc','-target','aarch64-freestanding-none','-mcpu=cortex_a78c','-g0','-ffile-prefix-map='+root+'=.'];
const run=args=>cp.execFileSync(zig,args,{stdio:'pipe'});
const templates={};
function assemble(name,source){
 const input=path.join(work,name+'.S'),output=path.join(work,name+'.o');fs.writeFileSync(input,source);run([...common,'-c',input,'-o',output]);
 const bytes=fs.readFileSync(output);templates[name]={object:bytes.toString('base64'),symbols:symbols(bytes)};
}
const romfs=fs.readFileSync(path.join(root,'native/romfs.S'),'utf8');check(romfs.includes('.xword LFS_CONTEXT'),'Missing context placeholder');assemble('romfs',romfs.replace('LFS_CONTEXT','0'));
for(let i=0;i<=6;i++)assemble('call'+i,callSource(i));
const linker=path.join(work,'namespace.ld'),c=path.join(work,'namespace.o'),s=path.join(work,'namespace-gateway.o'),elfFile=path.join(work,'namespace.elf');
fs.writeFileSync(linker,`ENTRY(lfs_namespace_open_entry)\nnamespace_context = 0;\n${Object.entries(ABI).map(([n,a])=>`original_${n}_tail = 0x${(a.offset+16).toString(16)};`).join('\n')}\nSECTIONS { . = 0x${CAVE.toString(16)}; .text : { *(.text*) *(.rodata*) } /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) } }\n`);
run([...common,'-Os','-ffreestanding','-fno-builtin','-ffixed-x18','-fno-stack-protector','-mno-outline-atomics','-mbranch-protection=pac-ret+b-key+bti','-Wall','-Wextra','-Werror','-c',path.join(root,'native/namespace.c'),'-o',c]);
run([...common,'-c',path.join(root,'native/namespace.S'),'-o',s]);run([...common,'-nostdlib','-static','-Wl,-T,'+linker,'-Wl,-e,lfs_namespace_open_entry','-Wl,--build-id=none',s,c,'-o',elfFile]);
const elf=fs.readFileSync(elfFile),all=sections(elf),text=all.find(s=>s.name==='.text'),table=symbols(elf);check(text?.address===BigInt(CAVE)&&all.filter(s=>(s.flags&2n)&&s.size).every(s=>s===text)&&!all.some(s=>(s.type===4||s.type===9)&&s.size),'Unexpected prebuilt namespace sections');
templates.namespace={code:elf.subarray(text.offset,text.offset+text.size).toString('base64'),contextOffset:table.context.value-CAVE,offsets:Object.fromEntries(Object.keys(table).filter(n=>/^lfs_namespace_/.test(n)).map(n=>[n,table[n].value-CAVE]))};
fs.writeFileSync(path.join(out,'templates.json'),JSON.stringify(templates)+'\n');
run(['cc','-target','wasm32-wasi','-O2','-Wno-deprecated-declarations','-DZSTD_ZBIC_SUPPORT=1','-ffunction-sections','-fdata-sections','-mexec-model=reactor','-Wl,--gc-sections','-Wl,--strip-all','-Wl,--export=ZSTD_decompress','-Wl,--export=ZSTD_isError','-Wl,--export=malloc','-Wl,--export=free','-Wl,--max-memory=2147483648','-x','c',path.join(root,'native/vendor/zstd/zstd.inc'),'-o',path.join(out,'zbic.wasm')]);
const wasmModule=new WebAssembly.Module(fs.readFileSync(path.join(out,'zbic.wasm')));check(WebAssembly.Module.imports(wasmModule).length===0,'ZBIC decoder must not require external imports');
const sources=['native/romfs.S','native/namespace.S','native/namespace.c','native/namespace.h','lib/native/call-source.cjs','native/vendor/zstd/zstd.inc'];
const manifest={schema:1,zig:cp.execFileSync(zig,['version'],{encoding:'utf8'}).trim(),sources:Object.fromEntries(sources.map(n=>[n,sha(fs.readFileSync(path.join(root,n)))])),files:Object.fromEntries(['templates.json','zbic.wasm'].map(n=>[n,sha(fs.readFileSync(path.join(out,n)))]))};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log('Built portable ARM64 templates and import-free ZBIC WebAssembly decoder.');
