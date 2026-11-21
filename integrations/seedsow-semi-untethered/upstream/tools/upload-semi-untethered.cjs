#!/usr/bin/env node
'use strict';

// tools/upload-semi-untethered.cjs — Verify and upload all 14 semi-untethered
// Lua 5.1 modules in lua/ into the console's save:/ via http.lua (port 8080),
// then invoke nn::fs::CommitSaveData("save") to persist to NAND.
//
// Usage:
//   node tools/upload-semi-untethered.cjs --check               (verify byte caps locally)
//   node tools/upload-semi-untethered.cjs --host 192.168.1.50   (upload all Lua files to save:/)
//   node tools/upload-semi-untethered.cjs --ip 192.168.1.50     (alias for --host)
//   node tools/upload-semi-untethered.cjs                       (uses NS2_CONSOLE / NS2_HOST or tools/console-host.txt)

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TOOLS_DIR = __dirname;
const ROOT_DIR = path.resolve(TOOLS_DIR, '..');
const LUA_DIR = path.join(ROOT_DIR, 'lua');
const LOCAL_HOST_FILE = path.join(TOOLS_DIR, 'console-host.txt');
const SIBLING_HOST_FILE = path.resolve(ROOT_DIR, '..', 'seedsow-fs-kaihen', 'tools', 'console-host.txt');

const UPLOAD_CAP = 32000; // source cap
const WIRE_CAP = 28600;   // < 0x7000 (28,672) BODY_CAP on mac2jb / Nov 2 http.lua saves

const FILES = [
  's2_rt.lua',
  's2_prim.lua',
  's2_fshlp.lua',
  's2_fs.lua',
  's2_wave.lua',
  's2_race.lua',
  's2_scan.lua',
  's2_promote.lua',
  's2_kh_ro.lua',
  's2_kaihen.lua',
  's2_main.lua',
  'core2.lua',
  'exploita2.lua',
  'inject2.lua',
];

function resolveConsoleHost() {
  const fromEnv = (process.env.NS2_CONSOLE || process.env.NS2_HOST || '').trim();
  if (fromEnv) return fromEnv;
  for (const file of [LOCAL_HOST_FILE, SIBLING_HOST_FILE]) {
    try {
      const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
      if (first) return first;
    } catch { /* try next */ }
  }
  throw Error(
    'No Switch 2 IP address specified. Pass --host <switch-ip> (or --ip <switch-ip>), ' +
    'set NS2_CONSOLE=<switch-ip>, or write the IP into tools/console-host.txt'
  );
}

function saveConsoleHost(host) {
  const value = String(host || '').trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value)) {
    throw Error(`Invalid IPv4 address or hostname: ${value}`);
  }
  fs.writeFileSync(LOCAL_HOST_FILE, value + '\n');
  try {
    if (fs.existsSync(path.dirname(SIBLING_HOST_FILE))) {
      fs.writeFileSync(SIBLING_HOST_FILE, value + '\n');
    }
  } catch { /* ignore if sibling repo is not writable */ }
  return value;
}

// Preserves exact line numbers and 100% identical Lua 5.1 bytecode on the wire
// when a source file exceeds mac2jb's 0x7000 (28,672-byte) BODY_CAP.
// Also normalizes Windows CRLF (\r\n) to LF (\n) for cross-platform consistency.
function prepareWireBytes(fullPath) {
  const rawStr = fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');
  const raw = Buffer.from(rawStr, 'utf8');
  if (raw.length <= WIRE_CAP) return raw;
  let txt = rawStr.split('\n').map(l => (/^\s*--/.test(l) ? '' : l)).join('\n');
  if (Buffer.byteLength(txt) > WIRE_CAP) {
    txt = txt.split('\n').map(l => l.replace(/^\s+/, '')).join('\n');
  }
  const out = Buffer.from(txt, 'utf8');
  if (out.length > WIRE_CAP) {
    throw Error(`${path.basename(fullPath)} wire size ${out.length} exceeds ${WIRE_CAP}`);
  }
  return out;
}

