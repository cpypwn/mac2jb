local file = assert(io.open(arg[1], "rb"))
local source = file:read("*a")
file:close()
local helper = assert(source:match("(local deep_stack, six_result.-)\nlocal rpc=0"))
local make = assert(loadstring("return function(N,O)\n" .. helper .. "\nreturn call6\nend"))()

local memory, frame, next_address = {}, nil, 0x10000
local N = {
  game_id = "seedsow", platform = "Ounce",
  run_chain = function(emit)
    local E = {cursor = 0x1000, words = {{0x1028, 0}, {0x1000, 0xabcd}}}
    function E:call_native(target, a0, a1, a2, a3, a4, result)
      assert(target == 0x2000 and a0 == 1 and a1 == 2 and a2 == 3 and
        a3 == 4 and a4 == 5)
      assert(result == 0x30000)
      self.cursor = 0x1090
    end
    emit(E)
    frame = E.words
    memory[0x30000] = 7
  end,
  new_emitter = function() end,
  alloc = function()
    local address = next_address
    next_address = next_address + 0x20000
    return address
  end,
  poke = function(address, value) memory[address] = value end,
  peek = function(address) return memory[address] end,
}
local O = {vcall8_restore = 0x3d9e54}
local call6 = make(N, O)
assert(call6(0x2000, 1, 2, 3, 4, 5, 6) == 7)
assert(frame[1][1] == 0x1028 and frame[1][2] == 6)
assert(frame[2][2] == 0xabcd)
O.vcall8_restore = 0
assert(not pcall(call6, 0x2000, 1, 2, 3, 4, 5, 6))
print("Seedsow v2 six-argument frame mock passed")
