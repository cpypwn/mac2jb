#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const check = (value, message) => {if (!value) throw Error(message);};

async function inspectModule(rpc, base, maxOffset = 0x2000000) {
  check(Number.isInteger(maxOffset) && maxOffset > 0 && maxOffset <= 0x10000000, 'Invalid module bound');
  const header = await rpc.read(base, 8), mod = base + header.readUInt32LE(4);
  check(mod >= base && mod < base + maxOffset, 'Invalid MOD0 location');
  const bytes = await rpc.read(mod, 8);
  check(bytes.toString('ascii', 0, 4) === 'MOD0', 'Missing MOD0');
  const dynamic = await rpc.read(mod + bytes.readInt32LE(4), 0x1000);
  const tags = new Map();
  for (let at = 0; at < dynamic.length; at += 16) {
    const tag = Number(dynamic.readBigUInt64LE(at));
    if (!tag) break;
    const value = Number(dynamic.readBigUInt64LE(at + 8));
    check(Number.isSafeInteger(value), 'Invalid dynamic entry');
    tags.set(tag, value);
  }
  const relative = value => {
    check(Number.isSafeInteger(value) && value > 0 && value < maxOffset, 'Invalid table offset');
    return base + value;
  };
  check(tags.get(11) === 24, 'Unexpected symbol entry size');
  const hash = await rpc.read(relative(tags.get(4)), 8);
  const count = hash.readUInt32LE(4), stringSize = tags.get(10);
  check(count > 0 && count < 200000 && stringSize > 0 && stringSize < 0x800000, 'Invalid symbol table bounds');
  const table = await rpc.read(relative(tags.get(6)), count * 24);
  const strings = await rpc.read(relative(tags.get(5)), stringSize);
  const symbols = [];
  for (let i = 0; i < count; i++) {
    const at = i * 24, nameOffset = table.readUInt32LE(at);
    if (!nameOffset || nameOffset >= strings.length) continue;
    const end = strings.indexOf(0, nameOffset);
    if (end < 0) continue;
    symbols.push({name: strings.toString('utf8', nameOffset, end),
      type: table[at + 4] & 15, binding: table[at + 4] >> 4,
      section: table.readUInt16LE(at + 6), offset: Number(table.readBigUInt64LE(at + 8)),
      size: Number(table.readBigUInt64LE(at + 16))});
  }
  return {base, symbols};
}

async function main(directory) {
  directory = path.resolve(directory);
  const rpc = require(path.join(directory, 'shared/rpc.cjs'));
  check((await rpc.request({command: 'status'})).ready, 'Console disconnected');
  const report = {session: rpc.a.session, started: new Date().toISOString(), modules: {}, regions: []};
  for (let address = 0; address < 2 ** 39;) {
    check(report.regions.length < 4096, 'Memory map exceeded bounds');
    const region = await rpc.query(address);
    const next = region.address + region.size;
    check(region.address <= address && next > address && Number.isSafeInteger(next), 'Invalid memory map');
    report.regions.push(region); address = next;
  }
  await fs.writeFile(path.join(directory, 'graphics-map.json'), JSON.stringify(report.regions, null, 2), {mode: 0o600});
  for (const [name, base] of [['main', rpc.a.main], ['sdk', rpc.a.sdk]]) {
    console.log('Inspecting ' + name + ' exports and imports');
    try {report.modules[name] = await inspectModule(rpc, base);}
    catch (error) {report.modules[name] = {base, symbols: [], error: error.message};}
    const matches = report.modules[name].symbols.filter(symbol => /nvn|nvgl|egl|glDraw|glClear|gfx|Graphic|Texture|Render|FrameBuffer|Npad|AudioOut/i.test(symbol.name));
    console.log(name + ': ' + report.modules[name].symbols.length + ' symbols; ' + matches.length + ' homebrew-launcher/input/audio matches');
    await fs.writeFile(path.join(directory, name + '-graphics-symbols.json'), JSON.stringify(matches, null, 2), {mode: 0o600});
    // Capture only module code/rodata/data mappings for offline graphics analysis.
    let address = base, total = 0;
    for (let i = 0; i < 4; i++) {
      const region = await rpc.query(address);
      if (![3, 4].includes(region.type) || !(region.permissions & 1) || region.ipcReferences ||
          (address !== base && region.permissions === 5)) break;
      const size = Math.min(region.size, region.permissions === 3 ? 0x1000000 : 0x4000000);
      check(total + size <= 0x8000000, 'Module capture exceeded bound');
      console.log('Capturing ' + name + ' mapping +' + (address - base).toString(16) + ' (' + size + ' bytes)');
      const data = await rpc.read(address, size);
      await fs.writeFile(path.join(directory, name + '-' + (address - base).toString(16) + '.bin'), data, {mode: 0o600});
      total += size; address += region.size;
    }
  }
  report.completed = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'graphics-inspection.json'), JSON.stringify(report, null, 2), {mode: 0o600});
  console.log('Inspection saved; native session remains connected.');
}
module.exports = {inspectModule};
if (require.main === module) {
  if (process.argv.length !== 3) {console.error('Usage: node homebrew-launcher/inspect.cjs runs/graphics-ID'); process.exitCode = 1;}
  else main(process.argv[2]).catch(error => {console.error(error.stack); process.exitCode = 1;});
}