function httpRequest(host, method, pathname, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port: 8080, path: pathname, method,
      headers: {'content-type': 'text/plain', 'content-length': body.length},
    }, res => {
      const parts = [];
      res.on('data', p => parts.push(p));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(Error(`${method} ${pathname}: HTTP ${res.statusCode} ${text.slice(0, 200).trim()}`));
        }
        resolve(text);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Error(`${method} ${pathname}: timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

function checkFiles() {
  for (const name of FILES) {
    const full = path.join(LUA_DIR, name);
    const lfLen = Buffer.byteLength(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
    if (lfLen <= 0 || lfLen > UPLOAD_CAP) {
      throw Error(`${name} is ${lfLen} bytes (must be 1..${UPLOAD_CAP})`);
    }
    const wire = prepareWireBytes(full);
    console.log(`OK  ${name.padEnd(16)} ${String(lfLen).padStart(6)} src / ${String(wire.length).padStart(6)} wire bytes`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  for (const flag of ['--host', '--ip']) {
    const idx = argv.indexOf(flag);
    if (idx >= 0 && argv[idx + 1]) {
      process.env.NS2_CONSOLE = saveConsoleHost(argv[idx + 1]);
    }
  }
  checkFiles();
  if (argv.includes('--check')) {
    console.log('All files verified under both source (32,000) and mac2jb wire (28,672) caps.');
    return;
  }
  const host = resolveConsoleHost();
  console.log(`Target Switch 2 HTTP server: http://${host}:8080`);
  for (const name of FILES) {
    const full = path.join(LUA_DIR, name);
    const wire = prepareWireBytes(full);
    process.stdout.write(`Uploading ${name} (${wire.length} B) -> save:/${name} ... `);
    const res = await httpRequest(host, 'PUT', '/save?path=' + encodeURIComponent(name), wire);
    console.log(res.trim() || 'OK');
  }
  // Also populate save:/exploita.lua, save:/exploit1.lua, and the `ax_` sidecar update slots
  // (`save:/ax_exploita2.lua` and `save:/ax_inject2.lua`) so stock alula saves, older saves,
  // and Seedsow Lua Editor + Artemis Sidecar saves all launch cleanly on Button A.
  for (const [srcName, dstName] of [
    ['exploita2.lua', 'exploita.lua'],
    ['exploita2.lua', 'exploit1.lua'],
    ['exploita2.lua', 'ax_exploita2.lua'],
    ['inject2.lua', 'ax_inject2.lua'],
  ]) {
    const wire = prepareWireBytes(path.join(LUA_DIR, srcName));
    process.stdout.write(`Uploading ${srcName} (${wire.length} B) -> save:/${dstName} ... `);
    const res = await httpRequest(host, 'PUT', '/save?path=' + encodeURIComponent(dstName), wire);
    console.log(res.trim() || 'OK');
  }
  for (const staleCore of ['core2.lua', 'ax_core2.lua']) {
    try {
      await httpRequest(host, 'DELETE', '/delete?path=' + staleCore, Buffer.alloc(0));
    } catch { /* ignore if already absent */ }
  }
  // Clean any leftover /hole scratch tree, patch ssNNN.asb fast-path on Seedsow Lua Editor saves,
  // and commit save:/ to NAND
  process.stdout.write('Cleaning any leftover /hole & committing save:/ to NAND ... ');
  const commitLua = Buffer.from([
    'package.path = "save:/?.lua;save:/lib/?.lua"',
    'local N = _G.n2h',
    'local patched_asb = "none"',
    'pcall(function()',
    '  local P = require("s2_prim")',
    '  local FS = require("s2_fs")',
    '  local rt = P.bind_n2h(N)',
    '  local fs = FS.bind_fs(rt)',
    '  local sm = fs.open_mount("save")',
    '  if sm and sm.handle ~= 0 then',
    '    local he = fs.ipc_get_entry_type(sm.handle, "/hole")',
    '    if he.transport == 0 and he.result == 0 then',
    '      fs.remove_scratch_tree(sm.handle, "/hole")',
    '    end',
    '    local dbuf, draw = rt.alloc_page(0x10000, false)',
    '    local wpkt, wpkt_raw = rt.alloc_page(0x2000, false)',
    '    local fast_block = table.concat({',
    '      "    if not engine:isDown(114) and engine:isFileExists(\\"save:/ax_inject2.lua\\") then",',
    '      "        if debug and debug.sethook then debug.sethook() end",',
    '      "        for _,id in ipairs({\\"zzlogn\\",\\"zzamask\\",\\"startmask\\",\\"500\\",\\"600\\",\\"2\\",\\"zzzzsseditor\\",\\"zzzzssprogram\\"}) do engine:tag{\\"lydel\\",id=id} end",',
    '      "        engine:tag{\\"lyc\\",id=\\"zzzzssprogram.0\\",width=\\"1280\\",height=\\"720\\",color=\\"0xff000000\\"}",',
    '      "        engine:tag{\\"lyprop\\",id=\\"zzzzssprogram\\",left=\\"0\\",top=\\"0\\",visible=\\"1\\",alpha=\\"255\\"}",',
    '      "        for _,t in ipairs({\\"autosave\\",\\"skip\\",\\"automode\\"}) do engine:tag{t,allow=\\"0\\"} end",',
    '      "        _G.seedsow_editor_key=function() end",',
    '      "        _G.seedsow_editor_event=function(_e,n) if n==\\"setonpush\\" then return 1 end return 0 end",',
    '      "        pcall(function() engine:setEventFilter(_G.seedsow_editor_event) end)",',
    '      "        local seen={}",',
    '      "        for _,k in ipairs({13,27,37,38,39,40,112,113,114,116,117,256,257,258,259,260,261,304,305,306,307}) do seen[k]=true; engine:tag{\\"delonpush\\",key=tostring(k)} end",',
    '      "        if csv and csv.advkey and csv.advkey.def then for k in pairs(csv.advkey.def) do local nk=tonumber(k) or k; if not seen[nk] then seen[nk]=true; engine:tag{\\"delonpush\\",key=tostring(nk)} end end end",',
    '      "        for role=0,14 do engine:tag{\\"keyconfig\\",role=tostring(role),keys=\\"\\"} end",',
    '      "        engine:tag{\\"flip\\"}",',
    '      "        _G.e=engine; _G.n2h_was_recovery=false",',
    '      "        _G.s2_sidecar_boot=function()",',
    '      "            if debug and debug.sethook then debug.sethook() end",',
    '      "            _G.e=engine",',
    '      "            engine:setEventHandler{onEnterFrame=\\"\\"}",',
    '      "            engine:include(\\"save:/ax_inject2.lua\\")",',
    '      "            engine:tag{\\"flip\\"}",',
    '      "        end",',
    '      "        engine:setEventHandler{onEnterFrame=\\"s2_sidecar_boot\\",onSave=\\"\\",onLoad=\\"\\",onClickWaitIn=\\"\\",onClickWaitOut=\\"\\",onDebugSkipOut=\\"\\"}",',
    '      "        return",',
    '      "    end\\n",',
    '    }, "\\n")',
    '    local patched_list = {}',
    '    for slot = 4, 120 do',
    '      local ax_path = string.format("/ax_slot%03d.lua", slot)',
    '      local ae = fs.ipc_get_entry_type(sm.handle, ax_path)',
    '      if ae.transport == 0 and ae.result == 0 then',
    '        local asb_path = string.format("/ss%03d.asb", slot)',
    '        local fh = fs.ipc_open_file(sm.handle, asb_path, 1, 0x301)',
    '        if fh ~= 0 then',
    '          local fsz = fs.ipc_file_get_size(fh)',
    '          local raw = nil',
    '          if fsz and fsz > 48 and fsz < 0x8000 then',
    '            local rpkt = P.packet(0, P.u64s(0) .. P.u64s(0) .. P.u64s(fsz), {b = {{addr = dbuf, size = fsz, mode = 1}}})',
    '            local rrep = fs.send_packet(fh, rpkt, wpkt)',
    '            if rrep.transport == 0 and rrep.result == 0 then raw = rt.rd(dbuf, fsz) end',
    '          end',
    '          rt.close_handle(fh)',
    '          if raw and raw:sub(1, 8) == "ASB\\0\\0\\4\\0\\0" then',
    '            local slen = P.u32(raw, 40)',
    '            if (44 + slen) < #raw and raw:byte(44 + slen + 1) == 0 then',
    '              local script = raw:sub(45, 44 + slen)',
    '              local nl = script:find("\\n", 1, true)',
    '              local base_pos = script:find("    local base=engine:var(", 1, true)',
    '              if nl and base_pos and base_pos > nl then',
    '                local new_script = script:sub(1, nl) .. fast_block .. script:sub(base_pos)',
    '                if new_script == script then',
    '                  patched_list[#patched_list + 1] = asb_path .. "(already)"',
    '                else',
    '                  local new_raw = raw:sub(1, 40) .. P.u32s(#new_script) .. new_script .. raw:sub(45 + slen)',
    '                  fs.ipc_delete_file(sm.handle, asb_path)',
    '                  fs.ipc_commit(sm.handle)',
    '                  if fs.ipc_create_file(sm.handle, asb_path, #new_raw) == 0 then',
    '                    local wfh = fs.ipc_open_file(sm.handle, asb_path, 3, 0x301)',
    '                    if wfh ~= 0 then',
    '                      rt.wr(dbuf, new_raw)',
    '                      local w_pkt = P.packet(1, P.u32s(1) .. P.u32s(0) .. P.u64s(0) .. P.u64s(#new_raw), {a = {{addr = dbuf, size = #new_raw, mode = 1}}})',
    '                      local wrep = fs.send_packet(wfh, w_pkt, wpkt)',
    '                      rt.memset(dbuf, 0, #new_raw + 16)',
    '                      local v_pkt = P.packet(0, P.u64s(0) .. P.u64s(0) .. P.u64s(#new_raw), {b = {{addr = dbuf, size = #new_raw, mode = 1}}})',
    '                      local vrep = fs.send_packet(wfh, v_pkt, wpkt)',
    '                      local vraw = (vrep.transport == 0 and vrep.result == 0) and rt.rd(dbuf, #new_raw) or nil',
    '                      rt.close_handle(wfh)',
    '                      fs.ipc_commit(sm.handle)',
    '                      if wrep.transport == 0 and wrep.result == 0 and vraw == new_raw then',
    '                        patched_list[#patched_list + 1] = asb_path',
    '                      end',
    '                    end',
    '                  end',
    '                end',
    '              end',
    '            end',
    '          end',
    '        end',
    '      end',
    '    end',
    '    if #patched_list > 0 then patched_asb = table.concat(patched_list, ",") end',
    '    rt.free_raw(wpkt_raw)',
    '    rt.free_raw(draw)',
    '    rt.close_handle(sm.handle)',
    '  end',
    'end)',
    'local s = "save\\0"',
    'local p = N.str_addr(s) + 0x18',
    'local fn = (N.offsets_sdk and N.offsets_sdk.fs_commit_save_data) and N.sdk("fs_commit_save_data") or (N.sdk_base + 0x0a7f70)',
    'local r = N.call_deep(fn, p, 0, 0, 0, 0)',
    'if N.log then N.log(string.format("[+] UPLOAD COMPLETE: files committed, /hole cleaned, asb=%s (commit_rc=0x%x)", patched_asb, r or -1)) end',
    'print(string.format("commit_rc=0x%x asb=%s", r or -1, patched_asb))',
  ].join('\n'), 'utf8');
  const commitRes = await httpRequest(host, 'POST', '/eval', commitLua);
  console.log(commitRes.replace(/\s+/g, ' ').trim());
  console.log('Upload complete.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
