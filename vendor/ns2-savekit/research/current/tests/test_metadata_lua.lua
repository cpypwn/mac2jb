-- Offline tests for payloads/ns2jb-metadata.lua.
--
--   lua tests/test_metadata_lua.lua
--
-- The real META sample is used when it exists (saves/ is gitignored). These prove
-- the byte surgery keeps the file size and only touches the name block; they say
-- nothing about whether the console accepts the result.
local here = arg[0]:match('^(.*)/[^/]*$') or '.'
local root = here .. '/..'

local function slurp(path)
  local f = io.open(path, 'rb')
  if not f then return nil end
  local d = f:read('*a')
  f:close()
  return d
end

local source = assert(slurp(root .. '/payloads/ns2jb-metadata.lua'), 'metadata library')
local M = assert(load(source, '@ns2jb-metadata.lua'))()

local passed, failed = 0, 0
local function check(name, ok, detail)
  if ok then passed = passed + 1; print('ok    ' .. name)
  else failed = failed + 1; print('FAIL  ' .. name .. (detail and ('\n      ' .. tostring(detail)) or '')) end
end

local function synthetic()
  local bytes = {}
  bytes[#bytes + 1] = string.rep('\0', M.header)
  local icon = string.rep('\1', M.width * M.height * 4)
  bytes[#bytes + 1] = icon
  local blob = table.concat(bytes)
  -- stamp the tag and a name over the icon's first pixels, as the console does
  -- tag (8) + name (22 for 11 characters) + 2 pad = the measured 32-byte block
  blob = blob:sub(1, M.header) .. M.tag ..
    '[\0W\0O\0R\0K\0S\0P\0A\0C\0E\0]\0' .. '\0\0' .. blob:sub(M.header + 33)
  return blob
end

local sample = synthetic()
check('layout constants match the measured file', M.size == 11152 and M.capacity == 22 and
  M.width == 40 and M.height == 69)
check('tag is found', M.find(sample) == M.header)
check('the name is read back', M.nameAt(sample) == '[WORKSPACE]')

local renamed, why = M.setName(sample, 'HOMEBREW')
check('a short name is written', renamed ~= nil, why)
check('the size is unchanged', renamed and #renamed == #sample)
check('the new name reads back', renamed and M.nameAt(renamed) == 'HOMEBREW')
check('the thumbnail is untouched outside the block', renamed and
  renamed:sub(M.header + 33) == sample:sub(M.header + 33))

local tooLong, reason = M.setName(sample, 'HOMEBREWLAUNCHER')
check('12+ characters is refused', tooLong == nil and reason:find('22') ~= nil, reason)
local overlapped, why2 = M.setName(sample, 'HOMEBREWLAUNCHER', true)
check('--allow-overlap accepts a longer name', overlapped ~= nil and
  #overlapped == #sample and M.nameAt(overlapped) == 'HOMEBREWLAUNCHER', why2)

local icon = string.rep('\2', M.width * M.height * 4)
local withIcon, why3 = M.setIcon(sample, icon, 'HOMEBREW')
check('an icon is applied and the name re-stamped', withIcon ~= nil and
  M.nameAt(withIcon) == 'HOMEBREW' and #withIcon == M.size, why3)
-- The tag and name are re-stamped into the icon's first 32 bytes, so compare the
-- icon bytes after that block.
check('the icon bytes are what was passed', withIcon and
  withIcon:sub(M.header + 33, M.header + 48) == string.rep('\2', 16))
local shortIcon, why4 = M.setIcon(sample, string.rep('\2', 100))
check('a wrong-sized icon is refused', shortIcon == nil and why4:find('11040') ~= nil)

local real = slurp(root .. '/saves/all/SmileBASIC-4-demo/f/###/META')
if real then
  check('the real sample is 11152 bytes with name [WORKSPACE]',
    #real == 11152 and M.nameAt(real) == '[WORKSPACE]')
  local realRenamed = M.setName(real, 'HOMEBREW')
  check('renaming the real sample keeps the size', realRenamed and #realRenamed == #real)
  check('renaming the real sample only touches the block', realRenamed and
    realRenamed:sub(M.header + 33) == real:sub(M.header + 33))
else
  print('skip  real-sample cases (no saves/all/SmileBASIC-4-demo/f/###/META)')
end

print(string.format('\n%d passed, %d failed', passed, failed))
os.exit(failed == 0 and 0 or 1)
