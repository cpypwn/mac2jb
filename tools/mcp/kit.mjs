import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {selectedProfile} = require('../../scripts/host-profiles.cjs');
const attachment = require('../../scripts/rpc-attachment.cjs');
const {discover} = require('../../scripts/gui-discover-rpc.cjs');
const SESSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => {if (!condition) throw Error(message);};

async function canonical(file, directory = false) {
  check(path.isAbsolute(file) && path.resolve(file) === file, 'Use an absolute canonical path.');
  const info = await fs.lstat(file);
  check(!info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()) &&
    info.uid === process.getuid() && !(info.mode & 0o022) && await fs.realpath(file) === file,
    'Expected an owned path without symlinks or group/world write access: '+file);
  return info;
}
async function inside(root, relative, directory = false) {
  check(typeof relative === 'string' && relative.length > 0 && relative.length <= 1024 &&
    !path.isAbsolute(relative) && !relative.split(/[\\/]/).some(x => !x || x === '.' || x === '..'),
    'Use a relative path without traversal.');
  const target = path.join(root, relative);
  check(target.startsWith(root+path.sep), 'Path escapes the configured root.');
  // Check each ancestor as well as the leaf to reject aliases and symlink escapes.
  const parts = relative.split('/');
  for (let i=1; i<parts.length; i++) await canonical(path.join(root, ...parts.slice(0,i)), true);
  await canonical(target, directory);
  return target;
}
async function boundedRead(file, maximum = 128 * 1024) {
  const info = await canonical(file);
  check(info.size <= maximum, 'File exceeds the metadata/source size limit.');
  const handle = await fs.open(file, 'r');
  try {
    const current = await handle.stat();
    check(current.ino === info.ino && current.dev === info.dev && current.size <= maximum, 'File changed during inspection. Retry.');
    const buffer = Buffer.alloc(maximum+1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    check(bytesRead <= maximum, 'File exceeds the size limit.');
    return buffer.subarray(0, bytesRead);
  } finally {await handle.close();}
}
export function checksumSource(bytes) {
  check(!bytes.includes(13) && !bytes.some(b => b > 126 || b < 32 && b !== 10),
    'Checksum generation requires ASCII source with LF line endings.');
  const text = bytes.toString('ascii');
  check(text.endsWith('\n'), 'Bootstrap must end with LF.');
  const lines = text.slice(0,-1).split('\n');
  check(lines.length <= 10000, 'Bootstrap exceeds the line limit.');
  let hash = 0, characters = 0;
  for (const line of lines) {
    for (const character of line+'\n') {hash = (hash*257+character.charCodeAt(0))%1000003; characters++;}
    hash = (hash*257+10)%1000003;
  }
  return {lines:lines.length, characters, checksum:hash,
    command:`H=0:N=0:PRGEDIT 0:FOR I=1 TO ${lines.length}:S$=PRGGET$():FOR J=0 TO LEN(S$)-1:H=(H*257+ASC(MID$(S$,J,1))) MOD 1000003:N=N+1:NEXT:H=(H*257+10) MOD 1000003:NEXT:PRINT N,H`,
    note:'Run this command in Direct mode to read slot 0 without RUN or SAVE. Compare both printed numbers. PRGGET$ includes LF. This non-cryptographic check detects transfer errors; it does not prove runtime compatibility.'};
}
export async function createKit({runtimeRoot, sessionsRoot}, dependencies = {}) {
  await canonical(runtimeRoot, true); await canonical(sessionsRoot, true);
  const inspect = dependencies.inspect || attachment.inspect;
  const discoverRuns = dependencies.discover || discover;
  let queue = Promise.resolve(), pending = 0;
  function serialize(action) {
    check(pending < 16, 'Too many pending RPC checks; wait for current checks to finish.');
    pending++;
    const result = queue.then(action).finally(()=>{pending--;}); queue = result.catch(()=>{}); return result;
  }
  async function profile() {
    await canonical(runtimeRoot,true);
    const selectedFile = await inside(runtimeRoot,'selected-host.json');
    const metadata = JSON.parse(await boundedRead(selectedFile));
    const trusted = selectedProfile(runtimeRoot);
    check(metadata.startArgumentCount === trusted.startArgumentCount && metadata.bootstrap === trusted.bootstrap,
      'Selected bootstrap ABI/path does not match this toolkit version. Use the matching runtime/toolkit.');
    const file = await inside(runtimeRoot,trusted.bootstrap);
    const bytes = await boundedRead(file);
    check(sha256(bytes) === trusted.bootstrapSha256, 'Bootstrap checksum mismatch. Restore the pinned bootstrap before sending.');
    return {trusted,bytes};
  }
  return {
    async sessions({offset=0,limit=20}={}) {
      await canonical(sessionsRoot,true);
      const names=[]; const dir=await fs.opendir(sessionsRoot); let scanned=0;
      for await (const item of dir) {
        check(++scanned <= 4096,'Sessions directory exceeds the scan limit; archive old sessions first.');
        if (item.isDirectory() && SESSION.test(item.name)) names.push(item.name);
      }
      names.sort(); const results=[];
      for (const name of names.slice(offset,offset+limit)) {
        try {const file=await inside(sessionsRoot,name,true);const info=await fs.stat(file);results.push({id:name,modified:new Date(info.mtimeMs).toISOString()});}
        catch { /* unsafe entries are not session candidates */ }
      }
      return {sessions:results,nextOffset:offset+limit<names.length?offset+limit:null,note:'Listing metadata does not establish a live RPC connection.'};
    },
    async preflight() {
      const {trusted,bytes}=await profile();
      return {profile:trusted.id,revision:trusted.revision,bootstrapSha256:sha256(bytes),
        startArgumentCount:trusted.startArgumentCount,startPort:trusted.startPort,saveName:trusted.saveName,
        supportsHeldRPC:trusted.supportsHeldRPC,bootstrapBytes:bytes.length,
        scope:'Pinned source/ABI verified on the Mac. Console contents, Ethernet reachability and runtime success have not been verified.'};
    },
    async checksum() {const {bytes}=await profile();return checksumSource(bytes);},
    discover() {return serialize(async()=>{
      await canonical(runtimeRoot,true);await canonical(sessionsRoot,true);
      const result=await discoverRuns(runtimeRoot,sessionsRoot);
      return {candidates:result.candidates.map(item=>({run:path.relative(sessionsRoot,item.path),session:item.session,profileId:item.profileId,modified:item.modified})),
        note:'Only verified held sessions are returned. No candidates does not imply USB is disconnected.'};
    });},
    status({run}) {return serialize(async()=>{
      await canonical(runtimeRoot,true);await canonical(sessionsRoot,true);
      const directory=await inside(sessionsRoot,run,true);
      check(SESSION.test(run.split('/')[0]),'Run must belong to a session under the configured Sessions root.');
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),10000);
      try {
        const verified=await inspect(runtimeRoot,directory,{timeoutMs:3000,signal:controller.signal,allowRetainedBusy:true});
        return {session:verified.session,profile:verified.profileId,sourceSha256:verified.sourceSha256,
          ready:verified.status.ready===true,retainedBusy:verified.status.retainedBusy===true,
          scope:'This exact held session passed existing host proof and live endpoint checks. This is not a filesystem export or privilege escalation.'};
      } finally {clearTimeout(timer);}
    });}
  };
}
