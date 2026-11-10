'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const u32 = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const string = value => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

function indexedSave(bytes) {
  if (bytes.length < 16 || bytes.toString('ascii', 0, 4) !== 'BOWS' ||
      bytes.readUInt32LE(4) !== 1003)
    throw Error('The full-game autosave is not a Seedsow BOWS v1003 save. No files were changed.');
  const size = bytes.readUInt32LE(8);
  if (size < 12 || size > 64 * 1024 * 1024)
    throw Error('The full-game autosave has an unsupported size. No files were changed.');
  const body = zlib.inflateSync(bytes.subarray(12), {maxOutputLength: 64 * 1024 * 1024});
  if (body.length !== size) throw Error('The full-game autosave size does not match its header.');
  const indexStart = body.readUInt32LE(body.length - 4);
  if (indexStart >= body.length - 8) throw Error('The full-game autosave index is invalid.');
  const fields = body.subarray(0, indexStart);
  let cursor = indexStart;
  const read = () => {
    if (cursor + 4 > body.length - 4) throw Error('The full-game autosave index is truncated.');
    const value = body.readUInt32LE(cursor);
    cursor += 4;
    return value;
  };
  const count = read();
  if (count > 100000) throw Error('The full-game autosave has too many groups.');
  const groups = new Map();
  for (let i = 0; i < count; i++) {
    const base = read(), length = read();
    if (base >= indexStart || length > 100000 || groups.has(base))
      throw Error('The full-game autosave has an invalid group.');
    const entries = new Map();
    for (let j = 0; j < length; j++) {
      const key = read(), offset = read();
      if (offset >= indexStart || entries.has(key))
        throw Error('The full-game autosave has an invalid field.');
      entries.set(key, offset);
    }
    groups.set(base, entries);
  }
  if (cursor !== body.length - 4) throw Error('The full-game autosave index has trailing bytes.');
  const fieldU32 = offset => {
    if (!Number.isInteger(offset) || offset < 0 || offset + 4 > fields.length)
      throw Error('The full-game autosave field is invalid.');
    return fields.readUInt32LE(offset);
  };
  const fieldString = offset => {
    const size = fieldU32(offset);
    if (offset + 4 + size > fields.length)
      throw Error('The full-game autosave string is invalid.');
    return fields.subarray(offset + 4, offset + 4 + size);
  };
  return {fields, groups, fieldU32, fieldString};
}

function patchAutosave(bytes) {
  const save = indexedSave(bytes);
  const root = save.groups.get(0);
  const caret = root && save.groups.get(root.get(3));
  if (!caret || ![1, 3, 4].every(key => caret.has(key)))
    throw Error('The full-game autosave has no compatible script entry.');
  const script = save.fieldString(caret.get(3)).toString('utf8');
  if (!['system/script.asb', 'save:/inject.asb'].includes(script))
    throw Error('The full-game autosave uses an unexpected script. No files were changed.');
  const edits = [];
  if (script === 'system/script.asb')
    edits.push({at: caret.get(3), before: string(script), after: string('save:/inject.asb')});
  for (const [key, value] of [[1, 0], [4, 1]]) {
    const at = caret.get(key), previous = save.fieldU32(at);
    if (previous !== value) edits.push({at, before: u32(previous), after: u32(value)});
  }
  for (const [key, name] of [[34, 'vsync'], [38, 'keyClickStart'],
    [50, 'keyClickEnd'], [69, 'store'], [70, 'restore'], [80, 'exskip_end']]) {
    if (root.has(key) && save.fieldString(root.get(key)).toString('utf8') === name)
      edits.push({at: root.get(key), before: string(name), after: string('')});
  }
  edits.sort((a, b) => a.at - b.at);
  let end = 0;
  const parts = [];
  for (const edit of edits) {
    if (edit.at < end || !save.fields.subarray(edit.at, edit.at + edit.before.length).equals(edit.before))
      throw Error('The full-game autosave changed during patching.');
    parts.push(save.fields.subarray(end, edit.at), edit.after);
    end = edit.at + edit.before.length;
  }
  parts.push(save.fields.subarray(end));
  const fields = Buffer.concat(parts);
  const relocate = offset => offset + edits.reduce((delta, edit) =>
    offset > edit.at ? delta + edit.after.length - edit.before.length : delta, 0);
  const index = [u32(save.groups.size)];
  for (const [base, entries] of save.groups) {
    index.push(u32(relocate(base)), u32(entries.size));
    for (const [key, offset] of entries) index.push(u32(key), u32(relocate(offset)));
  }
  const body = Buffer.concat([fields, ...index, u32(fields.length)]);
  return Buffer.concat([Buffer.from('BOWS'), u32(1003), u32(body.length), zlib.deflateSync(body, {level: 9})]);
}

const showcaseInjectScript = `function include_lua(engine)
    e = engine
    local update_path = "save:/inject2.lua"
    local should_load_update = e:isFileExists(update_path)
    _G.n2h_was_recovery = false
    if e:isDown(114) then
        should_load_update = false
        _G.n2h_was_recovery = true
    end
    if should_load_update then
        print("loading update from " .. update_path)
        e:include(update_path)
    else
        e:include("save:/inject.lua")
    end
end`;

const upstreamInjectScript = `function include_lua(engine)
    e = engine
    e:include("save:/inject.lua")
end`;

function injectAsb(preferUpdate = true) {
  const commands = [
    ['lua', {script: preferUpdate ? showcaseInjectScript : upstreamInjectScript}],
    ['calllua', {function: 'include_lua'}],
    ['return', {}]
  ];
  const parts = [Buffer.from([65, 83, 66, 0, 0]), u32(commands.length)];
  for (const [index, [name, params]] of commands.entries()) {
    parts.push(u32(0), string(name), Buffer.from([0]), u32(index + 1), u32(Object.keys(params).length));
    for (const [key, value] of Object.entries(params))
      parts.push(string(key), Buffer.from([0]), string(value), Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

async function stageFullSeedsow(directory, backup, {preferUpdate = true} = {}) {
  for (const name of ['autosave.dat', 'saveg.dat', 'system.dat', 'save0001.dat',
    'save0001.png', 'save0001_s.png']) {
    const info = await fs.lstat(path.join(backup, name));
    if (!info.isFile() || info.isSymbolicLink())
      throw Error('The full-game backup is missing ' + name + '. No files were changed.');
  }
  const patched = patchAutosave(await fs.readFile(path.join(backup, 'autosave.dat')));
  for (const name of ['save9999.dat', 'saveg.dat', 'system.dat'])
    await fs.rm(path.join(directory, name));
  await fs.writeFile(path.join(directory, 'autosave.dat'), patched, {flag: 'wx', mode: 0o600});
  await fs.writeFile(path.join(directory, 'save0001.dat'), patched, {flag: 'wx', mode: 0o600});
  await fs.writeFile(path.join(directory, 'inject.asb'), injectAsb(preferUpdate), {flag: 'wx', mode: 0o600});
  return (await fs.readdir(directory)).sort();
}

module.exports = {indexedSave, patchAutosave, injectAsb, stageFullSeedsow};
