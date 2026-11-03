-- ns2jb body, loaded at boot.
-- Keep lines <=32 chars: the
-- dialog returns 32 max.
local passed = ...
local engine = passed
if type(passed) == 'table' then
  if passed.engine then
    engine = passed.engine
  end
end
local e = engine
local base = 'save:'
local v = nil
pcall(function()
  v = e:var('s.savepath')
end)
if type(v) == 'string' then
  base = v
end
local game = '?'
pcall(function()
  game = e:var('s.datapath')
end)
local lines = {}
local body = ''
local function add(t)
  t = tostring(t)
  lines[#lines+1] = t
  body = body .. t .. '\n'
end
add('ns2jb body')
add('lua ' .. _VERSION)
add('save ' .. base)
add('game ' .. tostring(game))
add('t ' .. tostring(os.time()))
local card = '?'
local sp = 'sd:/ns2jb.txt'
pcall(function()
  local h = io.open('sd:/','rb')
  if h then h:close() end
  card = h and 'open' or 'no'
end)
add('sd ' .. card)
pcall(function()
  local h = io.open(sp,'wb')
  if not h then return end
  h:write('ns2jb sd probe\n')
  h:flush()
  h:close()
  card = card .. '+w'
end)
add('sdw ' .. card)
local function probe()
  return 1
end
local function tryload(x)
  local f, e = loadstring(x)
  return tostring(e or type(f))
end
local d = string.dump(probe)
local gc = collectgarbage
local kb = gc('count')
local function tl(a, b)
  return tryload(d:sub(a, b))
end
add('dlen ' .. #d)
add('gck ' .. tostring(kb))
add('load ' .. tryload(d))
add('b1 ' .. tl(1, 10))
add('b2 ' .. tl(1, 30))
add('b3 ' .. tl(1, #d - 8))
local GSCRIPT = 'system/init.lua'
local dp = '/init-dump.lua'
local ip = base..dp
local txt = nil
pcall(function()
  txt = e:file(GSCRIPT)
end)
add('init ' .. type(txt))
if type(txt) == 'string' then
  local f3 = io.open(ip,'wb')
  if f3 then
    f3:write(txt)
    f3:close()
  end
end
local p = '/ns2jb-report.txt'
local f = io.open(base..p,'wb')
if f then
  pcall(function()
    f:write(body)
    f:flush()
    f:close()
  end)
end
pcall(function()
  e:tag{'jump',
    file='system/first.iet',
    label='title'}
end)
pcall(function()
  e:tag{'dialog',
    title='ns2jb',
    message=body}
end)
