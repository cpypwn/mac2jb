// The owned cleanup layer reports the marker's terminal state exactly. The
// deleteMarker skip keeps the nonce-bound marker in place without re-opening or
// overwriting it, so "retained" is a valid verified outcome alongside "removed"
// (deleted) and "neutralized" (overwritten with zeroed content).
function markerCleanupVerified(cleanup) {
  if (cleanup?.markerRemoved === true) return true;
  if (cleanup?.markerNeutralized === true && cleanup.markerRemoved === false) return true;
  if (cleanup?.markerRetained === true &&
      cleanup.markerNeutralized === false &&
      cleanup.markerRemoved === false) return true;
  return false;
}

function markerCleanupSummary(cleanup) {
  if (!markerCleanupVerified(cleanup)) {
    throw Error('marker cleanup is not verified');
  }
  return {markerRemoved: cleanup.markerRemoved === true,
    markerNeutralized: cleanup.markerNeutralized === true,
    markerRetained: cleanup.markerRetained === true};
}

module.exports = {markerCleanupVerified, markerCleanupSummary};
