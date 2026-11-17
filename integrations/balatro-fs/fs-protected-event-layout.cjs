'use strict';

// Four existing owned handles, placed in the event worker's separate frame
// region. This layout carries only the proven negative protected-window roles.
const {ROLES} = require('./fs-protected-canary-plan.cjs');
const {planGapPortLayout} = require('./fs-gap-port-layout.cjs');

const WORKER_KIND = 'balatro-protected-four-layout-only';

function planProtectedEventLayout({preflight, prepared}) {
  const base = planGapPortLayout({preflight, prepared});
  const frames = ROLES.map((role, index) => Object.freeze({
    ...base.frames[index], role,
  }));
  return Object.freeze({
    ...base, workerKind: WORKER_KIND, frames,
    protectedRoles: Object.freeze([...ROLES]),
    targetWorkerQualified: false,
    positiveAttemptAllowed: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
  });
}

module.exports = {WORKER_KIND, ROLES, planProtectedEventLayout};
