// Resolve input imports afresh for the connected console session. SmileBASIC
// binds HID imports lazily, so an import that Direct mode has not used yet still
// points at the module's resolver stub. Call its PLT entry once to bind it.
const fs = require('node:fs/promises');
const path = require('node:path');

const RESOLVER_OFFSET = 0x29b850;
const PLT_SCAN_OFFSET = 0x29b000;
const PLT_SCAN_BYTES = 0x3000;
// Keep the warm-up state clear of the bridge output (0x4040), input staging
// (0x40000) and the 0x10000 scratch slot used by later stages.
const WARM_OFFSET = 0x4ff00;
const WARM_BYTES = 0x30100;
const WARM_BUFFER_OFFSET = 0x50000;
const WARM_ID_OFFSET = 0x4ff00;
const PAD = '_ZN2nn3hid12GetNpadStateEPNS0_17NpadHandheldStateERKj';
const TOUCH = '_ZN2nn3hid19GetTouchScreenStateILm16EEEvPNS0_16TouchScreenStateIXT_EEE';

function decodePltSlot(bytes, at, pc) {
  if (at + 16 > bytes.length) return null;
  const adrp = bytes.readUInt32LE(at), load = bytes.readUInt32LE(at + 4);
  const add = bytes.readUInt32LE(at + 8), branch = bytes.readUInt32LE(at + 12);
  if (((adrp & 0x9f000000) >>> 0) !== 0x90000000 || (adrp & 0x1f) !== 16) return null;
  if (((load & 0xffc00000) >>> 0) !== 0xf9400000 || (load & 0x1f) !== 17 ||
      ((load >>> 5) & 0x1f) !== 16) return null;
  if (((add & 0xffc00000) >>> 0) !== 0x91000000 || (add & 0x1f) !== 16 ||
      ((add >>> 5) & 0x1f) !== 16) return null;
  if (branch !== 0xd61f0220) return null;
  const low = ((load >>> 10) & 0xfff) * 8;
  if (((add >>> 10) & 0xfff) !== low) return null;
  let immediate = (((adrp >>> 5) & 0x7ffff) << 2) | ((adrp >>> 29) & 3);
  if (immediate & (1 << 20)) immediate -= 1 << 21;
  const page = Math.floor(pc / 0x1000) * 0x1000;
  return page + immediate * 0x1000 + low;
}

async function findPlt(rpc, slotAddress) {
  const start = rpc.a.main + PLT_SCAN_OFFSET;
  const region = await rpc.query(start);
  const length = Math.min(PLT_SCAN_BYTES, region.address + region.size - start);
  const bytes = await rpc.read(start, length);
  for (let at = 0; at + 16 <= bytes.length; at += 4) {
    const address = start + at;
    if (decodePltSlot(bytes, at, address) === slotAddress)
      return {address, bytes: bytes.subarray(at, at + 16)};
  }
  return null;
}

async function resolveImport(rpc, slot, args, name) {
  const address = rpc.a.main + slot;
  let target = Number((await rpc.read(address, 8)).readBigUInt64LE());
  if (target !== rpc.a.main + RESOLVER_OFFSET) return {target};
  const plt = await findPlt(rpc, address);
  if (!plt) throw Error('Could not locate the PLT entry for ' + name);
  // call-address only accepts functions whose exact instructions were checked.
  await rpc.request({command: 'verify-function', address: plt.address,
    hex: plt.bytes.toString('hex')});
  await rpc.callAddress(plt.address, args);
  target = Number((await rpc.read(address, 8)).readBigUInt64LE());
  if (!Number.isSafeInteger(target) || !target || target === rpc.a.main + RESOLVER_OFFSET)
    throw Error('Import did not resolve: ' + name);
  return {target, plt: plt.address};
}

async function main(directory) {
  directory = path.resolve(directory);
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  const imports = require('./input-imports.json');
  const report = {session: rpc.a.session, started: new Date().toISOString(), imports: {}};
  const saveBase = rpc.a.scratch + WARM_OFFSET;
  const buffer = rpc.a.scratch + WARM_BUFFER_OFFSET;
  const id = rpc.a.scratch + WARM_ID_OFFSET;
  const saved = await rpc.read(saveBase, WARM_BYTES);
  try {
    const idBytes = Buffer.alloc(4);
    idBytes.writeUInt32LE(32);
    await rpc.write(id, idBytes);
    for (const [name, {slot}] of Object.entries(imports)) {
      const address = rpc.a.main + slot;
      let target = Number((await rpc.read(address, 8)).readBigUInt64LE());
      if (!Number.isSafeInteger(target) || !target)
        throw Error('Invalid input import: ' + name);
      let plt;
      if (target === rpc.a.main + RESOLVER_OFFSET) {
        if (name === PAD || name === TOUCH) {
          const resolved = await resolveImport(rpc, slot,
            name === PAD ? [buffer, id] : [buffer], name);
          target = resolved.target;
          plt = resolved.plt;
        } else {
          report.imports[name] = {slot, target, unresolved: true};
          continue;
        }
      }
      const region = await rpc.query(target);
      if ((region.permissions & 5) !== 5 || region.ipcReferences)
        throw Error('Input import is not in executable memory: ' + name);
      const bytes = await rpc.read(target, Math.min(256, region.address + region.size - target));
      report.imports[name] = {slot, target, region, bytes: bytes.toString('hex'), ...(plt ? {plt} : {})};
    }
    for (const name of [PAD, TOUCH])
      if (!report.imports[name].bytes) throw Error('Required input import unresolved: ' + name);
    report.completed = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'input-inspection.json'), JSON.stringify(report, null, 2), {flag: 'wx', mode: 0o600});
    console.log('Resolved input imports for ' + rpc.a.session);
  } finally {
    await rpc.write(saveBase, saved).catch(() => {});
  }
}
if (require.main === module) main(process.argv[2]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
