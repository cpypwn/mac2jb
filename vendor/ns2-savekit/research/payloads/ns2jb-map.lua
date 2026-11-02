-- ns2jb save-stage payload v3: environment map + pluto round trip + guarded fuzz.
--
-- Runs inside Seedsow Lullaby's Lua 5.1 state, entered from save data
-- (suspend slot 9999 -> save:/ns2jb.asb). The report is appended and flushed
-- line by line so a hang or crash still leaves the lines before it.
--
-- Crash guard: the "in progress" marker file is written before the fuzz block
-- and removed after it. If a boot finds the marker, the fuzz block is skipped,
-- so a memory-corruption crash cannot turn into a boot loop.

local function try(f, ...)
  if f == nil then return nil, 'nil' end
  local ok, a, b = pcall(f, ...)
  if ok then return a, b end
  return nil, tostring(a)
end

function ns2jb_boot(engine)
  local savepath = try(function() return engine:var('s.savepath') end)
  if type(savepath) ~= 'string' then savepath = 'save:' end
  local report = savepath .. '/ns2jb-report.txt'
  local marker = savepath .. '/ns2jb-busy.txt'
  local handle = io.open(report, 'wb')
  local function emit(line)
    if handle then
      pcall(function()
        handle:write(tostring(line) .. '\n')
        handle:flush()
      end)
    end
  end

  local busy = io.open(marker, 'rb')
  local wasBusy = busy ~= nil
  if busy then pcall(function() busy:close() end) end

  emit('ns2jb v3: environment map')
  emit('busy_marker_at_boot=' .. tostring(wasBusy))
  emit('lua=' .. tostring(_VERSION) .. ' savepath=' .. tostring(savepath))

  -- A. every global the engine left visible
  local G = _G or getfenv(0)
  local names, count = {}, 0
  for key in pairs(G) do
    count = count + 1
    if type(key) == 'string' then names[#names + 1] = key end
  end
  table.sort(names)
  emit(string.format('globals: %d total, %d named', count, #names))
  local listed = 0
  for i = 1, #names do
    if listed >= 600 then emit('  ... more globals omitted'); break end
    local name = names[i]
    local value = G[name]
    local kind = type(value)
    if kind == 'table' then
      local inner = 0
      for _ in pairs(value) do inner = inner + 1 end
      kind = 'table(' .. inner .. ')'
    end
    emit('  ' .. name .. '=' .. kind)
    listed = listed + 1
  end

  -- B. pluto: the same deserializer the engine uses for g.config and s.*
  local module = G.pluto
  emit('pluto=' .. tostring(module) .. ' type=' .. type(module))
  local blob
  if type(module) == 'table' then
    emit('pluto.persist=' .. type(module.persist) .. ' pluto.unpersist=' .. type(module.unpersist))
    local sample = {a = 1, b = 'two', c = {3, 4}, d = true}
    blob = try(function() return module.persist(sample) end)
    emit('persist(sample) type=' .. type(blob) .. ' len=' .. tostring(blob and #blob))
    local back, why = try(function() return module.unpersist({}, blob) end)
    emit('roundtrip=' .. type(back) .. ' a=' .. tostring(back and back.a)
      .. ' c1=' .. tostring(back and back.c and back.c[1]) .. ' why=' .. tostring(why))
    local truncated, terr = try(function() return module.unpersist({}, blob:sub(1, 12)) end)
    emit('unpersist(truncated)= ' .. type(truncated) .. ' err=' .. tostring(terr))
    local closure = try(function() return module.persist(function() return 1 end) end)
    emit('persist(function) type=' .. type(closure) .. ' len=' .. tostring(closure and #closure))
    local restored, cerr = try(function() return module.unpersist({}, closure) end)
    emit('unpersist(closure)= ' .. type(restored) .. ' err=' .. tostring(cerr))
  end

  -- C. engine handle surface: __index is a function, so probe by name
  local probe = {'var', 'tag', 'file', 'now', 'isFileExists', 'enqueueTag', 'setEventHandler',
                 'setEventFilter', 'isDown', 'getTouchCount', 'getMousePoint', 'sub', 'match',
                 'lower', 'upper', 'len', 'system', 'load', 'save', 'quit', 'exit',
                 'playMovie', 'stopMovie', 'setVar', 'getVar', 'writeFile', 'readFile',
                 'memcpy', 'memmove', 'getMemory', 'setMemory', 'alloc', 'log', 'print'}
  local found = {}
  for i = 1, #probe do
    local value = try(function() return engine[probe[i]] end)
    if value ~= nil then found[#found + 1] = probe[i] .. '=' .. type(value) end
  end
  emit('engine members: ' .. table.concat(found, ' '))

  -- D. guarded pluto fuzz: mutate a valid blob, catch Lua-level errors only.
  --    A native crash leaves the busy marker behind and disables this block.
  if blob and type(module) == 'table' and module.unpersist and not wasBusy then
    local mark = io.open(marker, 'wb')
    if mark then pcall(function() mark:write('fuzz\n'); mark:flush(); mark:close() end) end
    math.randomseed(os.time())
    local base = {}
    for i = 1, #blob do base[i] = blob:byte(i) end
    emit('fuzz start base_len=' .. #base)
    local okCount, errCount, skip = 0, 0, 0
    for round = 1, 400 do
      local bytes = {}
      for i = 1, #base do bytes[i] = base[i] end
      local kind = math.random(4)
      if kind == 1 then
        bytes[math.random(#bytes)] = math.random(255)
      elseif kind == 2 then
        table.remove(bytes, math.random(#bytes))
      elseif kind == 3 then
        table.insert(bytes, math.random(#bytes), math.random(255))
      else
        local cut = math.random(#bytes)
        local shorter = {}
        for i = 1, cut do shorter[i] = bytes[i] end
        bytes = shorter
      end
      local chars = {}
      for i = 1, #bytes do chars[i] = string.char(bytes[i]) end
      local text = table.concat(chars)
      emit(string.format('fuzz %d kind=%d len=%d', round, kind, #text))
      local result, err = try(function() return module.unpersist({}, text) end)
      if result ~= nil then okCount = okCount + 1 else errCount = errCount + 1 end
      if round % 50 == 0 then
        emit(string.format('fuzz progress %d ok=%d nil=%d last_err=%s', round, okCount, errCount,
          tostring(err):sub(1, 60)))
      end
    end
    emit(string.format('fuzz done ok=%d nil=%d', okCount, errCount))
    pcall(function() os.remove(marker) end)
  elseif wasBusy then
    emit('fuzz skipped: previous boot left the busy marker (a crash is likely)')
    pcall(function() os.remove(marker) end)
  end

  emit('done')
  if handle then pcall(function() handle:close() end) end
  pcall(function()
    engine:tag{'jump', file = 'system/first.iet', label = 'title'}
  end)
end
