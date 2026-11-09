local M = {}
local font, font_size
local endpoint_font, endpoint_font_size
local shader, shader_tried
local sin, cos, abs = math.sin, math.cos, math.abs

local cube = {
    vertices = {
        {-1, -1, -1}, {1, -1, -1}, {1, 1, -1}, {-1, 1, -1},
        {-1, -1, 1}, {1, -1, 1}, {1, 1, 1}, {-1, 1, 1}
    },
    faces = {
        {1, 2, 3, 4}, {5, 6, 7, 8}, {1, 5, 8, 4},
        {2, 6, 7, 3}, {1, 2, 6, 5}, {4, 3, 7, 8}
    }
}
local prism = {
    vertices = {
        {-1, 0.8, -1}, {1, 0.8, -1}, {0, -1, -1},
        {-1, 0.8, 1}, {1, 0.8, 1}, {0, -1, 1}
    },
    faces = {
        {1, 2, 3}, {4, 5, 6}, {1, 4, 5, 2},
        {2, 5, 6, 3}, {3, 6, 4, 1}
    }
}
local colors = {
    {0.14, 0.98, 0.77}, {0.18, 0.70, 1.00},
    {0.70, 0.46, 1.00}, {1.00, 0.43, 0.61},
    {1.00, 0.76, 0.33}, {0.35, 0.89, 0.48}
}
local objects = {
    {cube, 0.19, 0.28, 0.125, 1, 0.0},
    {prism, 0.80, 0.28, 0.112, 3, 1.4},
    {prism, 0.20, 0.75, 0.103, 5, 2.6},
    {cube, 0.80, 0.75, 0.123, 2, 3.8},
    {cube, 0.50, 0.16, 0.058, 4, 5.1}
}

local function title_font(height)
    local size = math.max(38, math.floor(height * 0.105))
    if font and font_size == size then return font end
    local ok, face = pcall(love.graphics.newFont, "bl/assets/mono.ttf", size)
    if not ok then ok, face = pcall(love.graphics.newFont, size) end
    if ok then font, font_size = face, size end
    return font
end

local function address_font(height)
    local size = math.max(18, math.floor(height * 0.028))
    if endpoint_font and endpoint_font_size == size then return endpoint_font end
    local ok, face = pcall(love.graphics.newFont, "bl/assets/mono.ttf", size)
    if not ok then ok, face = pcall(love.graphics.newFont, size) end
    if ok then endpoint_font, endpoint_font_size = face, size end
    return endpoint_font
end

local function endpoint_lines()
    local app = package.loaded["bl.app"]
    if type(app) == "table" and app.state == "serving" and
       type(app.net) == "table" and type(app.net.ip) == "string" and
       app.net.ip:match("^%d+%.%d+%.%d+%.%d+$") then
        local ip = app.net.ip
        return ip, "RPC 9026  ·  FTP 5000  ·  PASV 5001"
    end
    if type(app) == "table" and app.state == "network-error" then
        return "Network unavailable", ""
    end
    return "Waiting for network", ""
end

local function draw_endpoints(g, w, h)
    local face = address_font(h)
    if not face then return end
    local address, ports = endpoint_lines()
    local lines = {address, ports}
    g.setFont(face)
    for i, line in ipairs(lines) do
        if line ~= "" then
            local x = (w - face:getWidth(line)) * 0.5
            local y = h * (0.83 + (i - 1) * 0.046)
            g.setColor(0, 0, 0, 0.85)
            g.print(line, x + 2, y + 2)
            g.setColor(0.78, 1.00, 0.91, 0.96)
            g.print(line, x, y)
        end
    end
end

local function face_shader(g, time)
    if not shader_tried then
        shader_tried = true
        local ok, effect = pcall(g.newShader, [[
            extern number uTime;
            vec4 effect(vec4 color, Image texture, vec2 uv, vec2 screen) {
                number glint = 0.84 + 0.16 * sin(screen.x * 0.025 + screen.y * 0.015 + uTime * 1.4);
                return vec4(color.rgb * glint, color.a);
            }
        ]])
        if ok then shader = effect end
    end
    if shader and pcall(shader.send, shader, "uTime", time) and
       pcall(g.setShader, shader) then return true end
    pcall(g.setShader)
    return false
end

local function transform(vertex, sx, cx, sy, cy, sz, cz)
    local x, y, z = vertex[1], vertex[2], vertex[3]
    x, z = x * cy + z * sy, z * cy - x * sy
    y, z = y * cx - z * sx, y * sx + z * cx
    x, y = x * cz - y * sz, x * sz + y * cz
    return {x, y, z}
end

