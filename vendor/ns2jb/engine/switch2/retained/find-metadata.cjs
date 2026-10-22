// Locate the native allocator's external link from this session's captures.
const fs = require('node:fs/promises');
const path = require('node:path');
const memory = require('../tools/endpoint.cjs');
const {linksFrom} = require('./links.cjs');
const rpc = require('../../shared/rpc.cjs');
const {lowerWindow} = require("./lower-window.cjs");
const check = (ok, message) => { if (!ok) throw Error(message); };

function poolBounds(links, seed) {
  check(links.length > 0, 'The pool capture has no native links');
  const size = 0x2000000, alignment = 0x200000;
  if (seed !== undefined) {
    check(Number.isSafeInteger(seed) && seed % 0x4000 === 0, 'Expected the verified native pool page');
    const candidates = [];
    for (let start = Math.ceil((seed + 0x4000 - size) / alignment) * alignment;
      start <= seed; start += alignment) {
      // The initial capture can extend into the next allocation. Only headers
      // inside a candidate pool constrain that pool's linked pages.
      const inside = links.filter(link => link.source >= start && link.source + 0x4000 <= start + size);
      if (inside.length && inside.every(link => link.value >= start && link.value + 0x4000 <= start + size))
        candidates.push(start);
    }
    check(candidates.length > 0, 'Native links do not fit the pool containing the verified page');
    return {first: candidates[0], last: candidates.at(-1), size, alignment, seed,
      candidates, observedLinks: links.length};
  }
  const low = Math.min(...links.flatMap(link => [link.source, link.value]));
  const high = Math.max(...links.flatMap(link => [link.source, link.value]));
  const first = Math.ceil((high + 0x4000 - size) / alignment) * alignment;
  const last = Math.floor(low / alignment) * alignment;
  check(Number.isSafeInteger(first) && first <= last, 'Native links do not fit the pool layout');
  return {first, last, size, alignment, low, high};
}

async function resolvePool(socket, info, source, evidence, save) {
  const captures = [source.result];
  const links = linksFrom(source.bytes, source.result.address, source.result.address);
  const search = evidence.poolSearch = {captures: [], hypotheses: []};
  for (let index = 0; index <= 128; index++) {
    const bounds = poolBounds(links, source.result.address);
    search.hypotheses.push(bounds);
    if (bounds.first === bounds.last) {
      await save();
      return {start: bounds.first, ...bounds};
    }
    check(index < 128, 'Additional pool links did not resolve the allocation boundary');
    // Read only a bucket contained in every remaining pool hypothesis. Follow
    // uncaptured native links first; fill an uncaptured gap if they cycle.
    const cycle = info.bucketPeriod, bias = info.plan.addressBias;
    const covered = start => captures.some(c => c.address <= start && start + cycle <= c.address + c.length);
    const inside = start => start >= bounds.last && start + cycle <= bounds.first + bounds.size;
    const targets = [...new Set(links.map(link => link.value))].sort((a, b) => index % 2 ? b - a : a - b);
    let start = targets.map(address => bias + Math.floor((address - bias) / cycle) * cycle)
      .find(address => inside(address) && !covered(address));
    if (start === undefined) {
      for (let address = bias + Math.ceil((bounds.last - bias) / cycle) * cycle;
        inside(address); address += cycle) {
        if (!covered(address)) { start = address; break; }
      }
    }
    check(start !== undefined, 'The shared pool range has no further uncaptured buckets');
    const capture = await memory.read(socket, start, cycle);
    captures.push(capture.result); search.captures.push(capture.result);
    links.push(...linksFrom(capture.bytes, start, source.result.address));
    await save();
  }
}

