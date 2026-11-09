local colors = {
    "0x6AF7C0", "0x71D8FF", "0xB899FF", "0xFF85C8",
    "0xFFD778", "0xFF9A80", "0xA5F0FF", "0x8EFFAD"
}
local frames = 8
local active = 1
local ticks = 0

local function draw(id, top, height, size, color, data)
    e:tag{"chgmsg", id = id, stack = "0"}
    e:tag{
        "font",
        anchorcenter = "0",
        face = "save:/proggy.ttf",
        left = "90",
        top = tostring(top),
        width = "1100",
        height = tostring(height),
        size = tostring(size),
        rubysize = "0",
        spacetop = "0",
        spacemiddle = "0",
        spacebottom = "0",
        color = color,
        shadowcolor = "0x000000",
        outlinecolor = "0x000000",
        shadow = "0",
        outline = "0",
        rubyshadow = "0",
        rubyoutline = "0",
        align = "center",
        style = "",
        hung = "1",
        stack = "0"
    }
    e:tag{"print", data = data}
    e:tag{"rt"}
end

local function round(value)
    return math.floor(value + 0.5)
end

local function make_cube(frame, direction)
    local grid = {}
    for row = 1, 9 do
        grid[row] = {}
        for col = 1, 25 do grid[row][col] = " " end
    end
    local angle = direction * frame * math.pi / 4
    local tilt = 0.42 + 0.11 * math.sin(angle)
    local points = {}
    for i = 0, 7 do
        local x = i % 2 == 0 and -1 or 1
        local y = math.floor(i / 2) % 2 == 0 and -1 or 1
        local z = math.floor(i / 4) == 0 and -1 or 1
        local xx = x * math.cos(angle) - z * math.sin(angle)
        local zz = x * math.sin(angle) + z * math.cos(angle)
        local yy = y * math.cos(tilt) - zz * math.sin(tilt)
        local depth = y * math.sin(tilt) + zz * math.cos(tilt)
        local scale = 21 / (depth + 4.5)
        points[i + 1] = {round(13 + xx * scale * 1.45), round(5 + yy * scale * 0.52)}
    end
    local function line(a, b)
        local x0, y0 = points[a][1], points[a][2]
        local x1, y1 = points[b][1], points[b][2]
        local dx, dy = math.abs(x1 - x0), math.abs(y1 - y0)
        local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
        local err = dx - dy
        while true do
            if x0 >= 1 and x0 <= 25 and y0 >= 1 and y0 <= 9 then
                grid[y0][x0] = dy > dx and "|" or dy == 0 and "-" or "/"
            end
            if x0 == x1 and y0 == y1 then break end
            local doubled = 2 * err
            if doubled > -dy then err = err - dy; x0 = x0 + sx end
            if doubled < dx then err = err + dx; y0 = y0 + sy end
        end
    end
    for _, edge in ipairs({
        {1, 2}, {1, 3}, {2, 4}, {3, 4},
        {5, 6}, {5, 7}, {6, 8}, {7, 8},
        {1, 5}, {2, 6}, {3, 7}, {4, 8}
    }) do line(edge[1], edge[2]) end
    for _, point in ipairs(points) do
        local x, y = point[1], point[2]
        if x >= 1 and x <= 25 and y >= 1 and y <= 9 then grid[y][x] = "+" end
    end
    local rows = {}
    for row = 1, 9 do rows[row] = table.concat(grid[row]) end
    return rows
end

e:tag{"lyc", color = "0xFF03030A", width = "1280", height = "720", id = "0"}
e:tag{"fontinit"}
for frame = 1, frames do
    local left = make_cube(frame, 1)
    local right = make_cube(frame, -1)
    for row = 1, 9 do
        local stars = row == (frame % 7 + 2) and " * " or "   "
        draw("full_cube_" .. frame .. "_" .. row, 152 + row * 38, 40, 25,
            colors[frame], left[row] .. stars .. right[row])
    end
    draw("full_glow_" .. frame, 282, 184, 115 + frame % 4 * 3,
        colors[frame], "cpypwn")
    draw("full_name_" .. frame, 300, 160, 106 + frame % 4 * 2,
        "0xF5FFF9", "cpypwn")
    if frame ~= 1 then
        for row = 1, 9 do
            e:tag{"lyprop", id = "~full_cube_" .. frame .. "_" .. row, visible = "0"}
        end
        e:tag{"lyprop", id = "~full_glow_" .. frame, visible = "0"}
        e:tag{"lyprop", id = "~full_name_" .. frame, visible = "0"}
    end
end

function cpypwn_artemis_frame()
    ticks = ticks + 1
    if ticks % 7 ~= 0 then return end
    for row = 1, 9 do
        e:tag{"lyprop", id = "~full_cube_" .. active .. "_" .. row, visible = "0"}
    end
    e:tag{"lyprop", id = "~full_glow_" .. active, visible = "0"}
    e:tag{"lyprop", id = "~full_name_" .. active, visible = "0"}
    active = active % frames + 1
    for row = 1, 9 do
        e:tag{"lyprop", id = "~full_cube_" .. active .. "_" .. row, visible = "1"}
    end
    e:tag{"lyprop", id = "~full_glow_" .. active, visible = "1"}
    e:tag{"lyprop", id = "~full_name_" .. active, visible = "1"}
end

e:setEventHandler{onEnterFrame = "cpypwn_artemis_frame"}
