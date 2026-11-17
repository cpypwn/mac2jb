local app = LS
if type(app) ~= "table" then
    return "GC_PROBE_V1\tmissing-runtime"
end

local info = app.nx_info
local net = app.net
local fields = {
    "GC_PROBE_V1",
    tostring(app.game_id or ""),
    tostring(app.game_name or ""),
    tostring(app.state or ""),
    tostring(jit and jit.os or ""),
    tostring(info and info.profile or ""),
    tostring(net and net.ip or ""),
    tostring(app.fs_bridge and app.fs_bridge.stage or "absent"),
}
return table.concat(fields, "\t")
