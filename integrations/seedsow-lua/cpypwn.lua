local p = editor
local started = engine:now()
local floor = math.floor
local sin = math.sin
local cos = math.cos
local pi = math.pi
local colors = {
    '0xff59e1ff', '0xff98f5c5', '0xffffdc76',
    '0xffff78b2', '0xffb798ff', '0xff7d9cff'
}

local function outer(api, i, t, speed)
    local angle = (i - 1) * 2 * pi / 16 + t * speed
    local warp = 1 + 0.12 * sin(angle * 5 + t * 1.4)
    local x = 640 + 509 * warp * cos(angle)
    local y = 360 + 253 * warp * sin(angle)
    local size = i % 3 == 0 and 13 or 8
    api.rect('outer-' .. i, floor(x), floor(y), size, size, colors[(i - 1) % 6 + 1])
end

local function inner(api, i, t, speed)
    local angle = (i - 1) * 2 * pi / 8 - t * speed * 1.6
    local x = 640 + 353 * cos(angle) + 17 * sin(t * 2.2 + i)
    local y = 365 + 109 * sin(angle) + 11 * cos(t * 1.7 + i)
    api.rect('inner-' .. i, floor(x), floor(y), 10, 10, colors[(i + 2) % 6 + 1])
end

local function wave(api, i, t)
    local x = 310 + (i - 1) * 94 + 17 * sin(t * 2.3 + i * 0.63)
    local y = 442 + 21 * sin(t * 1.5 + i * 0.82)
    api.rect('wave-' .. i, floor(x), floor(y), 24, 5, colors[(i - 1) % 6 + 1])
end

p.screen('0xff000000')
p.label('cpypwn', 509, 315, 80, 'cpypwn')

for i = 1, 16 do outer(p, i, 0, 0.48) end
for i = 1, 8 do inner(p, i, 0, 0.48) end
for i = 1, 8 do wave(p, i, 0) end

local mode = 1
local aHeld = true
local lastDraw = -1000

return function(e, api)
    local pressed = false
    for _, key in ipairs({258, 13}) do
        local ok, value = pcall(function() return e:isDown(key) end)
        if ok and (value == true or value == 1) then pressed = true end
    end
    if pressed and not aHeld then mode = 3 - mode end
    aHeld = pressed

    local now = e:now() - started
    if now - lastDraw < 45 then return end
    lastDraw = now
    local t = now / 1000
    local speed = mode == 1 and 0.48 or -0.85

    for i = 1, 16 do outer(api, i, t, speed) end
    for i = 1, 8 do inner(api, i, t, speed) end
    for i = 1, 8 do wave(api, i, t) end

end