local function draw_object(g, model, ox, oy, size, color_offset, time, phase)
    local ax, ay, az = time * 0.53 + phase, time * 0.39 + phase, time * 0.23
    local sx, cx, sy, cy, sz, cz = sin(ax), cos(ax), sin(ay), cos(ay), sin(az), cos(az)
    local vertices = {}
    for i, vertex in ipairs(model.vertices) do
        vertices[i] = transform(vertex, sx, cx, sy, cy, sz, cz)
    end
    local faces = {}
    for i, face in ipairs(model.faces) do
        local coords, depth = {}, 0
        for _, index in ipairs(face) do
            local v = vertices[index]
            local perspective = 3.3 / (4.3 + v[3])
            coords[#coords + 1] = ox + v[1] * size * perspective
            coords[#coords + 1] = oy + v[2] * size * perspective
            depth = depth + v[3]
        end
        local a, b, c = vertices[face[1]], vertices[face[2]], vertices[face[3]]
        local ux, uy, uz = b[1] - a[1], b[2] - a[2], b[3] - a[3]
        local vx, vy, vz = c[1] - a[1], c[2] - a[2], c[3] - a[3]
        local nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        local length = math.sqrt(nx * nx + ny * ny + nz * nz)
        local light = length > 0 and abs((nx * 0.38 - ny * 0.60 - nz * 0.70) / length) or 0
        faces[#faces + 1] = {coords, depth / #face, i, 0.42 + 0.50 * light}
    end
    table.sort(faces, function(a, b) return a[2] > b[2] end)
    for _, face in ipairs(faces) do
        local base = colors[(face[3] + color_offset - 2) % #colors + 1]
        local shade = face[4]
        g.setColor(base[1] * shade, base[2] * shade, base[3] * shade, 0.96)
        g.polygon("fill", face[1])
        g.setColor(0.84, 1.00, 0.96, 0.27)
        g.polygon("line", face[1])
    end
end

local function draw_rings(g, w, h, time, face)
    local cx, cy = w * 0.5, h * 0.5
    local max_radius = math.min(w, h) * 0.44
    local text_radius = face and face:getWidth("cpypwn") * 0.56 or max_radius * 0.36
    local min_radius = math.min(max_radius * 0.62, text_radius)
    local width = math.max(1.5, math.min(w, h) * 0.003)
    for i = 1, 5 do
        local progress = (time / 5.5 + (i - 1) / 5) % 1
        local fade = math.max(0, 1 - progress / 0.84)
        if fade > 0 then
            local radius = min_radius + (max_radius - min_radius) * progress
            local color = colors[(i + 1) % #colors + 1]
            local segments = math.max(48, math.floor(radius * 0.35))
            g.setColor(color[1], color[2], color[3], fade * 0.08)
            g.setLineWidth(width * 3.5)
            g.circle("line", cx, cy, radius, segments)
            g.setColor(color[1], color[2], color[3], fade * 0.55)
            g.setLineWidth(width)
            g.circle("line", cx, cy, radius, segments)
        end
    end
end

local function draw_glowing_title(g, face, w, h, time)
    local word = "cpypwn"
    local pulse = 1 + 0.06 * sin(time * 2.2)
    local glow = 0.78 + 0.22 * sin(time * 2.2)
    local x = w * 0.5 - face:getWidth(word) * pulse * 0.5
    local y = h * 0.5 - face:getHeight() * pulse * 0.5
    local layers = {{22, 0.018}, {14, 0.030}, {8, 0.048}, {3, 0.075}}

    g.setBlendMode("add")
    for _, layer in ipairs(layers) do
        g.setColor(0.14, 1.00, 0.73, layer[2] * glow)
        for step = 0, 15 do
            local angle = step * math.pi / 8
            g.print(word, x + cos(angle) * layer[1],
                y + sin(angle) * layer[1], 0, pulse, pulse)
        end
    end
    g.setColor(0.31, 1.00, 0.80, 0.24 * glow)
    g.print(word, x, y, 0, pulse, pulse)
    g.setBlendMode("alpha")
    g.setColor(0.95, 1.00, 0.98, 1)
    g.print(word, x, y, 0, pulse, pulse)
end

function M.draw()
    local g = love.graphics
    pcall(g.setCanvas)
    pcall(g.setShader)
    g.origin()
    g.setBlendMode("alpha")
    g.clear(0, 0, 0, 1)

    local w, h = g.getWidth(), g.getHeight()
    local time = love.timer.getTime()
    local size = math.min(w, h)
    local face = title_font(h)
    draw_rings(g, w, h, time, face)
    g.setLineWidth(math.max(1, size * 0.002))
    face_shader(g, time)
    for _, object in ipairs(objects) do
        local bob = sin(time * 0.8 + object[6]) * h * 0.018
        draw_object(g, object[1], w * object[2], h * object[3] + bob,
            size * object[4], object[5], time, object[6])
    end
    pcall(g.setShader)

    if face then
        g.setFont(face)
        draw_glowing_title(g, face, w, h, time)
    end
    draw_endpoints(g, w, h)
end

if type(BL) == "table" and type(BL.console) == "table" then
    if not rawget(_G, "__cpypwn_previous_draw") then
        rawset(_G, "__cpypwn_previous_draw", BL.console.draw)
    end
    BL.console.draw = M.draw
    return "cpypwn showcase active"
end

return M
