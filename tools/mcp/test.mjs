import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createKit,checksumSource} from './kit.mjs';
const require=createRequire(import.meta.url);
const {profiles}=require('../../scripts/host-profiles.cjs');
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const id='11111111-1111-1111-1111-111111111111';
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mac2jb-mcp-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sessionsRoot=path.join(root,'Sessions');await fs.mkdir(sessionsRoot,{mode:0o700});
  const runtimeRoot=path.join(sessionsRoot,id);await fs.mkdir(runtimeRoot,{mode:0o700});
  return {root,sessionsRoot,runtimeRoot};
}
test('checksum includes returned LF and explicit line separators',()=>{
  const value=checksumSource(Buffer.from('A\n\nB\n'));
  let h=0;for(const c of 'A\n\n\n\nB\n\n')h=(h*257+c.charCodeAt(0))%1000003;
  assert.equal(value.characters,5);assert.equal(value.lines,3);assert.equal(value.checksum,h);
  assert.match(value.command,/TO 3:/);assert.throws(()=>checksumSource(Buffer.from('A\r\n')),/ASCII/);
  assert.throws(()=>checksumSource(Buffer.from('A')),/end with LF/);
});
test('bounded listing excludes symlinks and paginates',async t=>{
  const f=await fixture(t);await fs.symlink(f.runtimeRoot,path.join(f.sessionsRoot,'22222222-2222-2222-2222-222222222222'));
  const kit=await createKit(f);assert.equal((await kit.sessions()).sessions.length,1);
  assert.deepEqual((await kit.sessions({offset:1,limit:1})).sessions,[]);
});
test('rejects symlink root and traversal before RPC',async t=>{
  const f=await fixture(t);const alias=path.join(f.root,'alias');await fs.symlink(f.runtimeRoot,alias);
  await assert.rejects(createKit({...f,runtimeRoot:alias}),/symlink/);
  let called=false;const kit=await createKit(f,{inspect:async()=>{called=true;}});
  await assert.rejects(kit.status({run:'../outside'}),/traversal/);
  await fs.symlink(f.root,path.join(f.runtimeRoot,'escape'));
  await assert.rejects(kit.status({run:id+'/escape'}),/symlink/);
  assert.equal(called,false);
});
test('missing/stale proof fails closed without treating metadata as ready',async t=>{
  const f=await fixture(t);const run=id+'/vendor/ns2jb/runs/switch2-ABC123';
  await fs.mkdir(path.join(f.sessionsRoot,run),{recursive:true,mode:0o700});
  const kit=await createKit(f);await assert.rejects(kit.status({run}),/ENOENT/);
});
test('pinned bootstrap preflight rejects a changed bootstrap and altered ABI',async t=>{
  const f=await fixture(t);const profile=profiles.find(p=>p.id==='kurumuz');
  await fs.writeFile(path.join(f.runtimeRoot,'selected-host.json'),JSON.stringify(profile));
  const target=path.join(f.runtimeRoot,profile.bootstrap);await fs.mkdir(path.dirname(target),{recursive:true});
  const source=path.join(repo,profile.bootstrap);
  await fs.copyFile(source,target);
  const kit=await createKit(f);assert.equal((await kit.preflight()).profile,'kurumuz');
  const checksum=await kit.checksum();
  assert.equal(checksum.lines,228);assert.equal(checksum.characters,8029);assert.equal(checksum.checksum,590182);
  await fs.appendFile(target,'REM changed\n');await assert.rejects(kit.preflight(),/checksum mismatch/);
  await fs.writeFile(path.join(f.runtimeRoot,'selected-host.json'),JSON.stringify({...profile,startArgumentCount:9}));
  await assert.rejects(kit.preflight(),/ABI/);
});
test('live status operations serialize and expose only bounded summary',async t=>{
  const f=await fixture(t);const run=id+'/vendor/ns2jb/runs/switch2-ABC123';
  await fs.mkdir(path.join(f.sessionsRoot,run),{recursive:true,mode:0o700});
  let active=0,maximum=0;
  const kit=await createKit(f,{inspect:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,10));active--;return {session:'switch2-ABC123',profileId:'kurumuz',sourceSha256:'a'.repeat(64),status:{ready:true,secret:'omitted'}};}});
  const results=await Promise.all([kit.status({run}),kit.status({run})]);assert.equal(maximum,1);assert.equal(results[0].ready,true);assert.equal(results[0].secret,undefined);
});
test('SDK stdio handshake, tool discovery, invocation and schema rejection',async t=>{
  const f=await fixture(t);
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(here,'server.mjs'),'--runtime-root',f.runtimeRoot,'--sessions-root',f.sessionsRoot],stderr:'pipe'});
  const client=new Client({name:'mac2jb-test',version:'1.0.0'});
  t.after(()=>client.close());await client.connect(transport);
  const {tools}=await client.listTools();assert.equal(tools.length,5);assert.ok(tools.every(tool=>tool.annotations.readOnlyHint));
  const result=await client.callTool({name:'mac2jb_list_sessions',arguments:{limit:1}});
  assert.equal(result.structuredContent.sessions[0].id,id);
  const invalid=await client.callTool({name:'mac2jb_list_sessions',arguments:{limit:500}});assert.equal(invalid.isError,true);
  const missing=await client.callTool({name:'mac2jb_preflight',arguments:{}});assert.equal(missing.isError,true);
});