async function main(supervisorFile) {
  const deadline = Date.now() + 600000;
  let supervisor;
  for (;;) {
    supervisor = JSON.parse(await fs.readFile(supervisorFile));
    if (supervisor.stage === 'memory-ready') break;
    check(!supervisor.error && Date.now() < deadline, 'Acquisition did not become ready');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const reportFile = supervisor.attempts.at(-1).report;
  const report = JSON.parse(await fs.readFile(reportFile));
  const current = await rpc.request({command: 'status'});
  check(current.ready && rpc.a.platform === 2 && rpc.a.session === report.session && report.memoryControl.ready,
    'Expected the current retained boot');
  const socket = report.memoryControl.socketPath;
  const info = await memory.request(socket, {command: 'info'});
  check(info.phase === 'bootstrap' && info.plan.readOffset >= 0x3000000,
    'Expected a broad bootstrap mapping');
  const evidence = {session: report.session, report: reportFile, started: new Date().toISOString(),
    casesBefore: report.cases.length, attempts: []};
  const file = path.join(__dirname, report.session + '-metadata-' + Date.now() + '.json');
  const save = () => fs.writeFile(file, JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  await save();
  try {
    const source = await memory.read(socket, info.plan.target, 0x500000);
    evidence.poolCapture = source.result;
    evidence.poolHypothesis = await resolvePool(socket, info, source, evidence, save);
    const {start: first, size} = evidence.poolHypothesis;
    const node = first + 0x3a00000;
    const start = info.plan.addressBias + Math.floor((node - info.plan.addressBias) / info.bucketPeriod) * info.bucketPeriod;
    evidence.pending = {address: start, length: node - start + 0x1000};
    await save();
    const capture = await memory.read(socket, start, evidence.pending.length);
    evidence.nodeCapture = capture.result;
    const offset = node - start;
    const next = Number(capture.bytes.readBigUInt64LE(offset));
    const previous = Number(capture.bytes.readBigUInt64LE(offset + 8));
    const extent = Number(capture.bytes.readBigUInt64LE(offset + 16));
    check(Number.isSafeInteger(next) && next >= 2 ** 32 && next < 2 ** 39 && next % 8 === 0 &&
      next === previous && Math.abs(next - node) > 0x8000000 &&
      Number.isSafeInteger(extent) && extent >= 0x10000 && extent <= 0x10000000 && extent % 0x1000 === 0,
    'The native bytes do not reproduce the external allocator link');
    evidence.node = {address: node, next, previous, extent,
      observedHex: capture.bytes.subarray(offset, offset + 64).toString('hex')};
    delete evidence.pending;
    await save();
    console.log(JSON.stringify({stage: 'external-link', file, ...evidence.node}));
    const page = Math.floor(next / 0x4000) * 0x4000;
    const plan = lowerWindow(page, Number(report.storageSize), info.bucketPeriod,
      [Math.floor(info.plan.target / 0x4000) * 0x4000]);
    const fallback = info.plan.addressBias + plan.readOffset;
    if (![source.result, capture.result].some(item => item.address <= fallback &&
        fallback + 0x4000 <= item.address + item.length)) {
      check(fallback >= first && fallback + 0x4000 <= first + size,
        'A missed-header control is outside the identified native buffer pool');
      evidence.fallbackCapture = (await memory.read(socket, fallback, 0x4000)).result;
      await save();
    }
    const anchor = Buffer.alloc(16);
    anchor.writeBigUInt64LE(BigInt(node));
    anchor.writeBigUInt64LE(BigInt(node), 8);
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await memory.request(socket, {command: 'retained-bootstrap-move',
        address: page, length: 0x4000, anchorOffset: next - page, anchorHex: anchor.toString('hex')});
      evidence.attempts.push(result);
      await save();
      console.log(JSON.stringify({stage: result.verified ? 'metadata-verified' : 'header-missed',
        file, attempt, capture: result.capture}));
      if (result.verified) {
        evidence.verified = true;
        evidence.metadata = await memory.request(socket, {command: 'retained-bootstrap-read',
          address: page - 0x500000, length: 0x4d8000});
        console.log(JSON.stringify({stage: 'metadata-captured', file, capture: evidence.metadata}));
        return evidence;
      }
    }
    throw Error('Guarded metadata selection did not take effect');
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    evidence.finished = new Date().toISOString();
    await save();
  }
}

if (require.main === module) main(process.argv[2]).catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {main, poolBounds, resolvePool};
