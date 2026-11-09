local log = require("gc.log")
local M = { visible = true, font = nil, font_size = 0 }

M.clock = nil

local C = {
    bg     = {0.06, 0.07, 0.10, 0.97},
    bar    = {0.09, 0.10, 0.15, 1},
    border = {0.90, 0.65, 0.15, 1},
    accent = {0.95, 0.72, 0.20, 1},
    green  = {0.30, 0.85, 0.50, 1},
    cyan   = {0.40, 0.78, 0.92, 1},
    pale   = {0.88, 0.88, 0.92, 1},
    dim    = {0.52, 0.54, 0.62, 1},
    stamp  = {0.40, 0.42, 0.50, 1},
    error  = {0.95, 0.35, 0.35, 1},
    foot   = {0.07, 0.08, 0.12, 1},
}

local function color(g, c) g.setColor(c[1], c[2], c[3], c[4]) end

local function font(height)
    local size = math.max(14, math.min(48, math.floor(height / 47)))
    if M.font and M.font_size == size then return M.font end
    local face = log.try("newFont", love.graphics.newFont, size)
    if not face then return nil end
    M.font, M.font_size = face, size
    return face
end

local function event_color(line)
    if line:find("[ERROR]", 1, true) or line:find("FATAL", 1, true) then return C.error end
    if line:find("[BOOT]", 1, true) or line:find("[IMG]", 1, true) then return C.pale end
    if line:find("[RPC]", 1, true) then return C.accent end
    if line:find("[FTP]", 1, true) then return C.cyan end
    if line:find("[NET]", 1, true) or line:find("ready", 1, true) then return C.green end
    if line:find("[NX]", 1, true) then return C.cyan end
    return C.dim
end

local function split_timestamp(line)
    local stamp, rest = line:match("^(%d%d:%d%d:%d%d%.%d%d%d)  (.*)$")
    if stamp then return stamp, rest end
    return nil, line
end

function M.draw(status)
    local g = love.graphics
    pcall(g.setCanvas)
    pcall(g.setShader)
    pcall(g.origin)
    pcall(g.setBlendMode, "alpha")
    local w, h = g.getWidth(), g.getHeight()
    local f = font(h)
    if f then g.setFont(f) end
    local glyph_h = f and f:getHeight() or M.font_size
    local step = glyph_h + 5
    local margin = math.max(14, math.floor(w * 0.014))
    local width = w - 2 * margin
    local bar = step + 16

    color(g, C.bg); g.rectangle("fill", 0, 0, w, h)

    color(g, C.bar); g.rectangle("fill", 0, 0, w, bar)
    color(g, C.border); g.rectangle("fill", 0, bar - 3, w, 3)

    local title = "GravCirc-RCE"
    local state = tostring(status or "")
    local clock = M.clock and M.clock() or ""

    local bar_y = math.floor((bar - 3 - glyph_h) / 2)

    color(g, C.accent); g.print(title, margin, bar_y)

    local title_w = f and f:getWidth(title) or 0
    local sep = "  |  "
    local sep_x = margin + title_w
    color(g, C.stamp); g.print(sep, sep_x, bar_y)
    local sep_w = f and f:getWidth(sep) or 0
    color(g, C.green); g.print(state, sep_x + sep_w, bar_y)

    color(g, C.stamp); g.print(clock, margin + width - (f and f:getWidth(clock) or 0), bar_y)

    local credit = log.CREDIT or ""
    local footer = 0
    if #credit > 0 then
        footer = step + 6
        local top = h - footer
        color(g, C.foot); g.rectangle("fill", 0, top, w, footer)
        color(g, C.border)
        g.rectangle("fill", 0, top, w, 1)
        color(g, C.dim)
        g.print(credit, margin + width - (f and f:getWidth(credit) or 0),
            top + 1 + math.floor((footer - 1 - glyph_h) / 2))
    end

    local y = bar + 10
    local floor_y = h - (footer > 0 and footer or margin)
    local capacity = math.max(0, math.floor((floor_y - y) / step))

    local stamp_w = f and f:getWidth("00:00:00.000") or 0
    local msg_x = margin + stamp_w + (f and f:getWidth("  ") or 8)

    local rows = {}
    for i = #log.lines, 1, -1 do
        local line = log.lines[i]
        local stamp, rest = split_timestamp(line)
        rows[#rows + 1] = { stamp = stamp, text = rest or line, tint = event_color(line) }
        if #rows >= capacity then break end
    end

    for i = math.min(#rows, capacity), 1, -1 do
        local row = rows[i]
        if row.stamp then
            color(g, C.stamp)
            g.print(row.stamp, margin, y)
            color(g, row.tint)
            g.print(row.text, msg_x, y)
        else
            color(g, row.tint)
            g.print(row.text, margin, y)
        end
        y = y + step
    end
end

return M
