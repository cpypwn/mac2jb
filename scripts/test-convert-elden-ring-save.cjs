const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const script = path.join(__dirname, 'convert-elden-ring-save.cjs');
const titleId = '0400f5802371e000';
const slotSize = 0x280000;
const sizes = [...Array(10).fill(slotSize), 0x60000, 0x240010];
const profileFlags = 0x1954;
const profiles = 0x195e;
const profileSize = 0x24c;
const accountOffset = 0x217e09;
const pcAccount = Buffer.from('1122334455667788', 'hex');

function name(index) {
  return `ER_____0000_userdata${String(index).padStart(4, '0')}`;
}
function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function md5(data) {
  return crypto.createHash('md5').update(data).digest();
}

async function fixture(root) {
  const pc = path.join(root, 'ER0000.sl2');
  const backup = path.join(root, 'switch-backup');
  await fs.mkdir(backup);
  const pcParts = [];
  const entries = [];
  let offset = 0x300;
  const header = Buffer.alloc(offset);
  header.write('BND4', 0, 'ascii');
  header.writeUInt32LE(12, 0xc);
  for (let index = 0; index < 12; index++) {
    const source = Buffer.alloc(sizes[index]);
    const target = Buffer.alloc(sizes[index]);
    if (index === 0) {
      source.writeUInt32LE(252, 0);
      source.writeUInt32LE(252, accountOffset - 16);
      source.writeUInt32LE(252, accountOffset - 12);
      pcAccount.copy(source, accountOffset);
      target.writeUInt32LE(260, 0);
      target.write('SWITCH CHARACTER', 0x100, 'ascii');
    } else if (index === 10) {
      source.writeUInt32LE(252, 0);
      pcAccount.copy(source, 4);
      source[profileFlags] = 1;
      source.write('PC PROFILE', profiles + 0x20, 'ascii');
      target.writeUInt32LE(260, 0);
      target[profileFlags] = 1;
      target.write('SWITCH PROFILE', profiles + 0x20, 'ascii');
    }
    const part = Buffer.concat([index > 0 && index < 10 ? Buffer.alloc(16) : md5(source), source]);
    const record = 0x40 + index * 0x20;
    header.writeBigUInt64LE(BigInt(part.length), record + 8);
    header.writeUInt32LE(offset, record + 0x10);
    offset += part.length;
    pcParts.push(part);
    await fs.writeFile(path.join(backup, name(index)), target);
    entries.push({path: '/' + name(index), size: target.length, sha256: sha(target)});
  }
  await fs.writeFile(pc, Buffer.concat([header, ...pcParts]));
  const manifest = {
    titleId,
    archive: 'space=User type=Account rank=0 index=0 uid=' + 'a'.repeat(16),
    selection: {space: 1, type: 1, rank: 0, index: 0, staticId: 0,
      uid: 'a'.repeat(32)},
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    partial: false,
    failed: [],
    entries
  };
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
  return {pc, backup, manifest};
}

function run({pc, backup}, output, switchSlot = 0) {
  return spawnSync(process.execPath, [script, '--pc', pc, '--switch', backup,
    '--output', output, '--pc-slot', '0', '--switch-slot', String(switchSlot)],
  {encoding: 'utf8'});
}

test('PC character conversion checks both inputs and writes only the selected Switch files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-er-convert-'));
  t.after(async () => {await fs.rm(root, {recursive: true, force: true});});
  const input = await fixture(root);
  const output = path.join(root, 'conversion');
  await fs.mkdir(output);
  const result = run(input, output);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.status, 'complete');
  assert.equal(response.saveFolder, path.join(output, 'save-files'));
  assert.deepEqual((await fs.readdir(response.saveFolder)).sort(), [name(0), name(10)]);
  const slot = await fs.readFile(path.join(response.saveFolder, name(0)));
  const summary = await fs.readFile(path.join(response.saveFolder, name(10)));
  assert.equal(slot.readUInt32LE(0), 252);
  assert.deepEqual(slot.subarray(accountOffset, accountOffset + 8), Buffer.alloc(8));
  assert.equal(summary.readUInt32LE(0), 260);
  assert.deepEqual(summary.subarray(4, 12), Buffer.alloc(8));
  assert.equal(summary[profileFlags], 1);
  assert.equal(summary.subarray(profiles + 0x20, profiles + 0x20 + 10).toString(), 'PC PROFILE');
  assert.equal((await fs.readFile(path.join(input.backup, name(10))))[profiles + 0x20],
    'S'.charCodeAt(0));

  await t.test('writes a different destination slot without touching the original backup', async () => {
    const otherOutput = path.join(root, 'slot-3-conversion');
    await fs.mkdir(otherOutput);
    const attempt = run(input, otherOutput, 2);
    assert.equal(attempt.status, 0, attempt.stderr);
    const folder = JSON.parse(attempt.stdout.trim()).saveFolder;
    assert.deepEqual((await fs.readdir(folder)).sort(), [name(2), name(10)]);
    const converted = await fs.readFile(path.join(folder, name(10)));
    assert.equal(converted[profileFlags + 2], 1);
    assert.equal(converted.subarray(profiles + 2 * profileSize + 0x20,
      profiles + 2 * profileSize + 0x20 + 10).toString(), 'PC PROFILE');
    const original = await fs.readFile(path.join(input.backup, name(10)));
    assert.equal(original[profileFlags + 2], 0);
  });

  await t.test('rejects a PC slot with a bad MD5', async () => {
    const altered = path.join(root, 'bad-md5.sl2');
    const data = await fs.readFile(input.pc);
    data[0x300] ^= 0xff;
    await fs.writeFile(altered, data);
    const attempt = run({...input, pc: altered}, path.join(root, 'bad-md5-output'));
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /md5|checksum|digest/i);
  });

  await t.test('rejects a Switch export whose file differs from its manifest', async () => {
    const changed = await fs.readFile(path.join(input.backup, name(0)));
    changed[0x100] ^= 1;
    await fs.writeFile(path.join(input.backup, name(0)), changed);
    const attempt = run(input, path.join(root, 'bad-manifest-output'));
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /sha|manifest|verification|backup/i);
    changed[0x100] ^= 1;
    await fs.writeFile(path.join(input.backup, name(0)), changed);
  });

  await t.test('rejects a source character newer than the Switch save format', async () => {
    const altered = path.join(root, 'newer.sl2');
    const data = await fs.readFile(input.pc);
    data.writeUInt32LE(300, 0x300 + 16);
    md5(data.subarray(0x300 + 16, 0x300 + 16 + slotSize)).copy(data, 0x300);
    await fs.writeFile(altered, data);
    const attempt = run({...input, pc: altered}, path.join(root, 'newer-output'));
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.stderr, /newer|version|format/i);
  });
});
