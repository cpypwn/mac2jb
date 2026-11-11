#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {inspect, OWNER, ATTEMPT} = require('./rpc-attachment.cjs');

const SESSION_NAME = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/;
const SAVEKIT_HOST = /^ns2-savekit-host-[A-Za-z0-9]{6}$/;
const CIV_STAGE_NAME = /^civswitch-fs-[a-f0-9]{16}$/;
const ARTEMIS_STAGE_NAME = /^artemis-fs-[a-f0-9]{16}$/;
const RUN_NAME = /^switch2-[A-Za-z0-9]{6}$/;
const MAX_SESSIONS = 128;
const MAX_SESSION_ENTRIES = 512;
const MAX_RUNS = 128;
const MAX_CIV_STAGE_ENTRIES = 32;
const MAX_CIV_STAGES = 16;
const MAX_CIV_RUN_ENTRIES = 8;
const MAX_PROBES = 12;
const MAX_RESULTS = 8;
const MAX_DURATION_MS = 12000;
const PROBE_TIMEOUT_MS = 2500;

async function privateDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 || await fs.realpath(directory) !== directory)
    throw Error('RPC discovery requires an owned private Sessions folder.');
  return info;
}
async function entries(directory) {
  try {return await fs.readdir(directory, {withFileTypes:true});}
  catch (error) {if (error.code === 'ENOENT') return []; throw error;}
}
async function exists(file) {
  try {await fs.lstat(file); return true;}
  catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}
async function possibleHeldRun(directory, target) {
  const resultFile = path.join(directory, 'result.json');
  let info;
  try {info = await fs.lstat(resultFile);}
  catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 || info.size > 64 * 1024 ||
      await exists(path.join(directory, OWNER)) || await exists(path.join(directory, ATTEMPT)))
    return null;
  let result;
  try {result = JSON.parse(await fs.readFile(resultFile, 'utf8'));}
  catch {return null;}
  if (result.platform !== 2 || target && result.target !== target ||
      result.verified !== true || result.error ||
      result.rpc?.mode !== 'held' || result.rpc?.state !== 'listening' ||
      !/^[a-f0-9]{64}$/.test(result.sourceSha256)) return null;
  return {path:directory, modified:info.mtimeMs};
}

async function findPossibleRuns(sessionsRoot) {
  const sessions = [];
  for (const entry of (await entries(sessionsRoot)).filter(item => item.isDirectory() && SESSION_NAME.test(item.name)).slice(0, MAX_SESSION_ENTRIES)) {
    const folder = path.join(sessionsRoot, entry.name);
    try {sessions.push({folder, modified:(await privateDirectory(folder)).mtimeMs});}
    catch {continue;}
  }
  sessions.sort((a,b) => b.modified - a.modified);
  const runs = [];
  for (const session of sessions.slice(0, MAX_SESSIONS)) {
    const vendor = path.join(session.folder, 'vendor');
    try {
      await privateDirectory(vendor);
      for (const host of await entries(vendor)) {
        if (!host.isDirectory() || host.name !== 'ns2jb' && !SAVEKIT_HOST.test(host.name)) continue;
        const runsFolder = path.join(vendor, host.name, 'runs');
        try {await privateDirectory(path.join(vendor, host.name)); await privateDirectory(runsFolder);}
        catch {continue;}
        for (const run of await entries(runsFolder)) {
          if (!run.isDirectory() || !RUN_NAME.test(run.name)) continue;
          const directory = path.join(runsFolder, run.name);
          try {
            await privateDirectory(directory);
            const candidate = await possibleHeldRun(directory);
            if (candidate) runs.push(candidate);
          } catch {continue;}
        }
      }
    } catch {}
    const civRuns = path.join(session.folder, 'runs');
    try {await privateDirectory(civRuns);} catch {continue;}
    const stages = [];
    for (const entry of (await entries(civRuns)).filter(item =>
      item.isDirectory() && (CIV_STAGE_NAME.test(item.name) || ARTEMIS_STAGE_NAME.test(item.name))).slice(0, MAX_CIV_STAGE_ENTRIES)) {
      const folder = path.join(civRuns, entry.name);
      try {stages.push({folder, modified:(await privateDirectory(folder)).mtimeMs});}
      catch {continue;}
    }
    stages.sort((a,b) => b.modified - a.modified);
    for (const stage of stages.slice(0, MAX_CIV_STAGES)) {
      const port = path.join(stage.folder, 'port');
      const engine = path.join(port, 'engine');
      const runsFolder = path.join(engine, 'runs');
      try {await privateDirectory(port); await privateDirectory(engine); await privateDirectory(runsFolder);}
      catch {continue;}
      for (const run of (await entries(runsFolder)).slice(0, MAX_CIV_RUN_ENTRIES)) {
        if (!run.isDirectory() || !RUN_NAME.test(run.name)) continue;
        const directory = path.join(runsFolder, run.name);
        try {
          await privateDirectory(directory);
          const candidate = await possibleHeldRun(directory,
            ARTEMIS_STAGE_NAME.test(path.basename(stage.folder)) ? 'artemis-seedsow' : 'civ7');
          if (candidate) runs.push(candidate);
        } catch {continue;}
      }
    }
  }
  return runs.sort((a,b) => b.modified - a.modified).slice(0, MAX_RUNS);
}

async function discover(root, sessionsRoot, options = {}) {
  if (typeof sessionsRoot !== 'string' || !path.isAbsolute(sessionsRoot) ||
      path.resolve(sessionsRoot) !== sessionsRoot)
    throw Error('Choose the canonical local Sessions folder.');
  try {await privateDirectory(sessionsRoot);}
  catch (error) {if (error.code === 'ENOENT') return {candidates:[]}; throw error;}
  const inspectRun = options.inspect || inspect;
  const deadline = Date.now() + (options.maxDurationMs ?? MAX_DURATION_MS);
  const candidates = [];
  let attempts = 0;
  for (const run of await findPossibleRuns(sessionsRoot)) {
    if (attempts >= MAX_PROBES || candidates.length >= MAX_RESULTS || Date.now() >= deadline) break;
    attempts++;
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - Date.now());
    const timeoutMs = Math.min(PROBE_TIMEOUT_MS, remaining);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {controller.abort(); reject(Error('RPC discovery probe timed out.'));}, timeoutMs);
    });
    try {
      const verified = await Promise.race([inspectRun(root, run.path, {
        timeoutMs, signal:controller.signal, allowRetainedBusy:true
      }), timeout]);
      if (verified.directory === run.path && verified.session === path.basename(run.path) &&
          typeof verified.description === 'string' && typeof verified.profileId === 'string')
        candidates.push({path:run.path, description:verified.description, session:verified.session,
          profileId:verified.profileId, modified:new Date(run.modified).toISOString()});
    } catch {}
    finally {clearTimeout(timer); controller.abort();}
  }
  return {candidates};
}

async function main() {
  if (process.argv.length !== 3) throw Error('Usage: gui-discover-rpc.cjs <Sessions folder>');
  const root = path.resolve(__dirname, '..');
  process.stdout.write(JSON.stringify(await discover(root, process.argv[2]))+'\n');
}

module.exports = {discover, findPossibleRuns};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode=1;});
