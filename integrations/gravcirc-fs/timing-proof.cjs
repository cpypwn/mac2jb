const {qualifyTiming} = require('./qualify-timing.cjs');

async function qualifyTimingProof({switchIp}, dependencies = {}) {
  const measured = await (dependencies.qualifyTiming || qualifyTiming)({host: switchIp});
  return {...measured, issuedAt: Date.now()};
}

module.exports = {qualifyTimingProof};
