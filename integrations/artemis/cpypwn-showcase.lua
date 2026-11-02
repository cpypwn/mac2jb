local shades = {"0x8FFFD2", "0x62E9B5", "0xC4FFE8", "0x71D6B2"}
local patterns = {
    "< >     /\\     < >     \\/     < >",
    "  < >   /  \\   < >   /  \\   < >",
    "    < > /\\  /\\ < > /\\  /\\ < >",
    "  < >   \\/  /   < >   \\/  /   < >"
}
local active = 1
local frames = 0

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

e:tag{"lyc", color = "0xFF020B08", width = "1280", height = "720", id = "0"}
e:tag{"fontinit"}
for i = 1, #shades do
    draw("cpypwn_shape_" .. i, 206, 88, 34, shades[i], patterns[i])
    draw("cpypwn_name_" .. i, 292, 180, 112, shades[i], "cpypwn")
    if i ~= 1 then
        e:tag{"lyprop", id = "~cpypwn_shape_" .. i, visible = "0"}
        e:tag{"lyprop", id = "~cpypwn_name_" .. i, visible = "0"}
    end
end

function cpypwn_artemis_frame()
    frames = frames + 1
    if frames % 12 ~= 0 then
        return
    end
    e:tag{"lyprop", id = "~cpypwn_shape_" .. active, visible = "0"}
    e:tag{"lyprop", id = "~cpypwn_name_" .. active, visible = "0"}
    active = active % #shades + 1
    e:tag{"lyprop", id = "~cpypwn_shape_" .. active, visible = "1"}
    e:tag{"lyprop", id = "~cpypwn_name_" .. active, visible = "1"}
end

e:setEventHandler{onEnterFrame = "cpypwn_artemis_frame"}
