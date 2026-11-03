-- ns2jb launcher v1: the save-side half of the homebrew launcher.
--
-- Runs inside the shipping game from a save file (the suspend slot retarget),
-- with the engine handle the boot stub passes in. What it does, in order:
--
--   1. resolve save:/ and game:
--   2. look for `main` at the SD card root
--   3. if it is absent  -> dialog "missing main on sd card"
--      if it is present -> verify it as an NSO0 (payloads/nso-verify.lua)
--         invalid -> dialog "invalid main on sd card" + the reason
--         valid   -> dialog "main verified" + sizes, then attempt execution
--   4. write a report to save:/ns2jb-launch.txt either way
--
-- What it does NOT do, and says so on screen: execute `main`. Execution needs a
-- native loader with FS privileges, and nothing measured so far gives the Lua
-- sandbox that (docs/RESULTS.md: io exists, io.popen does not, sd:/ is refused,
-- no native code path has been proven). The escalating step lives in the BASIC
-- bootstrap and needs a host to drive it. A dialog that claimed otherwise would
-- be a lie, so the launcher reports the truth and points at the log.
--
-- Lua 5.1 compatible; keep appending to `lines` for the report.
local engine = ...
if type(engine) ~= 'table' and type(engine) ~= 'userdata' then
  return
end

local lines = {}
local function add(text)
  lines[#lines + 1] = tostring(text)
end

local function var(name)
  local ok, value = pcall(function() return engine:var(name) end)
  if ok and type(value) == 'string' then return value end
  return nil
end

local base = var('s.savepath') or 'save:'
local game = var('s.datapath') or '?'
add('ns2jb launcher v1')
add('lua ' .. _VERSION)
add('save ' .. base)
add('game ' .. game)

-- Provenance, before anything that can fail: append to a file that an
-- earlier payload already created. A pull can then tell "never ran" from
-- "ran but could not create its own report", which the 21:37 boot could not.
do
  local ok, file = pcall(io.open, base .. '/ns2jb-report.txt', 'ab')
  if ok and file then
    local stamp = 0
    pcall(function() stamp = os.time() end)
    pcall(function()
      file:write('ns2jb launcher ran ' .. tostring(stamp) .. '\n')
      file:flush()
      file:close()
    end)
    add('provenance appended to ' .. base .. '/ns2jb-report.txt')
  else
    add('provenance write failed for ' .. base .. '/ns2jb-report.txt')
  end
end

local function readFile(path)
  local file = io.open(path, 'rb')
  if not file then return nil end
  local data
  pcall(function() data = file:read('*a') end)
  pcall(function() file:close() end)
  return data
end

local function exists(path)
  local file = io.open(path, 'rb')
  if not file then return false end
  pcall(function() file:close() end)
  return true
end

local function dialog(title, message)
  pcall(function()
    engine:tag{'dialog', title = tostring(title), message = tostring(message)}
  end)
end

local function report()
  local file = io.open(base .. '/ns2jb-launch.txt', 'wb')
  if not file then return end
  pcall(function()
    file:write(table.concat(lines, '\n') .. '\n')
    file:flush()
    file:close()
  end)
end

-- The verifier is small enough to keep beside the body. If it is missing the
-- launcher must still run and say so rather than silently accept a file.
local verifier
do
  local source = readFile(base .. '/nso-verify.lua')
  if source then
    local chunk = loadstring(source, '@nso-verify.lua')
    if chunk then
      local ok, module = pcall(chunk)
      if ok and type(module) == 'table' then verifier = module end
    end
  end
end
add('verifier ' .. tostring(verifier ~= nil))

local sdRoot = exists('sd:/')
add('sd root ' .. tostring(sdRoot))
local mainPath = 'sd:/main'
local data = readFile(mainPath)
add('main ' .. (data and (#data .. ' bytes') or 'absent'))

if not data then
  -- Two different worlds produce this: no SD filesystem at all, or a card with
  -- no `main`. The dialog uses the required wording and the log says which.
  local why = sdRoot and 'file not found'
    or 'sd: not available in this sandbox'
  add('why ' .. why)
  report()
  dialog('ns2jb', 'missing main on sd card\n(' .. why .. ')')
  return
end

if not verifier then
  add('why verifier missing')
  report()
  dialog('ns2jb', 'invalid main on sd card\n(nso-verify.lua missing)')
  return
end

local ok, reason, info = verifier.verify(data)
if not ok then
  add('invalid ' .. tostring(reason))
  report()
  dialog('ns2jb', 'invalid main on sd card\n' .. tostring(reason))
  return
end

add('module ' .. tostring(info.module))
add('text ' .. info.text.size .. ' B (' .. info.text.fileSize .. ' on disk)')
add('rodata ' .. info.rodata.size .. ' B')
add('data ' .. info.data.size .. ' B')
add('bss ' .. tostring(info.bss))
add('contents hashed no')
add('exec not implemented')
report()

-- Execution needs a privileged native loader, and this sandbox has no measured
-- path to one, so the honest outcome is a verified file and no pretending.
dialog('ns2jb', 'main verified: ' .. tostring(info.module) ..
  '\n' .. info.bytes .. ' bytes\ncontents not hashed (no LZ4 here)' ..
  '\nexecution needs FS privileges - not done')
