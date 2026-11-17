const fs = require('node:fs/promises');
const path = require('node:path');
const {Session, live} = require('./session.cjs');
const {loadTarget} = require('../../shared/target.cjs');
const {probeStorage} = require('./storage-probe-core.cjs');

async function main() {
  if (loadTarget().name !== 'gravcirc') throw Error('This probe requires NS2_TARGET=gravcirc');
  const started = new Date().toISOString();
  const session = new Session('storage-probe-' + Date.now());
  const report = {target: 'gravcirc', session: live.session, started};
  try {
    await session.initialize();
    report.probe = await probeStorage(session);
  } catch (error) {
    report.error = error.stack;
  } finally {
    try {await session.cleanup();}
    catch (error) {report.cleanupError = error.stack;}
  }
  report.completed = new Date().toISOString();
  const file = path.join(__dirname, 'storage-probe-' + Date.now() + '.json');
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify({file, probe: report.probe, error: report.error,
    cleanupError: report.cleanupError}));
  if (report.error || report.cleanupError) process.exitCode = 1;
}

if (require.main === module)
  main().catch(error => {console.error(error.stack); process.exitCode = 1;});

module.exports = {main};
