-- ns2jb stub: the only file that has to be installed from a host.
-- It runs the first program it finds, in this order:
--   1. the file named by ssslot004.ref  (the editor's slot 4 -- Choose slot 4,
--      edit, Save + publish; no filename dialog, versions can live in slots)
--   2. ns2jb.lua                       (direct body written from a host)
-- Create ns2jb-off.txt to disable boot execution entirely.
function ns2jb_boot(engine)
  local base = 'save:'
  local ok, value = pcall(function() return engine:var('s.savepath') end)
  if ok and type(value) == 'string' then base = value end
  local function read(name)
    local file = io.open(base .. '/' .. name, 'rb')
    if not file then return nil end
    local data
    pcall(function() data = file:read('*a') end)
    pcall(function() file:close() end)
    return data
  end
  local function fail(message)
    pcall(function()
      engine:tag{'dialog', title = 'ns2jb stub', message = tostring(message)}
    end)
  end
  if read('ns2jb-off.txt') then return end

  local names = {}
  local ref = read('ssslot004.ref')
  if type(ref) == 'string' then
    local name = ref:match('^([^\r\n]+)')
    if name and name ~= '' then names[#names + 1] = name end
  end
  names[#names + 1] = 'ns2jb.lua'

  local tried = {}
  for i = 1, #names do
    local name = names[i]
    local source = read(name)
    if source then
      local chunk, err = loadstring(source, '@' .. base .. '/' .. name)
      if chunk then
        local ran, failure = pcall(chunk, engine)
        if not ran then fail(name .. ': ' .. tostring(failure)) end
        return
      end
      fail(name .. ' syntax: ' .. tostring(err))
      return
    end
    tried[#tried + 1] = name
  end
  fail('no program found: ' .. table.concat(tried, ', '))
end
