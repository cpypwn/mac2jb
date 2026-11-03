-- ns2jb save-stage payload v2: capability probe.
--
-- Runs inside Seedsow Lullaby's own Lua 5.1 state, entered from save data:
-- the engine resumes suspend slot 9999, whose script pointer says
-- save:/ns2jb.asb. Everything below is pcall-wrapped and the report is
-- flushed line by line, so a hang still leaves the lines before it.

local function try(f, ...)
  if f == nil then return nil, 'nil' end
  local ok, a, b = pcall(f, ...)
  if ok then return a, b end
  return nil, tostring(a)
end

function ns2jb_boot(engine)
  local savepath = try(function() return engine:var('s.savepath') end)
  local datapath = try(function() return engine:var('s.datapath') end)
  if type(savepath) ~= 'string' then savepath = 'save:' end
  local path = savepath .. '/ns2jb-report.txt'
  local handle = io.open(path, 'wb')
  local function emit(line)
    if handle then
      pcall(function()
        handle:write(tostring(line) .. '\n')
        handle:flush()
      end)
    end
  end

  emit('ns2jb v2: Lua from save data is running')
  emit('lua=' .. tostring(_VERSION))
  emit('savepath=' .. tostring(savepath) .. ' datapath=' .. tostring(datapath))
  emit('os.time=' .. tostring(try(os.time)))
  emit('package.path=' .. tostring(try(function() return package.path end)))
  emit('package.cpath=' .. tostring(try(function() return package.cpath end)))
  emit('os.getenv(PATH)=' .. tostring(try(function() return os.getenv('PATH') end)))
  emit('os.getenv(HOME)=' .. tostring(try(function() return os.getenv('HOME') end)))

  -- Can this Lua see the game's own romfs, the SD card, or absolute paths?
  local probes = {'game:/system/init.lua', 'game:/', 'save:/ns2jb.asb', 'save:/',
                  'sd:/', '/', 'save:/../saveg.dat'}
  for i = 1, #probes do
    local name = probes[i]
    local file, why = io.open(name, 'rb')
    if file then
      local head = try(function() return file:read(32) end)
      pcall(function() file:close() end)
      emit(string.format('open %s -> ok head=%q', name, tostring(head)))
    else
      emit(string.format('open %s -> %s', name, tostring(why)))
    end
  end

  -- Can it list a directory?
  local names = try(function()
    local out = {}
    for entry in io.lines(path) do out[#out + 1] = entry end
    return 'lines ok ' .. #out
  end)
  emit('io.lines(report)=' .. tostring(names))

  -- Process execution. Expected to be absent on a console, but the engine
  -- links a full Lua 5.1 io/os, so measure rather than assume.
  local code, cerr = try(function() return os.execute('true') end)
  emit('os.execute(true) code=' .. tostring(code) .. ' err=' .. tostring(cerr))
  local code2 = try(function() return os.execute('echo ns2jb') end)
  emit('os.execute(echo)=' .. tostring(code2))
  local pipe, perr = try(function() return io.popen('id') end)
  emit('io.popen=' .. tostring(pipe) .. ' err=' .. tostring(perr))
  if pipe then
    local text = try(function() return pipe:read('*a') end)
    pcall(function() pipe:close() end)
    emit('io.popen(id) out=' .. tostring(text))
  end

  emit('done')
  if handle then pcall(function() handle:close() end) end

  pcall(function()
    engine:tag{'dialog', title = 'ns2jb', message =
      'Lua from save data is running.\n\n' ..
      'save: ' .. tostring(savepath) .. '\n' ..
      'game: ' .. tostring(datapath) .. '\n' ..
      'os.execute: ' .. type(os.execute) .. '\n' ..
      'io.popen: ' .. type(io.popen) .. '\n' ..
      'report: ns2jb-report.txt'}
  end)
  -- Leave the game in a usable place instead of a blank scene.
  pcall(function()
    engine:tag{'jump', file = 'system/first.iet', label = 'title'}
  end)
end
