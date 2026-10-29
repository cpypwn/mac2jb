// Read-only capture of the display imports used by the running application.
// In particular, do not invoke SDK GetService: it has a hidden x8 return ABI.
const fs = require('node:fs/promises');
const path = require('node:path');
const imports = require('./display-imports.json');

async function main(directory) {
  directory = path.resolve(directory);
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const report = {session: rpc.a.session, started: new Date().toISOString(), imports: {}};
  const save = () => fs.writeFile(path.join(directory, 'display-inspection.json'),
    JSON.stringify(report, null, 2), {mode: 0o600});
  try {
    for (const [name, entry] of Object.entries(imports)) {
      const thunk = await rpc.read(rpc.a.main + entry.plt, 16);
      if (thunk.toString('hex') !== entry.bytes) throw Error('Application import changed: ' + name);
      const target = Number((await rpc.read(rpc.a.main + entry.slot, 8)).readBigUInt64LE());
      if (!Number.isSafeInteger(target) || !target) throw Error('Invalid import address: ' + name);
      const region = await rpc.query(target);
      if ((region.permissions & 5) !== 5) throw Error('Import is not executable: ' + name);
      const unresolved = target === rpc.a.main + 0x29b850;
      report.imports[name] = {target, unresolved, region};
      if (!unresolved) {
        const size = Math.min(0x1000, region.address + region.size - target);
        await fs.writeFile(path.join(directory, name + '.bin'), await rpc.read(target, size), {mode: 0o600});
      }
      await save();
    }
    // Only interpret this global after matching the implementation that loads it.
    const reference = require('../smilebasic/reference/sdk-checks.cjs');
    const offset = 0x3d8200;
    const implementation = await rpc.read(rpc.a.sdk + offset, 32);
    if (!implementation.equals(reference.bytes(offset,32)))
      throw Error('SDK GetService implementation changed');
    report.sdkService = Number((await rpc.read(rpc.a.sdk + 0xd9ef88, 8)).readBigUInt64LE());
    report.sdkServiceIsNull = report.sdkService === 0;
    report.completed = new Date().toISOString();
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally { await save(); }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main(process.argv[2]).catch(error => {
  console.error(error.stack); process.exitCode = 1;
});
module.exports = {main};
