-- Apply a project name and a 40x69 thumbnail to SmileBASIC's save metadata.
--
-- The measured file (docs/RESULTS.md, 2026-10-29): `save:/f/###/META` is exactly
-- 0x70 header + 40*69*4 bytes, the thumbnail is BGRA at 0x70, and the metadata is
-- written into the thumbnail's first pixels as an 8-byte tag `PCPM0005` followed by
-- a NUL-terminated UTF-16 name filling a 32-byte block. `[WORKSPACE]` is 11 chars
-- = 22 bytes + NUL, which is exactly the block, so 11 characters is the capacity
-- that has been observed. A longer name can be written (it eats more of the black
-- margin) but that has not been tried on a console, so it is opt-in.
--
-- Everything here is pure: bytes in, bytes out. The file I/O wrappers at the end
-- are thin so the logic is testable without a console.
local M = {}

M.path = 'save:/f/###/META'
M.tag = 'PCPM0005'
M.width, M.height = 40, 69
M.block = 32
M.capacity = M.block - #M.tag - 2          -- 22 bytes = 11 UTF-16 characters
M.header = 0x70
M.size = M.header + M.width * M.height * 4

-- 0-based offset of the tag, or nil.
function M.find(bytes)
  local at = bytes:find(M.tag, 1, true)
  if not at then return nil end
  return at - 1
end

-- Decoded (one byte per character) name and the byte offset of its first unit.
-- The console writes ASCII names as UTF-16LE, so the low byte is the character.
function M.nameAt(bytes)
  local tag = M.find(bytes)
  if not tag then return nil end
  local offset = tag + #M.tag
  local name = {}
  for i = offset + 1, #bytes - 1, 2 do
    local lo, hi = bytes:byte(i, i + 1)
    if lo == 0 and hi == 0 then return table.concat(name), offset end
    name[#name + 1] = string.char(lo)
  end
  return nil
end

-- Returns new bytes or nil, reason.
function M.setName(bytes, name, allowOverlap)
  if type(name) ~= 'string' or name == '' then return nil, 'name must be a string' end
  if name:find('%z') then return nil, 'name contains NUL' end
  local tag = M.find(bytes)
  if not tag then return nil, 'no ' .. M.tag .. ' tag' end
  local capacity = allowOverlap and M.block * 8 or M.capacity
  local encoded = {}
  for i = 1, #name do
    encoded[#encoded + 1] = string.char(name:byte(i), 0)
  end
  local raw = table.concat(encoded)
  if #raw > capacity then
    return nil, string.format('%d bytes > %d (%d characters)', #raw, capacity,
      math.floor(capacity / 2))
  end
  local offset = tag + #M.tag
  local padded = raw .. string.rep('\0', capacity + 2 - #raw)
  return bytes:sub(1, offset) .. padded .. bytes:sub(offset + #padded + 1)
end

-- raw must be exactly width*height*4 bytes of BGRA, the same layout the thumbnail
-- uses. The name block is inside the thumbnail, so it is re-applied afterwards.
function M.setIcon(bytes, raw, name, allowOverlap)
  if type(raw) ~= 'string' then return nil, 'icon must be a string' end
  local want = M.width * M.height * 4
  if #raw ~= want then return nil, 'icon must be ' .. want .. ' bytes, got ' .. #raw end
  local header = bytes:sub(1, M.header)
  local out = header .. raw
  if #out ~= M.size then return nil, 'META must be ' .. M.size .. ' bytes' end
  -- The tag lives in the icon's first pixels, so replacing the icon removes it;
  -- stamp it back before the name (which M.setName needs in order to find the slot).
  out = out:sub(1, M.header) .. M.tag .. out:sub(M.header + #M.tag + 1)
  if name then
    local ok, why = M.setName(out, name, allowOverlap)
    if not ok then return nil, why end
    return ok
  end
  return out
end

-- File wrappers. io.open on the save is the same call the boot stub uses.
local function readAll(path)
  local file = io.open(path, 'rb')
  if not file then return nil, 'cannot open ' .. path end
  local data
  pcall(function() data = file:read('*a') end)
  pcall(function() file:close() end)
  if type(data) ~= 'string' then return nil, 'cannot read ' .. path end
  return data
end

function M.apply(path, name, iconPath, allowOverlap)
  local bytes, why = readAll(path or M.path)
  if not bytes then return nil, why end
  if iconPath then
    local raw
    raw, why = readAll(iconPath)
    if not raw then return nil, why end
    local updated
    updated, why = M.setIcon(bytes, raw, name, allowOverlap)
    if not updated then return nil, why end
    bytes = updated
  elseif name then
    local updated
    updated, why = M.setName(bytes, name, allowOverlap)
    if not updated then return nil, why end
    bytes = updated
  end
  local file, openError = io.open(path or M.path, 'wb')
  if not file then return nil, openError or 'cannot write' end
  local wrote = pcall(function()
    file:write(bytes)
    file:flush()
    file:close()
  end)
  if not wrote then return nil, 'write failed' end
  return true
end

return M
