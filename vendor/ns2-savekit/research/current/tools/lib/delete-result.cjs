'use strict';
// Result handling for save-delete-root.cjs, kept separate so it can be tested
// without a console.
//
// The tool used to print the DeleteFile result and then rely on the commit,
// which made a failed delete that committed nothing look like success. The
// contract now is:
//   0   deleted, committed, and a read-only reopen proves it is absent
//   10  the file was already absent (not a deletion, but truthful)
//   11  the filesystem refused the delete, or the file is still present
//   12  the delete was accepted but the commit failed
//   3   session lost
//   4   no live host
const EXIT = {
  ok: 0,
  other: 1,
  usage: 2,
  sessionLost: 3,
  noHost: 4,
  notFound: 10,
  failed: 11,
  commit: 12,
};

// Horizon Result encoding: bits 0-8 are the description, bits 9-17 the module.
// The filesystem module is 1 and PathNotFound is description 2, so the canonical
// result is (1 << 9) | 2 = 0x202. The engine's domain.cjs stores
// `canonicalResult = result & 0x3fffff`, so that is the value seen here; a bare
// 0x2 is a description without a module and is NOT treated as "not found"
// (save-write-stage.cjs uses the same 0x202 comparison).
const FS_NOT_FOUND = 0x202;

function classifyFsResult(canonical) {
  const value = Number(canonical) & 0x3fffff;
  if (value === 0) return 'deleted';
  if (value === FS_NOT_FOUND) return 'not-found';
  return 'failed';
}

function exitForClass(classification) {
  if (classification === 'deleted') return EXIT.ok;
  if (classification === 'not-found') return EXIT.notFound;
  return EXIT.failed;
}

// Decide the whole delete transaction from its observations, so a commit
// failure or a file that survives the delete cannot be reported as success.
//   fsResult     the canonical DeleteFile result
//   commitResult the Commit result (0 = committed); null when no commit ran
//   stillPresent the read-only reopen proved the file is still there
function decideDelete({fsResult, commitResult = null, stillPresent = null}) {
  const classification = classifyFsResult(fsResult);
  if (classification === 'failed') {
    return {classification, code: EXIT.failed, needsCommit: false, verify: false,
      reason: 'refused'};
  }
  if (classification === 'not-found') {
    // Already absent needs no commit, but it still needs a verified read-back.
    if (stillPresent === null) {
      return {classification, code: EXIT.other, needsCommit: false, verify: true,
        reason: 'unverified'};
    }
    if (stillPresent === true) {
      return {classification, code: EXIT.failed, needsCommit: false, verify: true,
        reason: 'still-present'};
    }
    return {classification, code: EXIT.notFound, needsCommit: false, verify: true,
      reason: 'already-absent'};
  }
  // A real deletion needs an explicit successful commit. A missing commit
  // result is NOT success, even if the file happens to be absent.
  if (commitResult === null) {
    return {classification, code: EXIT.other, needsCommit: true, verify: false,
      reason: 'commit-missing'};
  }
  if (Number(commitResult) !== 0) {
    return {classification, code: EXIT.commit, needsCommit: true, verify: false,
      reason: 'commit-failed'};
  }
  if (stillPresent === null) {
    return {classification, code: EXIT.other, needsCommit: true, verify: true,
      reason: 'unverified'};
  }
  if (stillPresent === true) {
    return {classification, code: EXIT.failed, needsCommit: true, verify: true,
      reason: 'still-present'};
  }
  return {classification, code: EXIT.ok, needsCommit: true, verify: true,
    reason: 'deleted'};
}

// A caller that is cleaning up may treat "already absent" as success; it must
// never treat a failed delete as success.
function isGone(exitCode) {
  return exitCode === EXIT.ok || exitCode === EXIT.notFound;
}

function exitForErrorText(text) {
  const value = String(text || '');
  if (/ENOENT.*memory\.sock/i.test(value)) return EXIT.noHost;
  if (/transport (?:failed )?0xf601/i.test(value)) return EXIT.sessionLost;
  return EXIT.other;
}

module.exports = {EXIT, FS_NOT_FOUND, classifyFsResult, exitForClass, decideDelete,
  isGone, exitForErrorText};
