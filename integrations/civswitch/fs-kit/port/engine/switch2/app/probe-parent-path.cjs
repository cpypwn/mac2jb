// Compare short, owned save paths with the /..\ prefix used by the FS probe.
// This diagnostic performs no race, heap grooming, or cross-title operation.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const check = (condition, message) => {if (!condition) throw Error(message);};

const MAX_VISIBLE_PATH_BYTES = 0x300;
const LONG_FORWARD_BYTES = 0x800;
const LONG_FORWARD_SUFFIX_OFFSET = 0x700;
const LONG_FORWARD_TERMINATOR_OFFSET = 0x7ff;

function plan(scratch) {
  check(/^\/NS2_GAP_PARENT_[0-9a-f]{12}$/.test(scratch), 'Invalid owned scratch path');
  const marker = 'MARKER', absent = 'ABSENT';
  const paired = (id, makePath) => [marker, absent].map(kind => ({
    id, kind: kind.toLowerCase(), path: makePath(kind),
  }));
  const rows = [
    ...paired('direct', kind => `${scratch}/${kind}`),
    ...paired('slash-parent', kind => `${scratch}/selected/../${kind}`),
    ...paired('backslash-parent', kind => `${scratch}/selected/..\\${kind}`),
    ...paired('backslash-parent-slash', kind => `${scratch}/selected/..\\/${kind}`),
    ...paired('root-backslash-parent', kind => `/..\\${scratch.slice(1)}/${kind}`),
    ...paired('root-slash-parent', kind => `/../${scratch.slice(1)}/${kind}`),
  ];
  check(rows.every(row => row.path.startsWith('/') && !row.path.includes('\0') &&
    Buffer.byteLength(row.path, 'utf8') + 1 <= MAX_VISIBLE_PATH_BYTES),
  'Parent-path diagnostic exceeds the short-path bound');
  return rows.map(row => ({...row, pathBytes: Buffer.byteLength(row.path, 'utf8') + 1}));
}

function twoParentPlan(scratch) {
  check(/^\/NS2_GAP_PARENT_[0-9a-f]{12}$/.test(scratch), 'Invalid owned scratch path');
  const selected = scratch + '/selected', absent = scratch + '/UNOWNEDX';
  const prefixes = [
    ['forward', `${scratch}/selected/../../`],
    ['backslash-slash', `${scratch}/selected/..\\/../`],
    ['backslash-direct', `${scratch}/selected/..\\../`],
    ['backslash-double', `${scratch}/selected/..\\..\\`],
  ];
  check(Buffer.byteLength(selected) === Buffer.byteLength(absent),
    'Matched directory names differ in length');
  const rows = prefixes.flatMap(([id, prefix]) => [
    {id, kind: 'selected', path: prefix + selected},
    {id, kind: 'absent', path: prefix + absent},
  ]);
  check(rows.every(row => row.path.startsWith('/') && !row.path.includes('\0') &&
    Buffer.byteLength(row.path, 'utf8') + 1 <= MAX_VISIBLE_PATH_BYTES),
  'Two-parent diagnostic exceeds the short-path bound');
  return rows.map(row => ({...row, pathBytes: Buffer.byteLength(row.path, 'utf8') + 1}));
}

