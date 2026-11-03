-- ns2jb save-stage payload: prove that Lua written into the save data runs.
--
-- The engine executes this when a save slot's execution pointer is retargeted
-- at save:/ns2jb.asb (artemis-save.py launch). Command 1 of that ASB defines
-- this chunk, command 2 calls ns2jb_boot(engine), command 3 waits, 4 stops.
--
-- Everything is pcall-wrapped: a failure here must not take the game down
-- before it has written its report.

local function try(f, ...)
  if f == nil then return nil, 'nil' end
  local ok, value = pcall(f, ...)
  if ok then return value end
  return nil, tostring(value)
end

function ns2jb_boot(engine)
  local lines = {}
  local function add(key, value)
    lines[#lines + 1] = tostring(key) .. '=' .. tostring(value)
  end

  add('ns2jb', 'Lua from save data is running')
  add('lua', _VERSION)
  local G = _G or getfenv(0)
  local names = {
    'io', 'os', 'debug', 'package', 'string', 'table', 'math', 'coroutine', 'bit32',
    'loadstring', 'load', 'loadfile', 'dofile', 'require', 'newproxy', 'setfenv',
    'getfenv', 'collectgarbage', 'print', 'unpack', 'pcall', 'xpcall', 'error',
    'assert', 'next', 'pairs', 'ipairs', 'rawget', 'rawset', 'rawequal',
    'setmetatable', 'getmetatable', 'tostring', 'tonumber',
  }
  for i = 1, #names do add(names[i], type(G[names[i]])) end
  add('os.execute', type(os and os.execute))
  add('os.getenv', type(os and os.getenv))
  add('os.remove', type(os and os.remove))
  add('os.rename', type(os and os.rename))
  add('os.exit', type(os and os.exit))
  add('os.time', type(os and os.time))
  add('io.popen', type(io and io.popen))
  add('io.lines', type(io and io.lines))
  add('io.write', type(io and io.write))
  add('debug.getinfo', type(debug and debug.getinfo))
  add('debug.setmetatable', type(debug and debug.setmetatable))
  add('debug.sethook', type(debug and debug.sethook))
  add('package.loadlib', type(package and package.loadlib))
  add('string.dump', type(string.dump))
  add('string.pack', type(string.pack))

  local savepath = try(function() return engine:var('s.savepath') end)
  add('s.savepath', savepath)
  local datapath = try(function() return engine:var('s.datapath') end)
  add('s.datapath', datapath)
  local version = try(function() return engine:var('s.version') end)
  add('s.version', version)

  local mt = try(getmetatable, engine)
  add('engine.metatable', tostring(mt))
  add('engine.type', type(engine))
  if type(mt) == 'table' then
    local index, why = try(function() return mt.__index end)
    add('engine.mt.__index', tostring(index) .. ' ' .. tostring(why or ''))
    local methodNames = try(function()
      local out = {}
      local source = type(index) == 'table' and index or mt
      for key in pairs(source) do out[#out + 1] = tostring(key) end
      table.sort(out)
      return table.concat(out, ' ')
    end)
    add('engine.methods', methodNames)
  end

  local report = table.concat(lines, '\n') .. '\n'
  local written = 'no usable savepath'
  if type(savepath) == 'string' then
    local path = savepath .. '/ns2jb-report.txt'
    local file, why = io.open(path, 'wb')
    if file then
      local ok, err = pcall(function()
        assert(file:write(report))
        assert(file:flush())
        assert(file:close())
      end)
      written = ok and ('wrote ' .. path .. ' (' .. #report .. ' bytes)') or ('write failed: ' .. tostring(err))
      pcall(function() file:close() end)
    else
      written = 'open failed: ' .. tostring(why)
    end
  end
  add('report', written)

  local message = table.concat(lines, '\n')
  if #message > 1500 then message = message:sub(1, 1500) .. '\n...' end
  pcall(function()
    engine:tag{'dialog', title = 'ns2jb', message = message}
  end)
end
