-- Offline tests for payloads/ns2jb-launcher.lua and payloads/nso-verify.lua.
--
--   lua tests/test_payload_lua.lua
--
-- No console and no network: the engine handle and the filesystem are stubs, so
-- what is proven here is the payload's decision logic and its wording, not that
-- the engine API behaves as assumed. The real NSO cases read the demo exefs when
-- it exists on this machine (NSO_FIXTURE overrides), which is what makes the
-- compressed-section path exercised.
local here = arg[0]:match('^(.*)/[^/]*$') or '.'
local root = here .. '/..'

local function slurp(path)
  local f = io.open(path, 'rb')
  if not f then return nil end
  local d = f:read('*a')
  f:close()
  return d
end

local verifierSource = assert(slurp(root .. '/payloads/nso-verify.lua'), 'nso-verify.lua')
local launcherSource = assert(slurp(root .. '/payloads/ns2jb-launcher.lua'), 'ns2jb-launcher.lua')

local passed, failed = 0, 0
local function check(name, condition, detail)
  if condition then
    passed = passed + 1
    print('ok    ' .. name)
  else
    failed = failed + 1
    print('FAIL  ' .. name .. (detail and ('\n      ' .. tostring(detail)) or ''))
  end
end

-- Minimal 32-bit little-endian packer (Lua 5.1 lacks string.pack).
local function u32(n)
  n = n % 4294967296
  local out = {}
  for _ = 1, 4 do
    out[#out + 1] = string.char(n % 256)
    n = math.floor(n / 256)
  end
  return table.concat(out)
end

local function pad(s, size, fill)
  if #s >= size then return s:sub(1, size) end
  return s .. string.rep(fill or '\0', size - #s)
end

-- An uncompressed NSO in the shape real tools write: 0x100 header, module name at
-- 0x100, then text/rodata/data with their file sizes also recorded at 0x60/0x64/0x68.
local function syntheticNso(opts)
  opts = opts or {}
  local name = pad(opts.name or 'main', 4, '\0') .. '\0'
  local text = opts.text or (string.char(0xfd, 0x7b, 0xbf, 0xa9) .. string.rep('\1', 0x1ff))
  local rodata = string.rep('A', 0x100)
  local data = string.rep('B', 0x100)
  local textOff = 0x100 + #name
  local roOff = textOff + #text
  local dataOff = roOff + #rodata
  local header = 'NSO0' .. u32(0) .. u32(0) .. u32(opts.flags or 0)
  header = header .. u32(textOff) .. u32(0) .. u32(#text)
  header = header .. u32(0x100)
  header = header .. u32(roOff) .. u32(0x1000) .. u32(#rodata)
  header = header .. u32(#name)
  header = header .. u32(dataOff) .. u32(0x2000) .. u32(#data)
  header = header .. u32(0x1000)
  header = header .. string.rep('\0', 0x20)          -- module id
  header = header .. u32(#text) .. u32(#rodata) .. u32(#data)
  header = header .. string.rep('\0', 0x100 - #header)
  return header .. name .. text .. rodata .. data
end

-- Run the launcher against a stubbed filesystem and engine.
local function run(files)
  local dialogs, written = {}, {}
  local fakeIo = {}
  function fakeIo.open(path, mode)
    if mode and mode:find('w') then
      local buffer = {}
      return {
        write = function(_, text) buffer[#buffer + 1] = text end,
        flush = function() end,
        close = function()
          written[path] = table.concat(buffer)
        end
      }
    end
    local content = files[path]
    if content == nil then return nil end
    local position = 1
    return {
      read = function(_, what)
        if what == '*a' then
          local out = content:sub(position)
          position = #content + 1
          return out
        end
        return nil
      end,
      close = function() end
    }
  end
  local engine = {}
  function engine.var(self, name)
    if name == 's.savepath' then return 'save:' end
    if name == 's.datapath' then return 'game:' end
    return nil
  end
  function engine.tag(self, tag)
    if type(tag) == 'table' and tag[1] == 'dialog' then
      dialogs[#dialogs + 1] = {title = tag.title, message = tag.message}
    end
  end
  local env = {
    io = fakeIo, engine = engine, pcall = pcall, tostring = tostring,
    string = string, table = table, math = math, type = type,
    loadstring = load, _VERSION = 'Lua 5.1',
    assert = assert, error = error, select = select
  }
  local chunk = assert(load(launcherSource, '@ns2jb-launcher.lua', 't', env))
  chunk(engine)
  return dialogs, written
end

-- The verifier is loaded with the real io for the fixture cases below.
local verifier = assert(load(verifierSource, '@nso-verify.lua'))()

check('no sd: at all -> missing main', (function()
  local dialogs = run({})
  return dialogs[1] and dialogs[1].message:find('^missing main on sd card')
    and dialogs[1].message:find('not available', 1, true) ~= nil
end)(), 'expected the "sd: not available" wording')

check('sd: present, no main -> missing main (file not found)', (function()
  local dialogs = run({['sd:/'] = ''})
  return dialogs[1] and dialogs[1].message:find('^missing main on sd card')
    and dialogs[1].message:find('file not found', 1, true) ~= nil
end)())

check('main with bad magic -> invalid main, with reason', (function()
  local dialogs = run({['sd:/'] = '', ['sd:/main'] = 'NOPE' .. string.rep('\0', 0x200),
    ['save:/nso-verify.lua'] = verifierSource})
  return dialogs[1] and dialogs[1].message:find('^invalid main on sd card')
    and dialogs[1].message:find('magic', 1, true) ~= nil
end)())

check('truncated main -> invalid, mentions truncation', (function()
  local dialogs = run({['sd:/'] = '', ['sd:/main'] = syntheticNso():sub(1, 0x150),
    ['save:/nso-verify.lua'] = verifierSource})
  return dialogs[1] and dialogs[1].message:find('^invalid main on sd card')
    and dialogs[1].message:find('truncated', 1, true) ~= nil
end)())

check('valid uncompressed main -> verified + module name', (function()
  local dialogs = run({['sd:/'] = '', ['sd:/main'] = syntheticNso{name = 'main'},
    ['save:/nso-verify.lua'] = verifierSource})
  local message = dialogs[1] and dialogs[1].message or ''
  return message:find('^main verified: main') ~= nil
    and message:find('execution needs', 1, true) ~= nil
end)())

check('verifier rejects a zero-word text section', (function()
  local bad = syntheticNso{text = string.rep('\0', 0x100)}
  local ok, reason = verifier.verify(bad)
  return ok == false and reason:find('zero word') ~= nil
end)())

check('verifier rejects a memory collision', (function()
  local bad = syntheticNso()
  -- force rodata's memory offset (0x24) below the padded end of text
  bad = bad:sub(1, 0x24) .. u32(0) .. bad:sub(0x29)
  local ok, reason = verifier.verify(bad)
  return ok == false and reason:find('memory collision') ~= nil
end)())

check('verifier rejects unknown flag bits', (function()
  local ok, reason = verifier.verify(syntheticNso{flags = 0x1ff})
  return ok == false and reason:find('flag') ~= nil
end)())

-- Real files: the compressed path cannot be hash-verified in the sandbox, and the
-- verifier must say so rather than claim verification.
local fixture = os.getenv('NSO_FIXTURE') or
  (os.getenv('HOME') or '') .. '/SeedsowLullabyDemo-full/base/exefs/main'
local real = slurp(fixture)
if real then
  local ok, reason, info = verifier.verify(real)
  check('real NSO passes structure (module ' .. tostring(info and info.module) .. ')',
    ok == true, reason)
  check('real NSO reports contentsVerified = false', info and info.contentsVerified == false)
  check('real NSO is compressed, so its text was not inspected',
    info and info.text and info.text.compressed == true)
  check('launcher on a real NSO says contents were not hashed', (function()
    local dialogs = run({['sd:/'] = '', ['sd:/main'] = real,
      ['save:/nso-verify.lua'] = verifierSource})
    local message = dialogs[1] and dialogs[1].message or ''
    return message:find('contents not hashed', 1, true) ~= nil
  end)())
else
  print('skip  real-NSO cases (no fixture at ' .. fixture .. ')')
end

-- Console authoring wants short lines; report the longest so it does not regress.
local longest = 0
for line in (launcherSource .. verifierSource):gmatch('[^\n]+') do
  if #line > longest then longest = #line end
end
check('payload lines fit 80 columns (longest ' .. longest .. ')', longest <= 80)

print(string.format('\n%d passed, %d failed', passed, failed))
os.exit(failed == 0 and 0 or 1)