function longForwardBytes(scratch, kind) {
  check(/^\/NS2_GAP_PARENT_[0-9a-f]{12}$/.test(scratch), 'Invalid owned scratch path');
  check(['selected', 'absent'].includes(kind), 'Invalid long forward-path kind');
  const prefix = `${scratch}/selected/../../`;
  const suffix = `${scratch}/${kind === 'selected' ? 'selected' : 'UNOWNEDX'}`;
  check(Buffer.byteLength(prefix) < LONG_FORWARD_SUFFIX_OFFSET &&
    LONG_FORWARD_SUFFIX_OFFSET + Buffer.byteLength(suffix) < LONG_FORWARD_TERMINATOR_OFFSET,
  'Long forward-path source exceeds the accepted descriptor');
  const bytes = Buffer.alloc(LONG_FORWARD_BYTES, '/');
  bytes.write(prefix, 0, 'ascii');
  bytes.write(suffix, LONG_FORWARD_SUFFIX_OFFSET, 'ascii');
  bytes[LONG_FORWARD_TERMINATOR_OFFSET] = 0;
  check(bytes.subarray(0, LONG_FORWARD_TERMINATOR_OFFSET).every(byte => byte !== 0),
    'Long forward-path source contains an early terminator');
  return {kind, bytes, path: bytes.subarray(0, LONG_FORWARD_TERMINATOR_OFFSET).toString('ascii'),
    pathBytes: LONG_FORWARD_BYTES, descriptorBytes: LONG_FORWARD_BYTES,
    suffixOffset: LONG_FORWARD_SUFFIX_OFFSET,
    terminatorOffset: LONG_FORWARD_TERMINATOR_OFFSET,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
}

function observation(reply) {
  check(Number.isInteger(reply?.result) && Number.isInteger(reply?.canonicalResult),
    'Invalid GetEntryType reply');
  check(reply.canonicalResult !== 0 || Buffer.isBuffer(reply.data) && reply.data.length >= 4,
    'GetEntryType reply lacks an entry type');
  return {result: reply.result, canonicalResult: reply.canonicalResult,
    type: reply.canonicalResult === 0 ? reply.data.readUInt32LE() : null};
}

function isMarker(row) {return row?.result === 0 && row?.canonicalResult === 0 && row?.type === 1;}
function isAbsent(row) {return row?.result === 0x202 && row?.canonicalResult === 0x202 && row?.type === null;}
function isDirectory(row) {return row?.result === 0 && row?.canonicalResult === 0 && row?.type === 0;}

function classify(lookups) {
  const pairs = [];
  for (let i = 0; i < lookups.length; i += 2) {
    const marker = lookups[i], absent = lookups[i + 1];
    check(marker?.id === absent?.id && marker?.kind === 'marker' && absent?.kind === 'absent',
      'Mismatched parent-path controls');
    pairs.push({id: marker.id, marker: {result: marker.result, type: marker.type},
      absent: {result: absent.result, type: absent.type},
      selectedOwnedMarker: isMarker(marker) && isAbsent(absent)});
  }
  return pairs;
}

function classifyTwoParent(lookups) {
  const pairs = [];
  for (let i = 0; i < lookups.length; i += 2) {
    const selected = lookups[i], absent = lookups[i + 1];
    check(selected?.id === absent?.id && selected?.kind === 'selected' &&
      absent?.kind === 'absent', 'Mismatched two-parent controls');
    pairs.push({id: selected.id, selected: {result: selected.result, type: selected.type},
      absent: {result: absent.result, type: absent.type},
      selectedOwnedDirectory: isDirectory(selected) && isAbsent(absent)});
  }
  return pairs;
}

function assessTwoParent(report) {
  if (report?.enabled !== true || !isDirectory(report.before?.selected) ||
      !isAbsent(report.before?.absent) || !isDirectory(report.after?.selected) ||
      !isAbsent(report.after?.absent) || !Array.isArray(report.lookups) ||
      report.lookups.length !== 8 || !Array.isArray(report.pairs) ||
      report.pairs.length !== 4) return false;
  const expected = twoParentPlan(report.scratch);
  return expected.every((row, index) => {
    const observed = report.lookups[index];
    return observed.id === row.id && observed.kind === row.kind &&
      observed.path === row.path && observed.pathBytes === row.pathBytes &&
      Number.isInteger(observed.result) && Number.isInteger(observed.canonicalResult) &&
      (observed.type === null || Number.isInteger(observed.type));
  }) && JSON.stringify(report.pairs) === JSON.stringify(classifyTwoParent(report.lookups));
}

function assessLongForward(report) {
  if (report?.enabled !== true || !/^\/NS2_GAP_PARENT_[0-9a-f]{12}$/.test(report.scratch) ||
      !isDirectory(report.before?.selected) || !isAbsent(report.before?.absent) ||
      !isDirectory(report.after?.selected) || !isAbsent(report.after?.absent) ||
      !Array.isArray(report.lookups) || report.lookups.length !== 2) return false;
  return ['selected', 'absent'].every((kind, index) => {
    const expected = longForwardBytes(report.scratch, kind);
    const row = report.lookups[index];
    return row.kind === kind && row.pathBytes === expected.pathBytes &&
      row.descriptorBytes === expected.descriptorBytes &&
      row.suffixOffset === expected.suffixOffset &&
      row.terminatorOffset === expected.terminatorOffset &&
      row.sha256 === expected.sha256 && row.path === expected.path &&
      (kind === 'selected' ? isDirectory(row) : isAbsent(row));
  });
}

function assess(report) {
  if (report?.target !== 'gravcirc' || !report.session || report.error || report.cleanupError ||
      !/^\/NS2_GAP_PARENT_[0-9a-f]{12}$/.test(report.scratch) ||
      !report.scratchAbsent || !report.cleanedUp || !isMarker(report.before?.marker) ||
      !isAbsent(report.before?.absent) || !isMarker(report.after?.marker) ||
      !isAbsent(report.after?.absent) || !Array.isArray(report.lookups) ||
      report.lookups.length !== 12 || !Array.isArray(report.pairs) ||
      report.pairs.length !== 6) return false;
  const expected = plan(report.scratch);
  return expected.every((row, index) => {
    const observed = report.lookups[index];
    return observed.id === row.id && observed.kind === row.kind &&
      observed.path === row.path && observed.pathBytes === row.pathBytes &&
      Number.isInteger(observed.result) && Number.isInteger(observed.canonicalResult) &&
      (observed.type === null || Number.isInteger(observed.type));
  }) && JSON.stringify(report.pairs) === JSON.stringify(classify(report.lookups)) &&
    report.pairs[0].selectedOwnedMarker === true &&
    (report.twoParentEnabled !== true ||
      report.twoParent?.scratch === report.scratch && assessTwoParent(report.twoParent)) &&
    (report.longForwardEnabled !== true ||
      report.longForward?.scratch === report.scratch && assessLongForward(report.longForward));
}

async function main() {
  const {Session, live, u64} = require('./session.cjs');
  const mounted = require('./mounted-save.cjs');
  const domain = require('./domain.cjs');
  const {paths} = require('../memory/paths.cjs');
  const {loadTarget} = require('../../shared/target.cjs');
  check(loadTarget().name === 'gravcirc', 'Parent-path diagnostic requires Gravity Circuit');
  const twoParentEnabled = process.env.NS2_GC_TWO_PARENT_SEMANTICS === '1';
  const longForwardEnabled = process.env.NS2_GC_LONG_FORWARD_SEMANTICS === '1';
  check(!longForwardEnabled || twoParentEnabled,
    'Long forward-path control requires matched two-parent controls');
  const scratch = '/NS2_GAP_PARENT_' + crypto.randomBytes(6).toString('hex');
  const report = {target: 'gravcirc', session: live.session, started: new Date().toISOString(),
    mode: 'short-owned-path-semantics', scratch, maxVisiblePathBytes: MAX_VISIBLE_PATH_BYTES,
    lookups: [], before: {}, after: {}, twoParentEnabled, longForwardEnabled,
    scratchAbsent: false, cleanedUp: false};
  const s = new Session('parent-path-' + Date.now(), 0x10000);
  const file = path.join(__dirname, 'parent-path-' + Date.now() + '.json');
  let saved, created = false;
  const {normal, raw} = paths(s, domain);
  const query = async (filename) => observation(await normal(saved, 7, filename));
  try {
    await s.initialize();
    saved = await mounted.cloneMountedFilesystem(s, 'save');
    check((await query(scratch)).canonicalResult === 0x202,
      'Owned parent-path scratch already exists');
    check(!(await normal(saved, 2, scratch)).result, 'Owned parent-path scratch creation failed');
    created = true;
    check(!(await normal(saved, 2, scratch + '/selected')).result,
      'Owned selected directory creation failed');
    check(!(await normal(saved, 0, scratch + '/MARKER',
      Buffer.concat([u64(0), u64(1)]))).result,
    'Owned parent marker creation failed');
    report.before = {marker: await query(scratch + '/MARKER'),
      absent: await query(scratch + '/ABSENT')};
    check(isMarker(report.before.marker) && isAbsent(report.before.absent),
      'Direct marker or matched absent control failed');
    for (const row of plan(scratch))
      report.lookups.push({...row, ...await query(row.path)});
    report.pairs = classify(report.lookups);
    report.after = {marker: await query(scratch + '/MARKER'),
      absent: await query(scratch + '/ABSENT')};
    check(isMarker(report.after.marker) && isAbsent(report.after.absent),
      'Direct marker or matched absent control changed');
    if (twoParentEnabled) {
      const selected = scratch + '/selected', absent = scratch + '/UNOWNEDX';
      const direct = async () => ({selected: await query(selected), absent: await query(absent)});
      report.twoParent = {enabled: true, scratch, before: await direct(), lookups: [], after: {}};
      check(isDirectory(report.twoParent.before.selected) &&
        isAbsent(report.twoParent.before.absent),
      'Two-parent direct directory or matched absent control failed');
      for (const row of twoParentPlan(scratch))
        report.twoParent.lookups.push({...row, ...await query(row.path)});
      report.twoParent.pairs = classifyTwoParent(report.twoParent.lookups);
      report.twoParent.after = await direct();
      check(isDirectory(report.twoParent.after.selected) &&
        isAbsent(report.twoParent.after.absent),
      'Two-parent direct directory or matched absent control changed');
      if (longForwardEnabled) {
        const forward = report.twoParent.pairs.find(pair => pair.id === 'forward');
        check(forward?.selectedOwnedDirectory === true,
          'Short forward-parent control did not select the owned directory');
        const direct = async () => ({selected: await query(selected), absent: await query(absent)});
        report.longForward = {enabled: true, scratch, before: await direct(),
          lookups: [], after: {}};
        for (const kind of ['selected', 'absent']) {
          const source = longForwardBytes(scratch, kind);
          report.longForward.lookups.push({...source, bytes: undefined,
            ...observation(await raw(saved, 7, source.bytes))});
        }
        report.longForward.after = await direct();
        check(assessLongForward(report.longForward),
          'Accepted 0x800 forward-parent directory or matched absent control failed');
      }
    }
  } catch (error) {report.error = error.stack;}
  finally {
    if (created && saved) {
      try {
        check(await s.ready(), 'Application stopped before parent-path scratch cleanup');
        check(!(await normal(saved, 4, scratch)).result,
          'Owned parent-path scratch removal failed');
        check(!(await s.ipc('Commit parent-path scratch removal', saved, 10)).result,
          'Owned parent-path scratch commit failed');
        report.scratchAbsent = (await query(scratch)).canonicalResult === 0x202;
        check(report.scratchAbsent, 'Owned parent-path scratch remains');
      } catch (error) {report.cleanupError = error.stack;}
    }
    try {await s.cleanup();}
    catch (error) {report.cleanupError = [report.cleanupError, error.stack].filter(Boolean).join('\n');}
    report.cleanedUp = report.scratchAbsent && !s.base && !s.handles.size && !s.threads.size;
    report.completed = new Date().toISOString();
    report.verified = assess(report);
    await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({file, verified: report.verified, cleanedUp: report.cleanedUp,
      scratchAbsent: report.scratchAbsent, error: report.error, cleanupError: report.cleanupError}));
    if (!report.verified) process.exitCode = 1;
  }
  return report;
}

module.exports = {MAX_VISIBLE_PATH_BYTES, LONG_FORWARD_BYTES, LONG_FORWARD_SUFFIX_OFFSET,
  LONG_FORWARD_TERMINATOR_OFFSET, plan, twoParentPlan, longForwardBytes, observation,
  isMarker, isAbsent, isDirectory, classify, classifyTwoParent,
  assessTwoParent, assessLongForward, assess, main};
if (require.main === module) main().catch(error => {console.error(error.stack); process.exitCode = 1;});
