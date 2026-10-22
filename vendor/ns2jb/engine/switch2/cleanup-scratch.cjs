// Reclaim scratch from interrupted launches using their saved ownership records.
const fs = require('node:fs/promises');
const path = require('node:path');
const check = (ok, message) => {if (!ok) throw Error(message);};

async function previousScratch() {
  const current = path.resolve(__dirname, '..'), workspace = path.dirname(current), found = [];
  for (const entry of await fs.readdir(workspace, {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^switch2-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const directory = path.join(workspace, entry.name);
    if (directory === current) continue;
    let acquisition;
    try {acquisition = JSON.parse(await fs.readFile(path.join(directory, 'switch2/current-acquisition.json')));}
    catch (error) {if (error.code === 'ENOENT') continue; throw error;}
    check(path.dirname(acquisition.report) === path.join(directory, 'switch2/memory') &&
      /^reserved-gap-[0-9]+\.json$/.test(path.basename(acquisition.report)), 'Previous acquisition path differs');
    const report = JSON.parse(await fs.readFile(acquisition.report));
    check(report.session === entry.name, 'Previous scratch belongs to a different launch');
    if (report.cleanedUp || !report.retained?.created?.length) continue;
    check(/^\/NS2_GAP_[0-9]{13}$/.test(report.scratch) && report.retained.created.every(item =>
      ['save', 'tmp'].includes(item.name) && item.path === report.scratch), 'Previous scratch ownership is incomplete');
    found.push({source: acquisition.report, scratch: report.scratch, mounts: report.retained.created.map(item => item.name)});
  }
  return found;
}

async function main() {
  const previous = await previousScratch();
  const proof = {started: new Date().toISOString(), previous, removed: [], cleanedUp: false};
  if (!previous.length) return {...proof, cleanedUp: true};
  const {Session, live} = require('./app/session.cjs');
  const mounted = require('./app/mounted-save.cjs');
  const filesystem = require('./app/filesystem.cjs');
  const domain = require('./app/domain.cjs');
  const {paths} = require('./memory/paths.cjs');
  const s = new Session('cleanup-prior-launches');
  proof.session = live.session;
  const file = path.join(__dirname, 'scratch-cleanup.json');
  const save = () => fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  try {
    await s.initialize();
    const {normal} = paths(s, domain);
    for (const name of ['save', 'tmp']) {
      const handle = await mounted.cloneMountedFilesystem(s, name);
      for (const record of previous.filter(item => item.mounts.includes(name))) {
        const entry = await normal(handle, 7, record.scratch);
        if (entry.canonicalResult === 0x202) continue;
        check(!entry.result && entry.data.readUInt32LE() === 0, 'Previous scratch is not a directory');
        const contents = await filesystem.listDirectory(s, handle, record.scratch);
        if (name === 'save') {
          check(contents.length === 3 && contents.every(item => ['canary', 'selected', 'commit_data'].includes(item.name)),
            'Previous scratch contents changed; inspect ' + record.source);
          const data = contents.find(item => item.name === 'commit_data');
          check(data.type === 1 && data.size === String(0x1000000), 'Previous commit file changed');
        } else check(contents.length === 1 && contents[0].type === 0 && /^S0_[0-9]{13}$/.test(contents[0].name),
          'Previous temporary directory changed');
        proof.pending = {name, path: record.scratch}; await save();
        check(!(await normal(handle, 4, record.scratch)).result, 'Previous scratch removal failed');
        check(!(await s.ipc('Commit previous scratch removal', handle, 10)).result, 'Scratch cleanup commit failed');
        check((await normal(handle, 7, record.scratch)).canonicalResult === 0x202, 'Previous scratch still exists');
        proof.removed.push(proof.pending); delete proof.pending; await save();
      }
      await s.close(handle);
    }
  } catch (error) {proof.error = error.stack; throw error;}
  finally {
    await s.cleanup(); proof.cleanedUp = !s.base && !s.handles.size;
    proof.completed = new Date().toISOString(); await save();
  }
  return proof;
}

module.exports = {main};
