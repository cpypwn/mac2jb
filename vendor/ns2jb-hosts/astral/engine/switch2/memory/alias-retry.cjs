'use strict';
// A retry is permitted only after the owned cache entry was restored and the
// observed bytes were exactly the known ordinary-content control.
function cleanAliasDecision({selectedAlias, normalContent, restored}, completed, limit) {
  if (!Number.isInteger(completed) || !Number.isInteger(limit) || completed < 1 || limit < 1 || completed > limit)
    throw Error('Invalid clean-alias retry accounting');
  if (selectedAlias) return 'accept';
  if (!normalContent) return 'reject';
  if (restored !== true) return 'reject';
  return completed < limit ? 'retry' : 'exhausted';
}
module.exports = {cleanAliasDecision};
