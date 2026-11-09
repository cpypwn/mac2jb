local colors = {
    "0xFF58C7", "0x75E6FF", "0xFFD166", "0x9F80FF",
    "0x65F5AF", "0xFF8C69", "0x6CE9F2", "0xF47AC7"
}
local pulses = {104, 108, 112, 116, 120, 116, 112, 108}
local rays = {
    {"/\\  *  \\/   /\\  *  \\/", "<  /\\  >  <  /\\  >", "<  \\/  >  <  \\/  >", "\\/  *  /\\   \\/  *  /\\"},
    {"  /\\  *  \\/  /\\  *  \\/", "< /  \\ >  < /  \\ >", "< \\  / >  < \\  / >", "  \\/  *  /\\  \\/  *  /\\"},
    {"*  /\\  \\/  *  /\\  \\/  *", "<< /\\ >>    << /\\ >>", "<< \\/ >>    << \\/ >>", "*  \\/  /\\  *  \\/  /\\  *"},
    {"/\\ * /\\   \\/ * \\/   /\\ * /\\", "< /\\ >      < /\\ >", "< \\/ >      < \\/ >", "\\/ * \\/   /\\ * /\\   \\/ * \\/"},
    {"/\\  *  \\/   /\\  *  \\/", "<  /\\  >  <  /\\  >", "<  \\/  >  <  \\/  >", "\\/  *  /\\   \\/  *  /\\"},
    {"  /\\  *  \\/  /\\  *  \\/", "< /  \\ >  < /  \\ >", "< \\  / >  < \\  / >", "  \\/  *  /\\  \\/  *  /\\"},
    {"*  /\\  \\/  *  /\\  \\/  *", "<< /\\ >>    << /\\ >>", "<< \\/ >>    << \\/ >>", "*  \\/  /\\  *  \\/  /\\  *"},
    {"/\\ * /\\   \\/ * \\/   /\\ * /\\", "< /\\ >      < /\\ >", "< \\/ >      < \\/ >", "\\/ * \\/   /\\ * /\\   \\/ * \\/"}
}
local active = 1
local frames = 0
local parts = {"outer_top", "inner_top", "inner_bottom", "outer_bottom", "glow", "name"}

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

e:tag{"lyc", color = "0xFF02030B", width = "1280", height = "720", id = "0"}
e:tag{"fontinit"}
for i = 1, #colors do
    draw("kaleido_outer_top_" .. i, 95, 82, 34, colors[i], rays[i][1])
    draw("kaleido_inner_top_" .. i, 195, 70, 42, colors[i], rays[i][2])
    draw("kaleido_inner_bottom_" .. i, 480, 70, 42, colors[i], rays[i][3])
    draw("kaleido_outer_bottom_" .. i, 558, 56, 34, colors[i], rays[i][4])
    draw("kaleido_glow_" .. i, 286, 180, pulses[i] + 12, colors[i], "cpypwn")
    draw("kaleido_name_" .. i, 300, 156, pulses[i], "0xF8FFFE", "cpypwn")
    if i ~= 1 then
        for _, part in ipairs(parts) do
            e:tag{"lyprop", id = "~kaleido_" .. part .. "_" .. i, visible = "0"}
        end
    end
end

function cpypwn_artemis_frame()
    frames = frames + 1
    if frames % 7 ~= 0 then
        return
    end
    for _, part in ipairs(parts) do
        e:tag{"lyprop", id = "~kaleido_" .. part .. "_" .. active, visible = "0"}
    end
    active = active % #colors + 1
    for _, part in ipairs(parts) do
        e:tag{"lyprop", id = "~kaleido_" .. part .. "_" .. active, visible = "1"}
    end
end

e:setEventHandler{onEnterFrame = "cpypwn_artemis_frame"}
